const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
} = require("discord.js");

const {
    getActiveMysteryEventId,
    acquireMysteryEvent,
    releaseMysteryEvent,
    saveMysteryEvent,
    getMysteryEvent,

    getMysteryCooldown,
    getIncorrectAnswerCooldown,
    claimIncorrectAnswerCooldown,
    Incorrect_Answer_Cooldown,
    listAllMysteryCooldowns,
    claimMysteryCooldown,
    setMysteryCooldown,
    clearMysteryCooldown,
    clearAllMysteryCooldowns,

    getMysteryQuestionPoolSize,
    claimMysteryQuestion,

    saveMysteryAttempt,
    getMysteryAttempt,

    MYSTERY_EVENT_COOLDOWN_IMMUNE,
} = require("./mysteryDailyEventRedis");

const {
    generateMysteryQuestionBatch,
} = require("./mysteryDailyEventAI");

const {
    createPaymentTransaction,
} = require("./paymentService");

const {
    recordParticipation,
    recordMora,
} = require("./statsService");

// ============================================================
// CONFIG
// ============================================================
let formattedTime;
const MYSTERY_EVENT_ID =
    "daily-world-mystery";

const EVENT_NAME =
    "🌍 Daily World Event";

const EVENT_TYPE =
    "Mystery Event";

const REWARD_MIN = 10;
const REWARD_MAX = 20;

const MORA_EMOJI =
    "<:mora:1503931162525962333>";

const PAYMENT_STAFF_ID =
    "1295671787375296542";

const REVEAL_BUTTON_ID =
    "mysteryevent_reveal";

const ANSWER_BUTTON_PREFIX =
    "mysteryevent_answer";

// ============================================================
// RANDOM
// ============================================================

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateReward() {
    const roll = Math.random() * 100;

    if (roll < 85) {
        return randomInt(10, 13); // 85% — Common
    }

    if (roll < 95) {
        return randomInt(14, 16); // 10% — Uncommon
    }

    if (roll < 99) {
        return randomInt(17, 19); // 4% — Rare
    }

    return 20; // 1% — Jackpot
}

function createAttemptId() {
    return (
        `MYSTERY-${Date.now().toString(36).toUpperCase()}-` +
        Math.random()
            .toString(36)
            .slice(2, 8)
            .toUpperCase()
    );
}

// ============================================================
// PUBLIC EVENT EMBED
// IMPORTANT:
// This message is NEVER edited by the bot.
// ============================================================

function buildMysteryEventEmbed() {
    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("🌍 DAILY WORLD EVENT!")
        .setDescription(
            [
                "━━━━━━━━━━━━━━━━━━━━",
                "",
                "🌍 **Daily World Question**",
                "",
                "A question about somewhere around the",
                "world is waiting to be answered...",
                "",
                `🎁 **Reward: Up to ${REWARD_MAX} ${MORA_EMOJI}**`,
                `⚠️ **Incorrect answer cooldown: ${Incorrect_Answer_Cooldown / 60} minutes**`,
                "",
                "<:paimonThink:1505801467435548752> Think you know the answer?",
                "",
                "━━━━━━━━━━━━━━━━━━━━",
            ].join("\n")
        )
        .setFooter({
            text:
                "Daily question • Up to 20 Mora per attempt • Certain Cooldown after every attempt • Earn upto 100 Mora",
        });
}

function buildRevealButton() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(REVEAL_BUTTON_ID)
            .setLabel(
                "Reveal My Today's Question"
            )
            .setEmoji("🔮")
            .setStyle(ButtonStyle.Primary)
    );
}

// ============================================================
// EPHEMERAL QUESTION
// ============================================================

function buildQuestionEmbed(
    question,
    attemptId
) {
    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("🌍 YOUR DAILY QUESTION")
        .setDescription(
            [
                `**${question.question}**`,
                "",
                "Choose the correct answer below.",
            ].join("\n")
        )
        .setFooter({
            text:
                `Category: ${question.category} • ` +
                `2 Minute Cooldown for Incorrect Answers`,
        });
}

function buildAnswerButtons(
    question,
    attemptId
) {
    const row =
        new ActionRowBuilder();

    question.answers.forEach(
        (answer, index) => {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(
                        `${ANSWER_BUTTON_PREFIX}:${attemptId}:${index}`
                    )
                    .setLabel(
                        `${String.fromCharCode(
                            65 + index
                        )}. ${answer}`
                    )
                    .setStyle(
                        ButtonStyle.Secondary
                    )
            );
        }
    );

    return [row];
}

// ============================================================
// RESULT EMBEDS
// ============================================================

function getNextAttemptText(attempt) {
    const cooldownSeconds = Number(attempt.cooldownSeconds) || 0;

    if (cooldownSeconds <= 0) {
        return "You can play again now.";
    }

    const nextAttemptTimestamp = Math.floor(
        (Number(attempt.answeredAt || Date.now()) + cooldownSeconds * 1000) / 1000
    );

    return `⏳ **Next attempt:** <t:${nextAttemptTimestamp}:R>`;
}

function buildCorrectEmbed(attempt) {
    return new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("✅ MYSTERY SOLVED!")
        .setDescription([
            "You answered the daily question correctly!",
            "",
            `🎁 **Reward: ${attempt.reward} ${MORA_EMOJI}**`,
            "",
            "📖 **Did you know?**",
            attempt.explanation,
            "",
            getNextAttemptText(attempt),
            "",
            "**NOTE:** We will appreciate if you copy and share the fact of the next message! <:1EmojiCatSalute:936530415177576458>",
        ].join("\n"));
}

function buildIncorrectEmbed(attempt) {
    return new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("❌ INCORRECT ANSWER")
        .setDescription([
            "That's not the correct answer.",
            "",
            `⏳ A **${Incorrect_Answer_Cooldown / 60}-minute cooldown** has been applied for incorrect answers.`,
            "",
            getNextAttemptText(attempt),
            "",
            "📖 The fact is shared below so you can still learn something new!",
        ].join("\n"));
}

function buildCooldownEmbed() {
    return new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle("⏳ NOT YET...")
        .setDescription(
            [
                "Your next daily question is waiting",
                "for you.",
                "",
                `⏱️ **Time Remaining:** ${formattedTime}`,
                "",
                "Come back later for your next daily question! <:waiting:1505801859502178305>",
            ].join("\n")
        );
}

function buildNoQuestionEmbed() {
    return new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(
            "🌍 DAILY QUESTIONS ARE RESTOCKING..."
        )
        .setDescription(
            [
                "There are no fresh questions",
                "available right now.",
                "",
                "The question pool is being refilled.",
                "Please try again shortly!",
            ].join("\n")
        );
}


// ============================================================
// DISABLED ANSWER BUTTONS
// ============================================================

function buildDisabledAnswerButtons(
    attempt
) {
    const row =
        new ActionRowBuilder();

    attempt.answers.forEach(
        (answer, index) => {
            let style =
                ButtonStyle.Secondary;

            if (
                index ===
                attempt.correctAnswer
            ) {
                style =
                    ButtonStyle.Success;
            } else if (
                index ===
                attempt.selectedAnswer
            ) {
                style =
                    ButtonStyle.Danger;
            }

            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(
                        `${ANSWER_BUTTON_PREFIX}:${attempt.attemptId}:${index}`
                    )
                    .setLabel(
                        `${String.fromCharCode(
                            65 + index
                        )}. ${answer}`
                    )
                    .setStyle(style)
                    .setDisabled(true)
            );
        }
    );

    return [row];
}


// ============================================================
// START EVENT
// IMPORTANT:
// This only activates the Mystery Event.
// It does NOT require channel access.
// It does NOT send or edit any message.
// ============================================================

async function startMysteryEvent(interaction) {

    console.log(
        "\n========================================"
    );

    console.log(
        "🌍 STARTING DAILY WORLD EVENT"
    );

    const existing =
        await getActiveMysteryEventId();

    if (existing) {

        console.log(
            `⚠️ ALREADY ACTIVE | ${existing}`
        );

        return {
            success: false,
            reason: "already_active",
            event:
                await getMysteryEvent(existing),
        };
    }

    const acquired =
        await acquireMysteryEvent(
            MYSTERY_EVENT_ID
        );

    if (!acquired) {

        return {
            success: false,
            reason: "already_active",
        };
    }

    try {

        let poolSize =
            await getMysteryQuestionPoolSize();

        console.log(
            `📦 CURRENT QUESTION POOL: ${poolSize}`
        );

        /*
         * If the pool is empty,
         * generate 20 fresh questions.
         */
        if (poolSize === 0) {

            console.log(
                "📦 POOL EMPTY | Generating 20 questions..."
            );

            await generateMysteryQuestionBatch();

            poolSize =
                await getMysteryQuestionPoolSize();
        }

        const event = {

            eventId:
                MYSTERY_EVENT_ID,

            active: true,

            createdAt:
                Date.now(),

            updatedAt:
                Date.now(),
        };

        await saveMysteryEvent(
            MYSTERY_EVENT_ID,
            event
        );

        /*
         * Create the PUBLIC Mystery Event message.
         *
         * This is the same pattern as Daily Event:
         * the deferred slash-command reply becomes
         * the public event message.
         */
        await interaction.editReply({

            embeds: [
                buildMysteryEventEmbed()
            ],

            components: [
                buildRevealButton()
            ],
        });

        console.log(
            "✅ MYSTERY EVENT ACTIVE"
        );

        console.log(
            `📦 Question Pool: ${poolSize}`
        );

        console.log(
            "📢 Public Daily World Event embed created"
        );

        console.log(
            "========================================\n"
        );

        return {
            success: true,
            event,
        };

    } catch (error) {

        await releaseMysteryEvent(
            MYSTERY_EVENT_ID
        );

        console.error(
            "❌ MYSTERY EVENT START FAILED:",
            error
        );

        throw error;
    }
}

// ============================================================
// KILL EVENT
// IMPORTANT:
// Does NOT delete the public message.
// Does NOT delete question pool.
// Does NOT delete question history.
// ============================================================

async function killMysteryEvent() {
    const eventId =
        await getActiveMysteryEventId();

    if (!eventId) {
        return {
            success: false,
            reason: "not_active",
        };
    }

    const event =
        await getMysteryEvent(eventId);

    await releaseMysteryEvent(
        eventId
    );

    if (event) {
        event.active = false;
        event.updatedAt =
            Date.now();

        await saveMysteryEvent(
            eventId,
            event
        );
    }

    console.log(
        `🛑 DAILY WORLD EVENT STOPPED | ${eventId}`
    );

    console.log(
        "📦 QUESTION POOL PRESERVED"
    );

    console.log(
        "📚 QUESTION HISTORY PRESERVED"
    );

    return {
        success: true,
        event,
    };
}

// ============================================================
// REVEAL BUTTON
// ============================================================

async function handleMysteryReveal(
    interaction
) {
    const userId =
        interaction.user.id;

    console.log(
        "\n========================================"
    );

    console.log(
        "🌍 DAILY QUESTION REVEAL"
    );

    console.log(
        `👤 ${interaction.user.username} | ${userId}`
    );

    console.log(
        "========================================"
    );

    /*
     * IMPORTANT:
     * We immediately create an ephemeral reply.
     * We NEVER edit the public event message.
     */

    await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
    });

    // --------------------------------------------------------
    // EVENT CHECK
    // --------------------------------------------------------

    const activeEvent =
        await getActiveMysteryEventId();

    if (!activeEvent) {
        console.log(
            `❌ REVEAL BLOCKED | Event inactive | ${userId}`
        );

        await interaction.editReply({
            content:
                "❌ The Daily World Event is not currently active.",
        });

        return true;
    }

    // --------------------------------------------------------
    // INCORRECT-ANSWER COOLDOWN CHECK (SEPARATE FROM NORMAL)
    // --------------------------------------------------------

    const incorrectCooldown = await getIncorrectAnswerCooldown(userId);

    if (Number(incorrectCooldown) > 0) {
        const timestamp = Math.floor(Date.now() / 1000) + Number(incorrectCooldown);

        await interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle("⏳ Cooldown Active")
                    .setDescription(
                        `You can try again <t:${timestamp}:R>.`
                    )
            ],
            components: []
        });

        return true;
    }

    // --------------------------------------------------------
    // COOLDOWN CHECK
    // --------------------------------------------------------

    const immune =
        MYSTERY_EVENT_COOLDOWN_IMMUNE.includes(
            userId
        );

    if (immune) {
        console.log(
            `🛡️ COOLDOWN IMMUNE | ${userId}`
        );
    } else {
        const cooldown =
            await getMysteryCooldown(
                userId
            );

        if (Number(cooldown) > 0) {
            console.log(
                `⏳ COOLDOWN BLOCK`
            );

            const remainingSeconds =
                Math.max(0, Number(cooldown));

            const hours =
                Math.floor(
                    remainingSeconds / 3600
                );

            const minutes =
                Math.floor(
                    (remainingSeconds % 3600) / 60
                );

            const seconds =
                remainingSeconds % 60;

            formattedTime = hours > 0
                ? `${hours}h ${minutes}m ${seconds}s`
                : minutes > 0
                    ? `${minutes}m ${seconds}s`
                    : `${seconds}s`;

            console.log(
                `👤 Display Name: ${interaction.member?.displayName ||
                interaction.user.displayName ||
                interaction.user.username
                }`
            );


            console.log(
                `⏱️ Remaining Cooldown: ${formattedTime}`
            );

            await interaction.editReply({
                embeds: [
                    buildCooldownEmbed(),
                ],
            });

            return true;
        }
    }

    // --------------------------------------------------------
    // CLAIM QUESTION ATOMICALLY
    // --------------------------------------------------------

    let question =
        await claimMysteryQuestion();

    if (!question) {
        console.log(
            "📦 QUESTION POOL EMPTY"
        );

        console.log(
            "🔄 GENERATING NEW QUESTIONS..."
        );

        try {
            await generateMysteryQuestionBatch();

            question =
                await claimMysteryQuestion();
        } catch (error) {
            console.error(
                "❌ RESTOCK FAILED:",
                error
            );
        }
    }

    if (!question) {
        console.log(
            `❌ NO DAILY QUESTION AVAILABLE | ${userId}`
        );

        await interaction.editReply({
            embeds: [
                buildNoQuestionEmbed(),
            ],
        });

        return true;
    }



    // --------------------------------------------------------
    // COOLDOWN
    // IMPORTANT:
    // Cooldown is NOT created during reveal.
    // It is created only when the user submits an answer.
    // --------------------------------------------------------

    const cooldownSeconds = null;

    // --------------------------------------------------------
    // CREATE ATTEMPT
    // --------------------------------------------------------

    const attemptId =
        createAttemptId();

    const attempt = {
        attemptId,

        userId,

        username:
            interaction.user.username,

        questionId:
            question.id,

        category:
            question.category,

        subject:
            question.subject,

        question:
            question.question,

        answers:
            question.answers,

        correctAnswer:
            question.correctAnswer,

        explanation:
            question.explanation,

        selectedAnswer:
            null,

        correct:
            null,

        reward:
            null,

        cooldownSeconds,

        answered:
            false,

        createdAt:
            Date.now(),

        answeredAt:
            null,

        transactionId:
            null,
    };

    await saveMysteryAttempt(
        attemptId,
        attempt
    );

    // --------------------------------------------------------
    // LOG QUESTION
    // --------------------------------------------------------

    console.log(
        `🎯 DAILY QUESTION SELECTED`
    );

    console.log(
        `👤 User: ${userId}`
    );

    console.log(
        `📚 Category: ${question.category}`
    );

    console.log(
        `❓ Question: ${question.question}`
    );

    console.log(
        `🔢 Options:`
    );

    question.answers.forEach(
        (answer, index) => {
            console.log(
                `   ${String.fromCharCode(
                    65 + index
                )}. ${answer}`
            );
        }
    );

    console.log(
        `✅ Correct: ${String.fromCharCode(
            65 + question.correctAnswer
        )}. ${question.answers[question.correctAnswer]}`
    );

    console.log(
        `⏱️ Cooldown: ${immune
            ? "IMMUNE"
            : "NOT STARTED — starts after answer"
        }`
    );

    // --------------------------------------------------------
    // EPHEMERAL QUESTION
    // --------------------------------------------------------

    await interaction.editReply({
        embeds: [
            buildQuestionEmbed(
                question,
                attemptId
            ),
        ],

        components:
            buildAnswerButtons(
                question,
                attemptId
            ),
    });

    return true;
}

// ============================================================
// ANSWER BUTTON
// ============================================================

async function handleMysteryAnswer(
    interaction
) {
    if (
        !interaction.customId.startsWith(
            `${ANSWER_BUTTON_PREFIX}:`
        )
    ) {
        return false;
    }

    const parts =
        interaction.customId.split(":");

    const attemptId =
        parts[1];

    const selectedAnswer =
        Number(parts[2]);

    const userId =
        interaction.user.id;

    console.log(
        "\n========================================"
    );

    console.log(
        "🌍 DAILY QUESTION ANSWER"
    );

    console.log(
        `👤 ${interaction.user.username} | ${userId}`
    );


    console.log(
        `🔢 Selected: ${selectedAnswer}`
    );

    console.log(
        "========================================"
    );

    /*
     * Acknowledge the button immediately.
     */
    await interaction.deferUpdate();

    // --------------------------------------------------------
    // LOAD ATTEMPT
    // --------------------------------------------------------

    const attempt =
        await getMysteryAttempt(
            attemptId
        );

    if (!attempt) {
        await interaction.followUp({
            content:
                "❌ This daily question attempt could not be found.",
            flags: MessageFlags.Ephemeral,
        });

        return true;
    }

    // --------------------------------------------------------
    // USER OWNERSHIP
    // --------------------------------------------------------

    if (
        attempt.userId !== userId
    ) {
        await interaction.followUp({
            content:
                "❌ This question belongs to another player.",
            flags: MessageFlags.Ephemeral,
        });

        return true;
    }

    // --------------------------------------------------------
    // ALREADY ANSWERED
    // --------------------------------------------------------

    if (attempt.answered) {
        return true;
    }

    // --------------------------------------------------------
    // VALIDATE OPTION
    // --------------------------------------------------------

    if (
        !Number.isInteger(selectedAnswer) ||
        selectedAnswer < 0 ||
        selectedAnswer >= attempt.answers.length
    ) {
        await interaction.followUp({
            content:
                "❌ Invalid answer.",
            flags: MessageFlags.Ephemeral,
        });

        return true;
    }

    // ========================================================
    // CHECK ANSWER
    // Correct answers use the normal cooldown.
    // Incorrect answers use a separate fixed cooldown.
    // ========================================================

    const isCorrect = selectedAnswer === attempt.correctAnswer;
    let cooldownSeconds = 0;

    if (isCorrect) {
        const immune = MYSTERY_EVENT_COOLDOWN_IMMUNE.includes(userId);

        if (!immune) {
            const cooldownResult = await claimMysteryCooldown(userId);

            if (!cooldownResult.claimed) {
                const remaining = Math.max(
                    0,
                    Number(await getMysteryCooldown(userId)) || 0
                );
                const nextAttemptTimestamp = Math.floor(Date.now() / 1000) + remaining;

                await interaction.followUp({
                    content: remaining > 0
                        ? `⏳ You're on cooldown. Try again <t:${nextAttemptTimestamp}:R>.`
                        : "⏳ Your cooldown is active. Please try again shortly.",
                    flags: MessageFlags.Ephemeral,
                });

                return true;
            }

            cooldownSeconds = Number(cooldownResult.cooldownSeconds) || 0;
            console.log(`⏱️ COOLDOWN CREATED | ${cooldownSeconds}s | ${userId}`);
        } else {
            console.log(`🛡️ COOLDOWN IMMUNE | ${userId}`);
        }
    } else {
        const incorrectCooldownResult = await claimIncorrectAnswerCooldown(userId);

        if (!incorrectCooldownResult.claimed) {
            const remaining = Math.max(
                0,
                Number(await getIncorrectAnswerCooldown(userId)) || Incorrect_Answer_Cooldown
            );
            const nextAttemptTimestamp = Math.floor(Date.now() / 1000) + remaining;

            await interaction.followUp({
                content: `❌ Incorrect-answer cooldown is active. You can try again <t:${nextAttemptTimestamp}:R>.`,
                flags: MessageFlags.Ephemeral,
            });
            return true;
        }

        cooldownSeconds = Number(incorrectCooldownResult.cooldownSeconds) || Incorrect_Answer_Cooldown;
        console.log(`⏱️ INCORRECT-ANSWER COOLDOWN CREATED | ${cooldownSeconds}s | ${userId}`);
    }

    const reward = isCorrect ? generateReward() : 0;

    if (isCorrect) {
        console.log(`🎁 DAILY REWARD GENERATED | ${reward} Mora`);
    } else {
        console.log(`❌ INCORRECT ANSWER | ${Incorrect_Answer_Cooldown / 60}-MINUTE SEPARATE COOLDOWN | ${userId}`);
    }

    // --------------------------------------------------------
    // RECORD PARTICIPATION
    // User actually answered the mystery.
    // Records both correct and incorrect answers.
    // --------------------------------------------------------

    try {

        await recordParticipation(
            "mystery",
            userId
        );

        console.log(
            `📊 STATS RECORDED | DAILY EVENT | ${userId} | ` +
            `${isCorrect ? "CORRECT" : "INCORRECT"}`
        );

    } catch (error) {

        console.error(
            "❌ DAILY EVENT STATS RECORD FAILED:",
            error.message
        );
    }


    const answeredAttempt = {
        ...attempt,

        selectedAnswer,

        correct:
            isCorrect,

        reward,

        cooldownSeconds,

        answered:
            true,

        answeredAt:
            Date.now(),
    };

    // Save immediately so repeated clicks cannot trigger another reward.
    await saveMysteryAttempt(attemptId, answeredAttempt);

    const disabledButtons =
        buildDisabledAnswerButtons(
            answeredAttempt
        );

    // --------------------------------------------------------
    // PRIVATE RESULT — FIRST
    // --------------------------------------------------------

    if (isCorrect) {
        await interaction.editReply({
            embeds: [
                buildCorrectEmbed(
                    answeredAttempt
                ),
            ],
            components:
                disabledButtons,
        });
    } else {
        await interaction.editReply({
            embeds: [
                buildIncorrectEmbed(
                    answeredAttempt
                ),
            ],
            components:
                disabledButtons,
        });
    }


    // --------------------------------------------------------
    // SHOW THE FACT IMMEDIATELY — DO NOT WAIT FOR PAYMENT
    // --------------------------------------------------------

    try {
        await interaction.followUp({
            content: `📚 **The fact:**\n\`\`\`\n${attempt.explanation}\n\`\`\``,
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        console.error("❌ IMMEDIATE FACT MESSAGE FAILED:", error.message);
    }

    // --------------------------------------------------------
    // PUBLIC RESULT
    // --------------------------------------------------------

    try {
        await interaction.followUp({
            content: isCorrect
                ? `🎉 <@${userId}> answered correctly! **+${reward} ${MORA_EMOJI}**`
                : `🌟 <@${userId}> answered incorrectly!. Give it another try❤️!`,
            allowedMentions: { users: [userId] },
        });
    } catch (error) {
        console.error("❌ PUBLIC RESULT FAILED:", error.message);
    }

    // --------------------------------------------------------
    // BACKGROUND PROCESSING
    // --------------------------------------------------------

    processMysteryAnswerAfterResponse({
        interaction,
        attempt:
            answeredAttempt,
        attemptId,
        selectedAnswer,
        isCorrect,
        reward,
    }).catch(error => {

        console.error(
            "❌ BACKGROUND ANSWER PROCESSING FAILED:",
            error
        );
    });

    return true;
}


// ============================================================
// BACKGROUND ANSWER PROCESSING
// ============================================================

async function processMysteryAnswerAfterResponse({
    interaction,
    attempt,
    attemptId,
    selectedAnswer,
    isCorrect,
    reward,
}) {
    try {

        // ----------------------------------------------------
        // SAVE ANSWER
        // ----------------------------------------------------

        await saveMysteryAttempt(
            attemptId,
            attempt
        );

        // ----------------------------------------------------
        // FULL ANSWER LOG
        // ----------------------------------------------------

        console.log(
            `❓ Question: ${attempt.question}`
        );

        console.log(
            `🔘 Selected: ` +
            `${String.fromCharCode(
                65 + selectedAnswer
            )}. ${attempt.answers[selectedAnswer]}`
        );

        console.log(
            `✅ Correct: ` +
            `${String.fromCharCode(
                65 + attempt.correctAnswer
            )}. ${attempt.answers[attempt.correctAnswer]}`
        );

        console.log(
            `📊 Result: ${isCorrect
                ? "CORRECT"
                : "INCORRECT"
            }`
        );

        console.log(
            `🎁 Reward: ${reward} Mora`
        );

        console.log(
            `⏱️ Cooldown: ${attempt.cooldownSeconds ??
            "IMMUNE"
            }`
        );

        // ----------------------------------------------------
        // PAYMENT
        // ----------------------------------------------------

        if (isCorrect) {

            try {

                const transaction =
                    await createPaymentTransaction({
                        client:
                            interaction.client,

                        winnerId:
                            interaction.user.id,

                        displayName:
                            interaction.member
                                ?.displayName ||
                            interaction.user.displayName,

                        username:
                            interaction.user.username,

                        eventName:
                            EVENT_NAME,

                        eventType:
                            EVENT_TYPE,

                        reward,

                        sourceChannelId:
                            interaction.channelId,

                        sourceMessageId:
                            interaction.message?.id ||
                            null,
                    });

                attempt.transactionId =
                    transaction.transactionId;

                await saveMysteryAttempt(
                    attemptId,
                    attempt
                );

                console.log(
                    `💳 PAYMENT CREATED | ` +
                    `${transaction.transactionId}`
                );
                await recordMora(
                    "mystery",
                    interaction.user.id,
                    reward
                );
            } catch (error) {

                console.error(
                    "❌ DAILY EVENT PAYMENT CREATION FAILED",
                    error
                );
            }

        }

        console.log(
            `🏁 DAILY QUESTION COMPLETE | ${attemptId}`
        );

        console.log(
            "========================================\n"
        );

    } catch (error) {

        console.error(
            "❌ BACKGROUND ANSWER PROCESSING FAILED:",
            error
        );
    }
}

// ============================================================
// COOLDOWN ADMIN HELPERS
// ============================================================

async function listAllMysteryUserCooldowns() {
    return listAllMysteryCooldowns();
}

async function listMysteryCooldown(
    userId
) {
    const ttl =
        await getMysteryCooldown(userId);

    return ttl > 0 ? ttl : 0;
}

async function setMysteryUserCooldown(
    userId,
    hours = 0,
    minutes = 0
) {
    const numericHours = Number(hours);
    const numericMinutes = Number(minutes);

    if (
        !userId ||
        !Number.isFinite(numericHours) ||
        !Number.isInteger(numericHours) ||
        numericHours < 0 ||
        !Number.isFinite(numericMinutes) ||
        !Number.isInteger(numericMinutes) ||
        numericMinutes < 0 ||
        numericMinutes > 59 ||
        (numericHours === 0 && numericMinutes === 0)
    ) {
        throw new Error(
            "Invalid cooldown. Provide hours >= 0 and minutes between 0 and 59, with a total duration greater than 0."
        );
    }

    const seconds =
        (numericHours * 60 * 60) +
        (numericMinutes * 60);

    // Persist the exact duration in seconds.
    const result = await setMysteryCooldown(
        userId,
        seconds
    );

    // Return both the stored value and a human-readable duration
    // so the command handler can confirm the correct setting.
    return {
        success: true,
        userId,
        hours: numericHours,
        minutes: numericMinutes,
        seconds,
        duration: [
            numericHours > 0 ? `${numericHours} hour${numericHours === 1 ? "" : "s"}` : null,
            numericMinutes > 0 ? `${numericMinutes} minute${numericMinutes === 1 ? "" : "s"}` : null,
        ].filter(Boolean).join(" "),
        result,
    };
}

async function checkMysteryCooldown(
    userId
) {
    const ttl =
        await getMysteryCooldown(userId);

    return ttl > 0 ? ttl : 0;
}

async function clearMysteryUserCooldown(
    userId
) {
    return clearMysteryCooldown(
        userId
    );
}

async function clearAllMysteryUserCooldowns() {
    return clearAllMysteryCooldowns();
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    MYSTERY_EVENT_ID,

    EVENT_NAME,
    EVENT_TYPE,

    REWARD_MIN,
    REWARD_MAX,

    REVEAL_BUTTON_ID,
    ANSWER_BUTTON_PREFIX,

    startMysteryEvent,
    killMysteryEvent,

    handleMysteryReveal,
    handleMysteryAnswer,

    listAllMysteryUserCooldowns,
    listMysteryCooldown,
    setMysteryUserCooldown,
    checkMysteryCooldown,
    clearMysteryUserCooldown,
    clearAllMysteryUserCooldowns,

    buildMysteryEventEmbed,
    buildRevealButton,
};