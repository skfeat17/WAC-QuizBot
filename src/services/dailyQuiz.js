const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    StringSelectMenuBuilder,
    MessageFlags,
} = require("discord.js");

const { generateDailyQuiz } = require("./dailyQuizAI");

const {
    hasUserCooldown,
    setUserCooldown,
    clearAllUserCooldowns,
    saveEvent,
    updateEvent,
    getEvent,
    getActiveEventId,
    acquireActiveEvent,
    releaseActiveEvent,
} = require("./dailyQuizRedis");

const PAYMENT_STAFF = [
    "1295671787375296542",
];

const WINNERS_REQUIRED = 5;
const PRIZE_AMOUNT = 10;

let activeDailyQuiz = null;

// ==========================================
// START DAILY EVENT
// ==========================================

async function startDailyQuiz(interaction) {
    const type = interaction.options.getString("type");

    if (!type) {
        await interaction.reply({
            content: "❌ Please select a Daily Event type.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (activeDailyQuiz) {
        await interaction.reply({
            content: "⚠️ A Daily Event is already running!",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    let existingEventId;
    try {
        existingEventId = await getActiveEventId();
    } catch (error) {
        console.error("❌ Failed to check active Daily Event:", error.message);
        await interaction.reply({
            content: "⚠️ I couldn't check whether another Daily Event is running.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (existingEventId) {
        await interaction.reply({
            content: "⚠️ A Daily Event is already running! Use `/kill dailyevent` to terminate it.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const eventId = interaction.id;
    let lockAcquired = false;

    try {
        lockAcquired = await acquireActiveEvent(eventId);
    } catch (error) {
        console.error("❌ Failed to acquire Daily Event lock:", error.message);
        await interaction.reply({
            content: "⚠️ I couldn't start the Daily Event right now.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (!lockAcquired) {
        await interaction.reply({
            content: "⚠️ A Daily Event is already running!",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();

    try {
        const quiz = await generateDailyQuiz(type);

        if (!quiz || !Array.isArray(quiz.countries) || quiz.countries.length !== 5) {
            throw new Error("Invalid Daily Event generated.");
        }

        activeDailyQuiz = {
            eventId,
            hostId: interaction.user.id,
            type,
            countries: quiz.countries.map((country, index) => ({
                id: index,
                country: country.country,
                flag: country.flag,
                prompt: country.prompt,
                answers: country.answers,
                correctAnswer: country.correctAnswer,
                attempts: new Set(),
                solved: false,
                winner: null,
                resolving: false,
            })),
            winners: [],
            channel: interaction.channel,
            channelId: interaction.channelId,
            message: null,
            messageId: null,
            startedAt: Date.now(),
            status: "open",
        };

        const message = await interaction.editReply({
            embeds: [buildMainEmbed()],
            components: buildAnswerButton(),
        });

        activeDailyQuiz.message = message;
        activeDailyQuiz.messageId = message.id;

        await saveEvent(eventId, serializeActiveQuiz());

        console.log(`✅ Daily Event started: ${eventId} (${type})`);
    } catch (error) {
        console.error("❌ Daily Event generation failed:", error);
        activeDailyQuiz = null;

        try {
            await releaseActiveEvent(eventId);
        } catch (releaseError) {
            console.error("❌ Failed to release Daily Event lock:", releaseError.message);
        }

        await interaction.editReply({
            content: "❌ I couldn't generate the Daily Event. Please try again.",
            embeds: [],
            components: [],
        });
    }
}

// ==========================================
// MAIN EMBED
// ==========================================

function buildMainEmbed() {
    const quiz = activeDailyQuiz;
    const eventName = getTypeName(quiz.type);

    const countries = quiz.countries.map((item, index) => {
        if (item.solved) {
            return `${index + 1}. ~~${item.flag} ${item.country}~~ — ✅ **Done**`;
        }

        return `${index + 1}. ${item.flag} **${item.country}**`;
    }).join("\n");

    return new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("🌍 DAILY EVENT DROPS")
        .setDescription(
            `### ${eventName}\n\n` +
            `Choose a country and answer **its question**.\n\n` +
            countries
        )
        .addFields(
            {
                name: "💰 Prize",
                value: `**${PRIZE_AMOUNT} Mora** each`,
                inline: true,
            },
        )
        .setFooter({
            text: "First correct answer for each country wins • One attempt per person",
        });
}

// ==========================================
// SELECT COUNTRY BUTTON
// ==========================================

function buildAnswerButton() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("dailyquiz_answer")
                .setLabel("🌍 Select Country")
                .setStyle(ButtonStyle.Secondary)
        ),
    ];
}

// ==========================================
// COUNTRY SELECT
// ==========================================

async function handleDailyQuizButton(interaction) {
    if (interaction.customId !== "dailyquiz_answer") return;

    try {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        console.error("❌ Failed to acknowledge Daily Event button:", error.message);
        return;
    }

    if (!(await ensureActiveQuiz(interaction))) return;

    try {
        if (await hasUserCooldown(activeDailyQuiz.type, interaction.user.id)) {
            await interaction.editReply({
                content:
                    `⏳ You have already participated in today's **${getTypeName(activeDailyQuiz.type)}** event.\n\n` +
                    `You can participate again after your 24-hour cooldown expires.`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
    } catch (error) {
        console.error("❌ Daily Event cooldown check failed:", error.message);
        await interaction.editReply({
            content: "⚠️ I couldn't check your participation status right now.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const availableCountries = activeDailyQuiz.countries.filter(
        country => !country.solved && !country.attempts.has(interaction.user.id)
    );

    if (!availableCountries.length) {
        await interaction.editReply({
            content: "❌ You have no available countries left to answer.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const menu = new StringSelectMenuBuilder()
        .setCustomId("dailyquiz_country")
        .setPlaceholder("Select a country")
        .addOptions(
            availableCountries.map(country => ({
                label: country.country.slice(0, 100),
                value: String(country.id),
                description: `${getTypeName(activeDailyQuiz.type)} question`.slice(0, 100),
                emoji: country.flag || "🌍",
            }))
        );

    await interaction.editReply({
        content: "🌍 **Choose one country to answer:**",
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
    });
}

// ==========================================
// COUNTRY SELECT HANDLER
// ==========================================

async function handleDailyQuizCountrySelect(interaction) {
    if (interaction.customId !== "dailyquiz_country") return;

    try {
        await interaction.deferUpdate();
    } catch (error) {
        console.error("❌ Failed to acknowledge country selection:", error.message);
        return;
    }

    if (!(await ensureActiveQuiz(interaction))) return;

    try {
        if (await hasUserCooldown(activeDailyQuiz.type, interaction.user.id)) {
            await interaction.editReply({
                content: `⏳ You have already participated in today's **${getTypeName(activeDailyQuiz.type)}** event.`,
                components: [],
            });
            return;
        }
    } catch (error) {
        console.error("❌ Daily Event cooldown check failed:", error.message);
        await interaction.editReply({
            content: "⚠️ I couldn't check your participation status right now.",
            components: [],
        });
        return;
    }

    const selectedId = interaction.values?.[0];
    const country = activeDailyQuiz.countries.find(
        item => String(item.id) === String(selectedId)
    );

    if (!country || country.solved) {
        await interaction.editReply({
            content: "❌ That country is no longer available.",
            components: [],
        });
        return;
    }

    if (country.attempts.has(interaction.user.id)) {
        await interaction.editReply({
            content: `⚠️ You already attempted **${country.country}**.`,
            components: [],
        });
        return;
    }

    const answerButtons = country.answers.map((answer, index) =>
        new ButtonBuilder()
            .setCustomId(`dailyquiz_option_${activeDailyQuiz.eventId}_${country.id}_${index}`)
            .setLabel(answer.slice(0, 80))
            .setStyle(ButtonStyle.Primary)
    );

    const rows = [
        new ActionRowBuilder().addComponents(answerButtons[0], answerButtons[1]),
        new ActionRowBuilder().addComponents(answerButtons[2], answerButtons[3]),
    ];

    await interaction.editReply({
        content: null,
        embeds: [buildQuestionEmbed(country)],
        components: rows,
    });
}

function buildQuestionEmbed(country) {
    return new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("🌍 DAILY EVENT DROPS")
        .setDescription(
            `### EVENT NAME : ${getTypeName(activeDailyQuiz.type)}\n\n` +
            `**${country.flag} ${country.country}**\n\n` +
            `${country.prompt}\n\n` +
            `🏆 First correct answer wins **${PRIZE_AMOUNT} Mora**.`
        )
        .setFooter({
            text: "Choose one answer • One attempt only",
        });
}

// ==========================================
// MCQ ANSWER HANDLER
// ==========================================

async function handleDailyQuizAnswer(interaction) {
    if (!interaction.customId.startsWith("dailyquiz_option_")) return;

    try {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        console.error("❌ Failed to acknowledge answer interaction:", error.message);
        return;
    }

    if (!(await ensureActiveQuiz(interaction))) return;

    const parts = interaction.customId.split("_");
    const eventId = parts[2];
    const countryId = parts[3];
    const selectedAnswer = Number(parts[4]);

    if (eventId !== activeDailyQuiz.eventId) {
        await interaction.editReply({
            content: "❌ This Daily Event has ended or been replaced.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const country = activeDailyQuiz.countries.find(
        item => String(item.id) === String(countryId)
    );

    if (!country) {
        await interaction.editReply({
            content: "❌ This country is no longer available.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (country.solved || country.resolving) {
        await interaction.editReply({
            content: "❌ Someone has already solved this country.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (country.attempts.has(interaction.user.id)) {
        await interaction.editReply({
            content: `⚠️ You already attempted **${country.country}**.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    try {
        if (await hasUserCooldown(activeDailyQuiz.type, interaction.user.id)) {
            await interaction.editReply({
                content: `⏳ You have already participated in today's **${getTypeName(activeDailyQuiz.type)}** event.`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
    } catch (error) {
        console.error("❌ Cooldown check failed:", error.message);
        await interaction.editReply({
            content: "⚠️ I couldn't verify your participation status.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (!Number.isInteger(selectedAnswer) || selectedAnswer < 0 || selectedAnswer > 3) {
        await interaction.editReply({
            content: "❌ Invalid answer.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // Reserve this country immediately to prevent two simultaneous winners.
    country.resolving = true;
    country.attempts.add(interaction.user.id);

    const correct = selectedAnswer === country.correctAnswer;

    try {
        await setUserCooldown(activeDailyQuiz.type, interaction.user.id);
    } catch (error) {
        country.resolving = false;
        country.attempts.delete(interaction.user.id);
        console.error("❌ Failed to save participation cooldown:", error.message);

        await interaction.editReply({
            content: "⚠️ I couldn't save your participation status. Your answer was not counted.",
        });
        return;
    }

    if (!correct) {
        country.resolving = false;

        const correctAnswer = country.answers[country.correctAnswer];
        console.log(
            `❌ WRONG ANSWER | User: ${interaction.user.username} | ` +
            `Display: ${interaction.member?.displayName || interaction.user.globalName || interaction.user.username} | ` +
            `Event: ${getTypeName(activeDailyQuiz.type)} | ` +
            `Country: ${country.country} | ` +
            `Answer: ${country.answers[selectedAnswer]} | ` +
            `Correct: ${correctAnswer}`
        );

        await persistActiveDailyQuiz();

        await interaction.editReply({
            content:
                `❌ **Wrong answer!**\n\n` +
                `${country.flag} **${country.country}**\n` +
                `✅ Correct answer: **${correctAnswer}**\n\n` +
                `Your attempt for this event is used.`,
        });
        return;
    }

    country.solved = true;
    country.resolving = false;

    const winner = {
        id: interaction.user.id,
        username: interaction.user.username,
        country: country.country,
        flag: country.flag,
        answer: country.answers[selectedAnswer],
        position: activeDailyQuiz.winners.length + 1,
    };

    country.winner = winner;
    activeDailyQuiz.winners.push(winner);

    await persistActiveDailyQuiz();

    await persistActiveDailyQuiz();

    // ==========================================
    // CORRECT ANSWER — PRIVATE USER RESPONSE
    // ==========================================

    await interaction.editReply({
        content:
            `✅ **Correct!**`
    });

    // ==========================================
    // PAYMENT NOTIFICATION — PUBLIC FOLLOW-UP
    // ==========================================

    try {
        try {
            await interaction.followUp({
                content:
                    `💰 **DAILY EVENT WINNER **\n\n` +
                    `👤 USER : <@${winner.id}>\n` +
                    `🎯 EVENT : **${getTypeName(activeDailyQuiz.type)}**\n` +
                    `🌍 COUNTRY : ${winner.flag} **${winner.country}**\n` +
                    `✅ ANSWER : **${winner.answer}**\n` +
                    `💵 REWARD : **${PRIZE_AMOUNT} Mora**\n\n` +
                    `${PAYMENT_STAFF.map(id => `<@${id}>`).join(" ")} ` +
                    `please process the payment to "${winner.username}".`,
                allowedMentions: {
                    users: [...new Set(PAYMENT_STAFF)],
                },
            });

            console.log(
                `💰 Payment notification sent for ${winner.username} — ` +
                `${getTypeName(activeDailyQuiz.type)} — ${winner.answer}`
            );

        } catch (error) {
            console.error(
                "❌ Payment notification failed:",
                error.message
            );
        }

        console.log(
            `💰 Payment notification sent for ${winner.username}`
        );

    } catch (error) {

        console.error(
            "❌ Payment notification failed:",
            error.message
        );
    }
    await updateDailyQuizMessage();

    if (activeDailyQuiz && activeDailyQuiz.winners.length >= WINNERS_REQUIRED) {
        await finishDailyQuiz();
    }
}

// ==========================================
// RESTORE
// ==========================================

async function ensureActiveQuiz(interaction) {
    if (activeDailyQuiz) return true;

    const restored = await restoreActiveDailyQuiz(interaction);
    if (restored) return true;

    const response = {
        content: "❌ This Daily Event has ended.",
    };

    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(response);
        } else {
            await interaction.reply({
                ...response,
                flags: MessageFlags.Ephemeral,
            });
        }
    } catch (error) {
        console.error("❌ Failed to respond to inactive Daily Event:", error.message);
    }

    return false;
}

async function restoreActiveDailyQuiz(interaction) {
    if (activeDailyQuiz) return true;

    try {
        const eventId = await getActiveEventId();
        if (!eventId) return false;

        const savedEvent = await getEvent(eventId);
        if (
            !savedEvent ||
            !["open", "active"].includes(savedEvent.status)
        ) {
            return false;
        }

        let channel = interaction.channel;
        if (savedEvent.channelId && interaction.client) {
            try {
                channel = await interaction.client.channels.fetch(savedEvent.channelId) || channel;
            } catch (error) {
                console.error("⚠️ Could not recover Daily Event channel:", error.message);
            }
        }

        activeDailyQuiz = {
            eventId: savedEvent.eventId,
            hostId: savedEvent.hostId,
            type: savedEvent.type,
            countries: savedEvent.countries.map(country => ({
                ...country,
                attempts: new Set(country.attempts || []),
                resolving: false,
            })),
            winners: savedEvent.winners || [],
            channelId: savedEvent.channelId,
            messageId: savedEvent.messageId,
            channel,
            message: null,
            startedAt: savedEvent.startedAt,
            status: "open",
        };

        if (channel && savedEvent.messageId && typeof channel.messages?.fetch === "function") {
            try {
                activeDailyQuiz.message = await channel.messages.fetch(savedEvent.messageId);
            } catch (error) {
                console.error("⚠️ Could not recover Daily Event message:", error.message);
            }
        }

        console.log(`♻️ Restored Daily Event from Redis: ${eventId}`);
        return true;
    } catch (error) {
        console.error("❌ Failed to restore Daily Event:", error.message);
        return false;
    }
}

// ==========================================
// PERSISTENCE
// ==========================================

function serializeActiveQuiz() {
    return {
        eventId: activeDailyQuiz.eventId,
        hostId: activeDailyQuiz.hostId,
        channelId: activeDailyQuiz.channel?.id || activeDailyQuiz.channelId || null,
        messageId: activeDailyQuiz.message?.id || activeDailyQuiz.messageId || null,
        type: activeDailyQuiz.type,
        status: activeDailyQuiz.status || "open",
        startedAt: activeDailyQuiz.startedAt,
        countries: activeDailyQuiz.countries.map(country => ({
            id: country.id,
            country: country.country,
            flag: country.flag,
            prompt: country.prompt,
            answers: country.answers,
            correctAnswer: country.correctAnswer,
            attempts: Array.from(country.attempts || []),
            solved: Boolean(country.solved),
            winner: country.winner || null,
        })),
        winners: activeDailyQuiz.winners.map(winner => ({ ...winner })),
    };
}

async function persistActiveDailyQuiz() {
    if (!activeDailyQuiz) return;
    await updateEvent(activeDailyQuiz.eventId, serializeActiveQuiz());
}

async function updateDailyQuizMessage() {
    if (!activeDailyQuiz?.message) return;

    try {
        await activeDailyQuiz.message.edit({
            embeds: [buildMainEmbed()],
            components: buildAnswerButton(),
        });
    } catch (error) {
        console.error("❌ Failed to update Daily Event:", error.message);
    }
}


// ==========================================
// FINISH
// ==========================================

async function finishDailyQuiz() {
    if (!activeDailyQuiz) return;

    const quiz = activeDailyQuiz;
    quiz.status = "closed";
    activeDailyQuiz = null;

    try {
        await releaseActiveEvent(quiz.eventId);
    } catch (error) {
        console.error("❌ Failed to release Daily Event lock:", error.message);
    }

    try {
        await updateEvent(quiz.eventId, {
            ...serializeQuizForCompletion(quiz),
            status: "closed",
            completedAt: Date.now(),
        });
    } catch (error) {
        console.error("❌ Failed to save completed Daily Event:", error.message);
    }

    if (quiz.message) {
        try {
            await quiz.message.edit({
                embeds: [buildFinishedEmbed(quiz)],
                components: [],
            });
        } catch (error) {
            console.error("❌ Failed to finish Daily Event message:", error.message);
        }
    }
}

function serializeQuizForCompletion(quiz) {
    return {
        eventId: quiz.eventId,
        hostId: quiz.hostId,
        channelId: quiz.channel?.id || quiz.channelId || null,
        messageId: quiz.message?.id || quiz.messageId || null,
        type: quiz.type,
        status: quiz.status || "closed",
        countries: quiz.countries.map(country => ({
            id: country.id,
            country: country.country,
            flag: country.flag,
            prompt: country.prompt,
            answers: country.answers,
            correctAnswer: country.correctAnswer,
            attempts: Array.from(country.attempts || []),
            solved: Boolean(country.solved),
            winner: country.winner || null,
        })),
        winners: quiz.winners.map(winner => ({ ...winner })),
    };
}

function buildFinishedEmbed(quiz) {
    const winners = quiz.winners.length
        ? quiz.winners.map(winner => `🏆 #${winner.position} <@${winner.id}> — ${winner.flag} ${winner.country}`).join("\n")
        : "No winners.";

    return new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle("🌍 DAILY EVENT DROPS")
        .setDescription(
            `### EVENT NAME : ${getTypeName(quiz.type)}\n\n` +
            `**STATUS : 🔴 CLOSED**\n\n` +
            `🎉 **Daily Event completed!**\n\n` +
            winners
        )
        .addFields({
            name: "💰 Prize",
            value: `**${PRIZE_AMOUNT} Mora** per winner`,
        })
        .setFooter({ text: "World Adventure Club" });
}

// ==========================================
// KILL
// ==========================================

async function killDailyQuiz() {
    const redisEventId = await getActiveEventId();
    const quiz = activeDailyQuiz;

    if (!quiz && !redisEventId) return false;

    if (quiz) quiz.status = "terminated";
    activeDailyQuiz = null;
    const eventId = quiz?.eventId || redisEventId;

    if (eventId) {
        try {
            await releaseActiveEvent(eventId);
        } catch (error) {
            console.error("❌ Failed to release terminated Daily Event lock:", error.message);
        }

        try {
            const existingEvent = await getEvent(eventId);
            await updateEvent(eventId, {
                ...(existingEvent || {}),
                eventId,
                status: "terminated",
                terminatedAt: Date.now(),
            });
        } catch (error) {
            console.error("❌ Failed to save terminated Daily Event:", error.message);
        }
    }

    if (quiz?.message) {
        try {
            await quiz.message.edit({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xED4245)
                        .setTitle("🌍 DAILY EVENT DROPS")
                        .setDescription(
                            `### EVENT NAME : ${getTypeName(quiz.type)}\n\n` +
                            `**STATUS : 🛑 TERMINATED**\n\n` +
                            "🛑 **Daily Event terminated.**"
                        ),
                ],
                components: [],
            });
        } catch (error) {
            console.error("❌ Failed to edit terminated Daily Event:", error.message);
        }
    }

    return true;
}

async function killDailyQuizHistory() {
    try {
        const deleted = await clearAllUserCooldowns();
        console.log(`🧹 Cleared ${deleted} Daily Event participation cooldown(s).`);
        return deleted;
    } catch (error) {
        console.error("❌ Failed to clear Daily Event history:", error.message);
        return false;
    }
}


function getTypeName(type) {
    const names = {
        capital: "🏛️ GUESS THE CAPITAL",
        food: "🍜 GUESS THE FAMOUS FOOD",
        monument: "🏰 GUESS THE FAMOUS MONUMENT",
        president: "👤 GUESS THE PRESIDENT",
        independence: "🎉 GUESS THE INDEPENDENCE DAY",
    };

    return names[type] || "🌍 DAILY EVENT";
}

module.exports = {
    startDailyQuiz,
    handleDailyQuizButton,
    handleDailyQuizCountrySelect,
    handleDailyQuizAnswer,
    killDailyQuiz,
    killDailyQuizHistory,
};
