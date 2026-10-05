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

const MYSTERY_EVENT_ID =
    "daily-world-mystery";

const EVENT_NAME =
    "🔮 Daily World Mystery Drop";

const EVENT_TYPE =
    "Mystery Event";

const REWARD_MIN = 10;
const REWARD_MAX = 30;

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

function generateReward() {
    const roll = Math.random() * 100;

    if (roll < 92) {
        return Math.floor(Math.random() * 6) + 10; // 10-15 | 92%
    }

    if (roll < 97) {
        return Math.floor(Math.random() * 5) + 16; // 16-20 | 5%
    }

    if (roll < 99) {
        return Math.floor(Math.random() * 5) + 21; // 21-25 | 2%
    }

    return Math.floor(Math.random() * 5) + 26; // 26-30 | 1%
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
        .setTitle("🔮 DAILY MYSTERY DROP!")
        .setDescription(
            [
                "━━━━━━━━━━━━━━━━━━━━",
                "",
                "🌍 **World-Related Mystery Question**",
                "",
                "A mystery from somewhere around the",
                "world is waiting to be uncovered...",
                "",
                `🎁 **Mystery Reward: Up to ${REWARD_MAX} ${MORA_EMOJI}**`,
                "",
                "<:paimonThink:1505801467435548752> Think you can solve it?",
                "",
                "━━━━━━━━━━━━━━━━━━━━",
            ].join("\n")
        )
        .setFooter({
            text:
                "Reveal your own mystery • Hidden reward • Hidden Cooldown",
        });
}

function buildRevealButton() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(REVEAL_BUTTON_ID)
            .setLabel(
                "Reveal My Mystery Question"
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
        .setTitle("🔮 YOUR MYSTERY QUESTION")
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
                `Attempt: ${attemptId}`,
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

function buildCorrectEmbed(
    attempt
) {
    return new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("✅ MYSTERY SOLVED!")
        .setDescription(
            [
                "You uncovered the mystery!",
                "",
                `🎁 **Reward: ${attempt.reward} ${MORA_EMOJI}**`,
                "",
                "📖 **Did you know?**",
                attempt.explanation,
                "",
                "Your next mystery will appear after your hidden cooldown (12-16) hours).<:1EmojiCatSalute:936530415177576458>",
            ].join("\n")
        );
}

function buildIncorrectEmbed(
    attempt
) {
    return new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("❌ MYSTERY NOT SOLVED")
        .setDescription(
            [
                "That wasn't the correct answer.",
                "",
                `✅ **Correct Answer:** ${attempt.answers[attempt.correctAnswer]}`,
                "",
                "📖 **Did you know?**",
                attempt.explanation,
                "",
                "Your mystery cooldown has started. 🔮",
            ].join("\n")
        );
}

function buildCooldownEmbed() {
    return new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle("⏳ NOT YET...")
        .setDescription(
            [
                "Your next mystery is still waiting",
                "to be unlocked.",
                "",
                "Come back later and try again! <:waiting:1505801859502178305>",
            ].join("\n")
        );
}

function buildNoQuestionEmbed() {
    return new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(
            "🔮 THE MYSTERY VAULT IS RESTOCKING..."
        )
        .setDescription(
            [
                "There are no fresh mysteries",
                "available right now.",
                "",
                "The mystery vault is being refilled.",
                "Please try again shortly!",
            ].join("\n")
        );
}

// ============================================================
// PUBLIC / PRIVATE ANSWER MESSAGES
// ============================================================

function buildPublicCorrectMessage(
    userId,
    reward
) {
    return [
        `🎉 Congratulations <@${userId}>!`,
        "",
        `You successfully solved the mystery and earned **${reward} ${MORA_EMOJI}**! 🔮`,
    ].join("\n");
}

function buildPublicIncorrectMessage(
    userId
) {
    return [
        `🔮 Nice try, <@${userId}>!`,
        "",
        "You didn't solve this mystery, but don't give up — another mystery awaits you! 💪",
    ].join("\n");
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
        "🔮 STARTING MYSTERY EVENT"
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
            "📢 Public Mystery Event embed created"
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
        `🛑 MYSTERY EVENT KILLED | ${eventId}`
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
        "🔮 MYSTERY REVEAL"
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
                "❌ The Mystery Event is not currently active.",
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

            const formattedTime =
                hours > 0
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
            "🔄 GENERATING NEW BATCH..."
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
            `❌ NO QUESTION AVAILABLE | ${userId}`
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
        `🎯 QUESTION CLAIMED`
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
        "🔮 MYSTERY ANSWER"
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
                "❌ This mystery attempt could not be found.",
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
                "❌ This mystery belongs to another player.",
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

    // --------------------------------------------------------
    // CLAIM COOLDOWN AFTER ANSWER
    // IMPORTANT:
    // Revealing a question does NOT start cooldown.
    // The cooldown starts only when the user answers.
    // --------------------------------------------------------

    const immune =
        MYSTERY_EVENT_COOLDOWN_IMMUNE.includes(
            userId
        );

    let cooldownSeconds =
        attempt.cooldownSeconds ?? null;

    if (!immune) {

        const cooldownResult =
            await claimMysteryCooldown(
                userId
            );

        if (!cooldownResult.claimed) {

            console.log(
                `⏳ COOLDOWN RACE LOST | ${userId}`
            );

            return true;
        }

        cooldownSeconds =
            cooldownResult.cooldownSeconds;

        console.log(
            `⏱️ COOLDOWN CREATED | ${cooldownSeconds}s`
        );
    } else {

        console.log(
            `🛡️ COOLDOWN IMMUNE | ${userId}`
        );
    }

    // --------------------------------------------------------
    // CHECK ANSWER
    // --------------------------------------------------------

    const isCorrect =
        selectedAnswer ===
        attempt.correctAnswer;

    const reward =
        isCorrect
            ? generateReward()
            : 0;

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
            `📊 STATS RECORDED | MYSTERY | ${userId} | ` +
            `${isCorrect ? "CORRECT" : "INCORRECT"}`
        );
    } catch (error) {
        console.error(
            "❌ MYSTERY STATS RECORD FAILED:",
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
    // PUBLIC FOLLOW-UP — SECOND
    // Same pattern as Daily Event
    // --------------------------------------------------------

    try {

        if (isCorrect) {

            await interaction.followUp({
                content:
                    `🎉 <@${userId}> solved it! **+${reward} ${MORA_EMOJI}**`,

                allowedMentions: {
                    users: [userId],
                },
            });

        } else {

            await interaction.followUp({
                content:
                    `🌟 <@${userId}> Great try!💗`,

                allowedMentions: {
                    users: [userId],
                },
            })
        }


    } catch (error) {

        console.error(
            "❌ PUBLIC RESULT FAILED:",
            error.message
        );
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
                    "❌ PAYMENT CREATION FAILED",
                    error
                );
            }

            // ------------------------------------------------
            // PRIVATE PAYMENT STAFF INSTRUCTION
            // ------------------------------------------------

            try {

                await interaction.followUp({
                    content:
                        `📖 **Did you know?**\n` +
                        `\`\`\`\n${attempt.explanation}\n\`\`\`\n\n` +
                        `-# 📢 Copy the fact above and share it in the chat! Let everyone know what you learned!`,
                    flags: MessageFlags.Ephemeral,
                });

            } catch (error) {

                console.error(
                    "❌ PAYMENT STAFF MESSAGE FAILED:",
                    error.message
                );
            }
        }

        console.log(
            `🏁 MYSTERY COMPLETE | ${attemptId}`
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
    hours
) {
    const numericHours =
        Number(hours);

    if (
        !Number.isFinite(
            numericHours
        ) ||
        numericHours < 0
    ) {
        throw new Error(
            "Invalid cooldown hours."
        );
    }

    const seconds =
        Math.floor(
            numericHours * 60 * 60
        );

    return setMysteryCooldown(
        userId,
        seconds
    );
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