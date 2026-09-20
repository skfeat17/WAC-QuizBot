const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    MessageFlags,
} = require("discord.js");

const {
    generateDailyQuiz,
    judgeDailyQuizAnswer,
} = require("./dailyQuizAI");

const {
    hasUserCooldown,
    setUserCooldown,
    redisDeleteUserCooldown,
    clearAllUserCooldowns,
    saveEvent,
    updateEvent,
    getEvent,
    getActiveEventId,
    acquireActiveEvent,
    releaseActiveEvent,
} = require("./dailyQuizRedis");

// ==========================================
// SETTINGS
// ==========================================

const PAYMENT_STAFF = [
    "1295671787375296542",
];

const WINNERS_REQUIRED = 5;
const PRIZE_AMOUNT = 20;

let activeDailyQuiz = null;


// ==========================================
// START DAILY QUIZ
// ==========================================

async function startDailyQuiz(interaction) {

    const type = interaction.options.getString("type");

    if (!type) {
        await interaction.reply({
            content: "❌ Please select a Daily Quiz type.",
            flags: MessageFlags.Ephemeral,
        });

        return;
    }

    // Local memory check
    if (activeDailyQuiz) {
        await interaction.reply({
            content: "⚠️ A Daily Quiz is already running!",
            flags: MessageFlags.Ephemeral,
        });

        return;
    }

    // Redis active event check
    let existingEventId;

    try {
        existingEventId = await getActiveEventId();
    } catch (error) {
        console.error(
            "❌ Failed to check active Daily Quiz:",
            error
        );

        await interaction.reply({
            content:
                "⚠️ I couldn't check whether another Daily Quiz is running.",
            flags: MessageFlags.Ephemeral,
        });

        return;
    }

    if (existingEventId) {
        await interaction.reply({
            content:
                "⚠️ A Daily Quiz is already running! An authorized user can use `/kill dailyquiz` to terminate it.",
            flags: MessageFlags.Ephemeral,
        });

        return;
    }

    const eventId = interaction.id;

    let lockAcquired = false;

    try {
        lockAcquired = await acquireActiveEvent(eventId);
    } catch (error) {
        console.error(
            "❌ Failed to acquire Daily Quiz lock:",
            error
        );

        await interaction.reply({
            content:
                "⚠️ I couldn't start the Daily Quiz right now. Please try again.",
            flags: MessageFlags.Ephemeral,
        });

        return;
    }

    if (!lockAcquired) {
        await interaction.reply({
            content:
                "⚠️ A Daily Quiz is already running! An authorized user can use `/kill dailyquiz` to terminate it.",
            flags: MessageFlags.Ephemeral,
        });

        return;
    }

    await interaction.deferReply();

    try {

        const quiz = await generateDailyQuiz(type);

        if (
            !quiz ||
            !Array.isArray(quiz.countries) ||
            quiz.countries.length !== 5
        ) {
            throw new Error(
                "Invalid Daily Quiz generated."
            );
        }

        activeDailyQuiz = {
            eventId,
            hostId: interaction.user.id,
            type,

            countries: quiz.countries.map(
                (country, index) => ({
                    id: index,

                    country: country.country,

                    flag: country.flag,

                    prompt: country.prompt,

                    answers:
                        country.answers || [],

                    scrambled:
                        country.scrambled || null,

                    attempts: new Set(),

                    solved: false,

                    winner: null,
                })
            ),

            winners: [],

            channel: interaction.channel,

            channelId: interaction.channelId,

            message: null,

            messageId: null,

            startedAt: Date.now(),
        };

        const message =
            await interaction.editReply({
                content: buildQuizMessage(),
                components: buildAnswerButton(),
            });

        activeDailyQuiz.message = message;
        activeDailyQuiz.messageId = message.id;

        // Save FULL quiz to Redis
        await saveEvent(eventId, {
            eventId,

            hostId: interaction.user.id,

            channelId: interaction.channelId,

            messageId: message.id,

            type,

            status: "active",

            startedAt:
                activeDailyQuiz.startedAt,

            countries:
                activeDailyQuiz.countries.map(
                    (country) => ({
                        id: country.id,
                        country: country.country,
                        flag: country.flag,
                        prompt: country.prompt,
                        answers:
                            country.answers || [],
                        scrambled:
                            country.scrambled || null,
                        attempts: [],
                        solved: false,
                        winner: null,
                    })
                ),

            winners: [],
        });

        console.log(
            `✅ Daily Quiz started: ${eventId}`
        );

    } catch (error) {

        console.error(
            "❌ Daily Quiz generation failed:",
            error
        );

        activeDailyQuiz = null;

        try {
            await releaseActiveEvent(eventId);
        } catch (releaseError) {
            console.error(
                "❌ Failed to release Daily Quiz lock:",
                releaseError
            );
        }

        await interaction.editReply({
            content:
                "❌ I couldn't generate the Daily Quiz. Please try again.",
            components: [],
        });
    }
}


// ==========================================
// MAIN MESSAGE
// ==========================================

function buildQuizMessage() {

    if (!activeDailyQuiz) {
        return "❌ No Daily Quiz is currently running.";
    }

    const typeName =
        getTypeName(activeDailyQuiz.type);

    const countryList =
        activeDailyQuiz.countries
            .map((item, index) => {

                if (item.solved) {
                    return (
                        `${index + 1}. ` +
                        `~~${item.flag} ${item.country}~~ ` +
                        `— ✅ **Done**`
                    );
                }

                return (
                    `${index + 1}. ` +
                    `${item.flag} **${item.country}**`
                );
            })
            .join("\n");

    return (
        `# 🧠 DAILY QUIZ — ${typeName}\n\n` +

        `Select a country and type your answer. ` +
        `You get **one attempt per country**.\n\n` +

        `${countryList}\n\n` +

        `🏆 **First ${WINNERS_REQUIRED} different ` +
        `correct answers win ${PRIZE_AMOUNT} Mora each.**`
    );
}


// ==========================================
// PERSIST ACTIVE QUIZ
// ==========================================

async function persistActiveDailyQuiz() {

    if (!activeDailyQuiz) {
        return;
    }

    const data = {
        eventId:
            activeDailyQuiz.eventId,

        hostId:
            activeDailyQuiz.hostId,

        channelId:
            activeDailyQuiz.channel?.id ||
            activeDailyQuiz.channelId ||
            null,

        messageId:
            activeDailyQuiz.message?.id ||
            activeDailyQuiz.messageId ||
            null,

        type:
            activeDailyQuiz.type,

        status: "active",

        startedAt:
            activeDailyQuiz.startedAt,

        countries:
            activeDailyQuiz.countries.map(
                (country) => ({
                    id: country.id,

                    country: country.country,

                    flag: country.flag,

                    prompt: country.prompt,

                    answers:
                        country.answers || [],

                    scrambled:
                        country.scrambled || null,

                    attempts:
                        Array.from(
                            country.attempts || []
                        ),

                    solved:
                        Boolean(country.solved),

                    winner:
                        country.winner || null,
                })
            ),

        winners:
            activeDailyQuiz.winners.map(
                (winner) => ({
                    id: winner.id,
                    username: winner.username,
                    country: winner.country,
                    flag: winner.flag,
                    answer: winner.answer,
                    position: winner.position,
                })
            ),
    };

    await updateEvent(
        activeDailyQuiz.eventId,
        data
    );
}


// ==========================================
// RESTORE DAILY QUIZ FROM REDIS
// ==========================================

async function restoreActiveDailyQuiz(
    interaction
) {

    // Already in memory
    if (activeDailyQuiz) {
        return true;
    }

    try {

        const eventId =
            await getActiveEventId();

        if (!eventId) {
            return false;
        }

        const savedEvent =
            await getEvent(eventId);

        if (
            !savedEvent ||
            savedEvent.status !== "active" ||
            !Array.isArray(
                savedEvent.countries
            )
        ) {
            return false;
        }

        let channel =
            interaction.channel;

        // Try to recover original channel
        if (
            savedEvent.channelId &&
            interaction.client
        ) {
            try {
                const fetchedChannel =
                    await interaction.client.channels.fetch(
                        savedEvent.channelId
                    );

                if (fetchedChannel) {
                    channel =
                        fetchedChannel;
                }
            } catch (error) {
                console.error(
                    "⚠️ Could not recover Daily Quiz channel:",
                    error.message
                );
            }
        }

        activeDailyQuiz = {
            eventId:
                savedEvent.eventId,

            hostId:
                savedEvent.hostId,

            type:
                savedEvent.type,

            countries:
                savedEvent.countries.map(
                    (country) => ({
                        id: country.id,

                        country:
                            country.country,

                        flag:
                            country.flag,

                        prompt:
                            country.prompt,

                        answers:
                            country.answers || [],

                        scrambled:
                            country.scrambled ||
                            null,

                        attempts:
                            new Set(
                                country.attempts || []
                            ),

                        solved:
                            Boolean(
                                country.solved
                            ),

                        winner:
                            country.winner ||
                            null,
                    })
                ),

            winners:
                savedEvent.winners || [],

            channelId:
                savedEvent.channelId,

            messageId:
                savedEvent.messageId,

            channel,

            message: null,

            startedAt:
                savedEvent.startedAt,
        };

        // Recover original Discord message
        if (
            channel &&
            savedEvent.messageId &&
            typeof channel.messages?.fetch ===
                "function"
        ) {
            try {

                activeDailyQuiz.message =
                    await channel.messages.fetch(
                        savedEvent.messageId
                    );

            } catch (error) {

                console.error(
                    "⚠️ Could not recover Daily Quiz message:",
                    error.message
                );
            }
        }

        console.log(
            `♻️ Restored Daily Quiz from Redis: ${eventId}`
        );

        return true;

    } catch (error) {

        console.error(
            "❌ Failed to restore Daily Quiz:",
            error
        );

        return false;
    }
}


// ==========================================
// SINGLE GREY BUTTON
// ==========================================

function buildAnswerButton() {

    const button =
        new ButtonBuilder()
            .setCustomId(
                "dailyquiz_answer"
            )
            .setLabel(
                "Tap Here to Answer"
            )
            .setStyle(
                ButtonStyle.Secondary
            );

    return [
        new ActionRowBuilder()
            .addComponents(button),
    ];
}


// ==========================================
// BUTTON HANDLER
// ==========================================

async function handleDailyQuizButton(
    interaction
) {

    if (
        interaction.customId !==
        "dailyquiz_answer"
    ) {
        return;
    }

    // Restore if bot restarted
    if (!activeDailyQuiz) {

        const restored =
            await restoreActiveDailyQuiz(
                interaction
            );

        if (!restored) {

            await interaction.reply({
                content:
                    "❌ This Daily Quiz has ended.",
                flags:
                    MessageFlags.Ephemeral,
            });

            return;
        }
    }

    // ==========================================
    // 24-HOUR TYPE COOLDOWN
    // ==========================================

    try {

        const alreadyParticipated =
            await hasUserCooldown(
                activeDailyQuiz.type,
                interaction.user.id
            );

        if (alreadyParticipated) {

            await interaction.reply({
                content:
                    `⏳ You have already participated in today's **${getTypeName(activeDailyQuiz.type)}** Daily Quiz.\n\n` +
                    `You can participate again after your 24-hour cooldown expires.`,
                flags:
                    MessageFlags.Ephemeral,
            });

            return;
        }

    } catch (error) {

        console.error(
            "❌ Daily Quiz cooldown check failed:",
            error.message
        );

        await interaction.reply({
            content:
                "⚠️ I couldn't check your participation status right now. Please try again.",
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }

    // ==========================================
    // COUNTRY DROPDOWN
    // ==========================================

    const availableCountries =
        activeDailyQuiz.countries.filter(
            (country) =>
                !country.solved &&
                !country.attempts.has(
                    interaction.user.id
                )
        );

    if (
        availableCountries.length === 0
    ) {

        await interaction.reply({
            content:
                "❌ You have no available countries left to answer.",
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }

    const menu =
        new StringSelectMenuBuilder()
            .setCustomId(
                "dailyquiz_country"
            )
            .setPlaceholder(
                "Select a country to answer"
            )
            .addOptions(
                availableCountries.map(
                    (country) => ({
                        label:
                            country.country
                                .slice(0, 100),

                        value:
                            String(country.id),

                        description:
                            `${getTypeName(activeDailyQuiz.type)} question`
                                .slice(0, 100),

                        emoji:
                            country.flag ||
                            "🌍",
                    })
                )
            );

    const row =
        new ActionRowBuilder()
            .addComponents(menu);

    await interaction.reply({
        content:
            "🌍 **Choose the country you want to answer:**",

        components: [row],

        flags:
            MessageFlags.Ephemeral,
    });
}


// ==========================================
// COUNTRY DROPDOWN HANDLER
// ==========================================

async function handleDailyQuizCountrySelect(
    interaction
) {

    if (
        interaction.customId !==
        "dailyquiz_country"
    ) {
        return;
    }

    // Restore if bot restarted
    if (!activeDailyQuiz) {

        const restored =
            await restoreActiveDailyQuiz(
                interaction
            );

        if (!restored) {

            await interaction.update({
                content:
                    "❌ This Daily Quiz has ended.",
                components: [],
            });

            return;
        }
    }

    try {

        const alreadyParticipated =
            await hasUserCooldown(
                activeDailyQuiz.type,
                interaction.user.id
            );

        if (alreadyParticipated) {

            await interaction.update({
                content:
                    `⏳ You have already participated in today's **${getTypeName(activeDailyQuiz.type)}** Daily Quiz.`,
                components: [],
            });

            return;
        }

    } catch (error) {

        console.error(
            "❌ Daily Quiz cooldown check failed:",
            error.message
        );

        await interaction.update({
            content:
                "⚠️ I couldn't check your participation status right now.",
            components: [],
        });

        return;
    }

    const selectedId =
        interaction.values?.[0];

    const country =
        activeDailyQuiz.countries.find(
            (item) =>
                String(item.id) ===
                String(selectedId)
        );

    if (!country) {

        await interaction.update({
            content:
                "❌ That country is no longer available.",
            components: [],
        });

        return;
    }

    if (country.solved) {

        await interaction.update({
            content:
                `❌ **${country.country}** has already been solved.`,
            components: [],
        });

        return;
    }

    if (
        country.attempts.has(
            interaction.user.id
        )
    ) {

        await interaction.update({
            content:
                `⚠️ You already attempted **${country.country}**.`,
            components: [],
        });

        return;
    }

    // ==========================================
    // MODAL
    // ==========================================

    const modal =
        new ModalBuilder()
            .setCustomId(
                `dailyquiz_submit_${country.id}`
            )
            .setTitle(
                `Daily Quiz — ${getTypeName(
                    activeDailyQuiz.type
                )}`
            );

    const answerInput =
        new TextInputBuilder()
            .setCustomId("answer")
            .setLabel(
                getAnswerLabel(
                    activeDailyQuiz.type
                )
            )
            .setPlaceholder(
                getAnswerPlaceholder(
                    activeDailyQuiz.type
                )
            )
            .setStyle(
                TextInputStyle.Short
            )
            .setRequired(true)
            .setMaxLength(100);

    modal.addComponents(
        new ActionRowBuilder()
            .addComponents(answerInput)
    );

    await interaction.showModal(
        modal
    );
}


// ==========================================
// MODAL SUBMISSION
// ==========================================

async function handleDailyQuizAnswer(
    interaction
) {

    if (
        !interaction.customId.startsWith(
            "dailyquiz_submit_"
        )
    ) {
        return;
    }

    // Restore if bot restarted
    if (!activeDailyQuiz) {

        const restored =
            await restoreActiveDailyQuiz(
                interaction
            );

        if (!restored) {

            await interaction.reply({
                content:
                    "❌ This Daily Quiz has ended.",
                flags:
                    MessageFlags.Ephemeral,
            });

            return;
        }
    }

    // ==========================================
    // GET COUNTRY
    // ==========================================

    const countryId =
        interaction.customId.replace(
            "dailyquiz_submit_",
            ""
        );

    const country =
        activeDailyQuiz.countries.find(
            (item) =>
                String(item.id) ===
                String(countryId)
        );

    if (!country) {

        await interaction.reply({
            content:
                "❌ That country is no longer available.",
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }

    const answer =
        interaction.fields
            .getTextInputValue("answer")
            .trim();

    if (!answer) {

        await interaction.reply({
            content:
                "❌ Please enter an answer.",
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }

    // ==========================================
    // 24-HOUR TYPE COOLDOWN CHECK
    // ==========================================

    try {

        const alreadyParticipated =
            await hasUserCooldown(
                activeDailyQuiz.type,
                interaction.user.id
            );

        if (alreadyParticipated) {

            await interaction.reply({
                content:
                    `⏳ You have already participated in today's **${getTypeName(activeDailyQuiz.type)}** Daily Quiz.`,
                flags:
                    MessageFlags.Ephemeral,
            });

            return;
        }

    } catch (error) {

        console.error(
            "❌ Cooldown check failed:",
            error.message
        );

        await interaction.reply({
            content:
                "⚠️ I couldn't verify your participation status. Please try again.",
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }

    // ==========================================
    // ALREADY SOLVED
    // ==========================================

    if (country.solved) {

        await interaction.reply({
            content:
                `❌ **${country.country}** has already been solved.`,
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }

    // ==========================================
    // ALREADY ATTEMPTED
    // ==========================================

    if (
        country.attempts.has(
            interaction.user.id
        )
    ) {

        await interaction.reply({
            content:
                `⚠️ You have already attempted **${country.country}**.\n\n` +
                `You only get **one attempt per country**.`,
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }

    // ==========================================
    // LOCK ATTEMPT IN MEMORY
    // ==========================================

    country.attempts.add(
        interaction.user.id
    );

    await interaction.deferReply({
        flags:
            MessageFlags.Ephemeral,
    });

    // ==========================================
    // AI ANSWER JUDGE
    // ==========================================

    let judgment;

    try {

        judgment =
            await judgeDailyQuizAnswer({
                type:
                    activeDailyQuiz.type,

                country:
                    country.country,

                userAnswer:
                    answer,

                acceptedAnswers:
                    country.answers,

                scrambled:
                    country.scrambled,
            });

    } catch (error) {

        console.error(
            "❌ Daily Quiz answer judge failed:",
            error
        );

        // AI failed, so attempt is NOT counted
        country.attempts.delete(
            interaction.user.id
        );

        try {
            await redisDeleteUserCooldown(
                activeDailyQuiz.type,
                interaction.user.id
            );
        } catch (cleanupError) {
            console.error(
                "❌ Cooldown cleanup failed:",
                cleanupError.message
            );
        }

        await interaction.editReply({
            content:
                "⚠️ I couldn't verify your answer right now. " +
                "Your attempt was not counted. Please try again.",
        });

        return;
    }

    // ==========================================
    // ANSWER WAS JUDGED
    // SET 24-HOUR COOLDOWN
    // ==========================================

    try {

        await setUserCooldown(
            activeDailyQuiz.type,
            interaction.user.id
        );

    } catch (error) {

        console.error(
            "❌ Failed to save participation cooldown:",
            error.message
        );

        country.attempts.delete(
            interaction.user.id
        );

        await interaction.editReply({
            content:
                "⚠️ I couldn't save your participation status. Your answer was not counted. Please try again.",
        });

        return;
    }

// ==========================================
// WRONG ANSWER
// ==========================================

if (!judgment.correct) {

    const username =
        interaction.user.username || "Unknown";

    const displayName =
        interaction.member?.displayName ||
        interaction.user.globalName ||
        interaction.user.username ||
        "Unknown";

    const quizType =
        getTypeName(activeDailyQuiz.type);

    const correctAnswer =
        Array.isArray(country.answers) &&
        country.answers.length > 0
            ? country.answers[0]
            : "the correct answer was not available";

    // ==========================================
    // LOG WRONG ANSWER TO CONSOLE
    // ==========================================

    console.log(
        "\n" +
        "❌ WRONG ANSWER\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        `👤 Username: ${username}\n` +
        `🏷️ Display Name: ${displayName}\n` +
        `🧠 Quiz: ${quizType}\n` +
        `🌍 Country: ${country.flag || "🌍"} ${country.country}\n` +
        `💬 Answer: ${answer}\n` +
        `✅ Correct Answer: ${correctAnswer}\n` +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    );

    // Persist the strike
    await persistActiveDailyQuiz();

    await interaction.editReply({
        content:
            `❌ **Wrong answer!**\n\n` +
            `${country.flag} **${country.country}** ` +
            `has been marked as **~~strike~~** for you.\n\n` +
            `✅ **Correct answer:** ${correctAnswer}\n\n` +
            `You cannot attempt this country again.`,
    });

    return;
}
    // ==========================================
    // CORRECT ANSWER
    // ==========================================

    country.solved = true;

    const winner = {
        id:
            interaction.user.id,

        username:
            interaction.user.username,

        country:
            country.country,

        flag:
            country.flag,

        answer,

        position:
            activeDailyQuiz.winners.length + 1,
    };

    country.winner = winner;

    activeDailyQuiz.winners.push(
        winner
    );

    // Persist winner immediately
    await persistActiveDailyQuiz();

    await interaction.editReply({
        content:
            `✅ **Correct!**\n\n` +
            `${country.flag} **${country.country}**\n` +
            `🏆 Winner #${winner.position}\n` +
            `💰 Prize: **${PRIZE_AMOUNT} Mora**`,
    });

    await updateDailyQuizMessage();

    await sendPaymentNotification(
        winner,
        interaction
    );

    // ==========================================
    // FIVE WINNERS = FINISH
    // ==========================================

    if (
        activeDailyQuiz.winners.length >=
        WINNERS_REQUIRED
    ) {
        await finishDailyQuiz();
    }
}


// ==========================================
// FIND COUNTRY
// ==========================================

function findCountry(input) {

    const normalized =
        normalize(input);

    return activeDailyQuiz.countries.find(
        (country) =>
            normalize(country.country) ===
            normalized
    );
}


// ==========================================
// NORMALIZE
// ==========================================

function normalize(value) {

    return value
        .toLowerCase()
        .normalize("NFD")
        .replace(
            /[\u0300-\u036f]/g,
            ""
        )
        .replace(
            /[^\p{L}\p{N}\s]/gu,
            ""
        )
        .replace(
            /\s+/g,
            " "
        )
        .trim();
}


// ==========================================
// UPDATE ORIGINAL MESSAGE
// ==========================================

async function updateDailyQuizMessage() {

    if (
        !activeDailyQuiz ||
        !activeDailyQuiz.message
    ) {
        return;
    }

    try {

        await activeDailyQuiz.message.edit({
            content:
                buildQuizMessage(),

            components:
                buildAnswerButton(),
        });

    } catch (error) {

        console.error(
            "❌ Failed to update Daily Quiz:",
            error.message
        );
    }
}


// ==========================================
// PAYMENT NOTIFICATION
// ==========================================

async function sendPaymentNotification(
    winner,
    interaction
) {

    if (!winner || !interaction) {
        return;
    }

    const mentions =
        PAYMENT_STAFF
            .map(
                (id) =>
                    `<@${id}>`
            )
            .join(" ");

    try {

        // Use the fresh modal interaction's webhook instead of
        // channel.send(). This works with User Install and does
        // not require normal bot channel permissions.
        await interaction.followUp({
            content:
                `💰 **DAILY QUIZ PAYMENT**\n\n` +

                `🏆 Winner #${winner.position}: ` +
                `"${winner.username}" <@${winner.id}>\n` +

                `🌍 ${winner.flag} ${winner.country}\n` +

                `💵 Amount: **${PRIZE_AMOUNT} Mora**\n\n` +

                `${mentions} please process the payment.`,

            allowedMentions: {
                users: [
                    ...PAYMENT_STAFF,
                    winner.id,
                ],
            },
        });

    } catch (error) {

        console.error(
            "❌ Payment notification failed:",
            error.message
        );
    }
}


// ==========================================
// FINISH QUIZ
// ==========================================

async function finishDailyQuiz() {

    if (!activeDailyQuiz) {
        return;
    }

    const quiz =
        activeDailyQuiz;

    // Release memory/Redis active state
    activeDailyQuiz = null;

    try {
        await releaseActiveEvent(
            quiz.eventId
        );
    } catch (error) {
        console.error(
            "❌ Failed to release Daily Quiz lock:",
            error
        );
    }

    // Save completed event
    try {

        await updateEvent(
            quiz.eventId,
            {
                eventId:
                    quiz.eventId,

                hostId:
                    quiz.hostId,

                channelId:
                    quiz.channel?.id ||
                    quiz.channelId ||
                    null,

                messageId:
                    quiz.message?.id ||
                    quiz.messageId ||
                    null,

                type:
                    quiz.type,

                status:
                    "completed",

                countries:
                    quiz.countries.map(
                        (country) => ({
                            id: country.id,
                            country: country.country,
                            flag: country.flag,
                            prompt: country.prompt,
                            answers:
                                country.answers || [],
                            scrambled:
                                country.scrambled ||
                                null,
                            attempts:
                                Array.from(
                                    country.attempts ||
                                    []
                                ),
                            solved:
                                Boolean(
                                    country.solved
                                ),
                            winner:
                                country.winner ||
                                null,
                        })
                    ),

                winners:
                    quiz.winners.map(
                        (winner) => ({
                            id: winner.id,
                            username:
                                winner.username,
                            country:
                                winner.country,
                            flag:
                                winner.flag,
                            answer:
                                winner.answer,
                            position:
                                winner.position,
                        })
                    ),

                completedAt:
                    Date.now(),
            }
        );

    } catch (error) {

        console.error(
            "❌ Failed to save completed Daily Quiz:",
            error
        );
    }

    // Disable button
    try {

        if (quiz.message) {

            const disabledButton =
                new ButtonBuilder()
                    .setCustomId(
                        "dailyquiz_finished"
                    )
                    .setLabel(
                        "Daily Quiz Finished"
                    )
                    .setStyle(
                        ButtonStyle.Secondary
                    )
                    .setDisabled(true);

            const row =
                new ActionRowBuilder()
                    .addComponents(
                        disabledButton
                    );

            await quiz.message.edit({
                content:
                    buildFinishedMessage(
                        quiz
                    ),

                components: [row],
            });
        }

    } catch (error) {

        console.error(
            "❌ Failed to finish Daily Quiz message:",
            error.message
        );
    }

    // Notify host
    try {

        if (
            quiz.channel &&
            quiz.hostId
        ) {

            await quiz.channel.send({
                content:
                    `<@${quiz.hostId}> 🏁 **Your Daily Quiz has ended!**`,
            });
        }

    } catch (error) {

        console.error(
            "❌ Failed to notify Daily Quiz host:",
            error.message
        );
    }
}


// ==========================================
// FORCE KILL DAILY QUIZ
// ==========================================

async function killDailyQuiz() {

    const redisEventId =
        await getActiveEventId();

    const quiz =
        activeDailyQuiz;

    if (
        !quiz &&
        !redisEventId
    ) {
        return false;
    }

    activeDailyQuiz = null;

    const eventId =
        quiz?.eventId ||
        redisEventId;

    if (eventId) {

        try {
            await releaseActiveEvent(
                eventId
            );
        } catch (error) {
            console.error(
                "❌ Failed to release terminated Daily Quiz lock:",
                error
            );
        }

        try {

            const existingEvent =
                await getEvent(eventId);

            await updateEvent(
                eventId,
                {
                    ...(existingEvent || {}),

                    eventId,

                    hostId:
                        quiz?.hostId ||
                        existingEvent?.hostId ||
                        null,

                    channelId:
                        quiz?.channel?.id ||
                        quiz?.channelId ||
                        existingEvent?.channelId ||
                        null,

                    messageId:
                        quiz?.message?.id ||
                        quiz?.messageId ||
                        existingEvent?.messageId ||
                        null,

                    type:
                        quiz?.type ||
                        existingEvent?.type ||
                        null,

                    status:
                        "terminated",

                    terminatedAt:
                        Date.now(),
                }
            );

        } catch (error) {

            console.error(
                "❌ Failed to save terminated Daily Quiz:",
                error
            );
        }
    }

    if (quiz?.message) {

        try {

            const button =
                new ButtonBuilder()
                    .setCustomId(
                        "dailyquiz_terminated"
                    )
                    .setLabel(
                        "Daily Quiz Terminated"
                    )
                    .setStyle(
                        ButtonStyle.Secondary
                    )
                    .setDisabled(true);

            await quiz.message.edit({
                content:
                    "🛑 **Daily Quiz terminated.**",

                components: [
                    new ActionRowBuilder()
                        .addComponents(button),
                ],
            });

        } catch (error) {

            console.error(
                "❌ Failed to edit terminated Daily Quiz:",
                error.message
            );
        }
    }

    return true;
}


// ==========================================
// FINISHED MESSAGE
// ==========================================

function buildFinishedMessage(quiz) {

    const countryList =
        quiz.countries
            .map((item, index) => {

                if (item.solved) {

                    return (
                        `${index + 1}. ` +
                        `~~${item.flag} ${item.country}~~ ` +
                        `— ✅ **Done**`
                    );
                }

                return (
                    `${index + 1}. ` +
                    `~~${item.flag} ${item.country}~~`
                );
            })
            .join("\n");

    return (
        `# 🧠 DAILY QUIZ — ${getTypeName(
            quiz.type
        )}\n\n` +

        `${countryList}\n\n` +

        `🏆 **Daily Quiz completed!**`
    );
}


// ==========================================
// LABELS
// ==========================================

function getTypeName(type) {

    const names = {
        currency: "CURRENCY",
        capital: "CAPITAL",
        food: "FOOD",
        unscramble: "UNSCRAMBLE",
    };

    return (
        names[type] ||
        "DAILY QUIZ"
    );
}


function getAnswerLabel(type) {

    const labels = {
        currency:
            "Your currency answer",

        capital:
            "Your capital answer",

        food:
            "Your food answer",

        unscramble:
            "Your country answer",
    };

    return (
        labels[type] ||
        "Your answer"
    );
}


function getAnswerPlaceholder(type) {

    const placeholders = {
        currency:
            "Example: Yen",

        capital:
            "Example: Tokyo",

        food:
            "Example: Sushi",

        unscramble:
            "Example: Japan",
    };

    return (
        placeholders[type] ||
        "Type your answer"
    );
}


// ==========================================
// CLEAR USER DAILY ANSWER HISTORY
// ==========================================

async function killDailyQuizHistory() {

    try {

        const deleted =
            await clearAllUserCooldowns();

        console.log(
            `🧹 Cleared ${deleted} Daily Quiz participation cooldown(s).`
        );

        return deleted;

    } catch (error) {

        console.error(
            "❌ Failed to clear Daily Quiz history:",
            error.message
        );

        return false;
    }
}


// ==========================================
// EXPORTS
// ==========================================

module.exports = {
    killDailyQuizHistory,
    startDailyQuiz,
    handleDailyQuizButton,
    handleDailyQuizCountrySelect,
    handleDailyQuizAnswer,
    killDailyQuiz,
};