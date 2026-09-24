// ==============================
// USERS WHO CAN ACCESS COMMANDS
// ==============================
const COMMAND_ACCESS =
    require("./services/COMMAND_ACCESS.js").COMMAND_ACCESS;

// ==============================
// BLOCKED QUIZ USERS
// ==============================
const BLOCKED_QUIZ_USERS = new Set([]);



require("dotenv").config();
const { Redis } = require("@upstash/redis");

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
const http = require("http");

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
    res.writeHead(200);
    res.end("WAC-QuizBot is running");
}).listen(PORT, () => {
    console.log(`🌐 HTTP server running on port ${PORT}`);
});

// ==============================
// UTILITIES FUNCTION IMPORTS
// ==============================

const {
    handleResolve,
} = require("./services/resolve");
const {
    treasureCooldownCommand,
    handleTreasureCooldown,
} = require("./services/treasureCooldownAdmin");
const {
    handleCountUsernames,
    handleCountUsernamesCopy,
} = require("./services/countUsernames");
const {
    startTreasureChestEvent,
    handleTreasureChestButton,
} = require("./services/treasureChestEvent");
const {
    clearAllTreasureCooldowns,
} = require("./services/treasureChestEventredis");
const {
    Client,
    GatewayIntentBits,
    Events,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags
} = require("discord.js");

const { generateQuiz } = require("./services/ai");

const {
    startDailyQuiz,
    handleDailyQuizButton,
    handleDailyQuizCountrySelect,
    handleDailyQuizAnswer,
    killDailyQuiz,
    killDailyQuizHistory,
} = require("./services/dailyQuiz");

// ==============================
// CLIENT
// ==============================

const client = new Client({
    intents: [GatewayIntentBits.Guilds],
});

// ==============================
// QUIZ SETTINGS
// ==============================

const activeQuizzes = new Map();

// 30 seconds
const QUIZ_DURATION = 20_000;

const MAX_WINNERS = 5;

// ==============================
// BOT READY
// ==============================

client.once(Events.ClientReady, (client) => {
    console.log(`✅ ${client.user.tag} is online!`);
});

// ==============================
// INTERACTIONS
// ==============================

client.on(Events.InteractionCreate, async (interaction) => {

    // ==========================================
    // /quiz + /dailyquiz COMMAND
    // ==========================================

    if (interaction.isChatInputCommand()) {

        // ==========================================
        // COMMAND ACCESS CONTROL
        // ==========================================

        let accessKey = interaction.commandName;

        if (interaction.commandName === "kill") {

            const subcommand =
                interaction.options.getSubcommand();

            accessKey = `kill:${subcommand}`;
        }

        const allowedUsers =
            COMMAND_ACCESS[accessKey] || [];

        if (!allowedUsers.includes(interaction.user.id)) {

            await interaction.reply({
                content:
                    "❌ You are not authorized to use this command.",
                flags: MessageFlags.Ephemeral,
            });

            return;
        }

        // ==========================================
        // /treasurecooldown COMMAND
        // ==========================================       
        if (interaction.commandName === "treasurecooldown") {
            try {
                await interaction.deferReply({
                    flags: MessageFlags.Ephemeral,
                });

                await handleTreasureCooldown(interaction);
            } catch (error) {
                console.error(
                    "❌ Treasure Cooldown command failed:",
                    error?.message || error
                );

                try {
                    if (interaction.deferred || interaction.replied) {
                        await interaction.editReply({
                            content:
                                "❌ Failed to process Treasure Cooldown command.",
                        });
                    }
                } catch (replyError) {
                    console.error(
                        "❌ Could not send Treasure Cooldown error:",
                        replyError?.message || replyError
                    );
                }
            }

            return;
        }
        // ==========================================
        // /kill treasure COMMAND
        // ==========================================
        if (
            interaction.commandName === "kill" &&
            interaction.options.getSubcommand() === "treasure"
        ) {
            try {
                const deleted =
                    await clearAllTreasureCooldowns();

                await interaction.reply({
                    content:
                        `🧹 **TREASURE HISTORY CLEARED**\n\n` +
                        `🗑️ Removed **${deleted}** treasure cooldown(s).\n` +
                        `🏝️ Everyone can use \`/treasure\` again.`,
                });
            } catch (error) {
                console.error(
                    "❌ Failed to clear treasure history:",
                    error
                );

                await interaction.reply({
                    content:
                        "❌ Failed to clear Treasure history.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            return;
        }
        // ==========================================
        // /treasure COMMAND
        // ==========================================
        if (interaction.commandName === "treasure") {
            await startTreasureChestEvent(interaction);
            return;
        }

        // ==========================================
        // /resolve
        // ==========================================

        if (interaction.commandName === "resolve") {

            await handleResolve(interaction);

            return;
        }

        // ==========================================
        // /countusernames
        // ==========================================

        if (interaction.commandName === "countusernames") {

            await handleCountUsernames(interaction);

            return;
        }

        // ==========================================
        // /kill
        // ==========================================

        if (interaction.commandName === "kill") {

            const subcommand =
                interaction.options.getSubcommand();

            // ==========================================
            // /kill history
            // ==========================================

            if (subcommand === "history") {

                console.log("🔥 /kill history reached");

                await interaction.deferReply({
                    flags: MessageFlags.Ephemeral,
                });

                const deleted =
                    await killDailyQuizHistory();

                if (deleted === false) {

                    console.log(
                        "🔥 /kill history reached deleted false"
                    );

                    await interaction.editReply({
                        content:
                            "❌ Failed to clear Daily Quiz participation history.",
                    });

                    return;
                }

                await interaction.editReply({
                    content:
                        `✅ Cleared **${deleted}** Daily Quiz participation record(s).\n\n` +
                        `Everyone can participate again.`,
                });

                console.log(
                    "🔥 /kill history reached deleted true"
                );

                return;
            }

            // ==========================================
            // /kill dailyquiz
            // ==========================================

            if (
                interaction.options.getSubcommand() ===
                "dailyevent"
            ) {


                // Acknowledge immediately so Discord does not expire
                // the interaction while killDailyQuiz() is working.
                await interaction.deferReply({
                    flags: MessageFlags.Ephemeral,
                });

                const killed =
                    await killDailyQuiz();

                if (!killed) {

                    await interaction.editReply({
                        content:
                            "ℹ️ There is no active Daily Quiz to terminate.",
                    });

                    return;
                }

                await interaction.editReply({
                    content:
                        "🛑 **Daily Quiz forcefully terminated.** You can start a new `/dailyquiz` now.",
                });

                return;
            }
        }

        // ==========================================
        // /dailyquiz
        // ==========================================

        if (
            interaction.commandName ===
            "dailyevent"
        ) {

            await startDailyQuiz(
                interaction
            );

            return;
        }

        // ==========================================
        // /quiz
        // ==========================================



        if (
            interaction.commandName !==
            "quiz"
        ) {
            return;
        }

        // ==========================================
        // NORMAL /QUIZ
        // ==========================================

        const region =
            interaction.options.getString(
                "region"
            );

        const topic =
            interaction.options.getString(
                "topic"
            );

        const difficulty =
            interaction.options.getString(
                "difficulty"
            );
        const reset =
            interaction.options.getBoolean("reset") || false;

        await interaction.deferReply();

        try {

            // ==========================================
            // GENERATE QUESTION
            // ==========================================

            const quiz =
                await generateQuiz(
                    region,
                    topic,
                    difficulty
                );


            // Reset counter when reset:true
            if (reset) {
                await redis.set(
                    "wac:stats:questions_asked",
                    0
                );
            }

            // Get next question number
            const questionNumber =
                await redis.incr(
                    "wac:stats:questions_asked"
                );




            const quizId =
                interaction.id;

            const startedAt =
                Date.now();

            const endsAt =
                startedAt +
                QUIZ_DURATION;

            const endUnix =
                Math.floor(
                    endsAt / 1000
                );

            // ==========================================
            // STORE QUIZ
            // ==========================================

            activeQuizzes.set(
                quizId,
                {
                    question:
                        quiz.question,
                    questionNumber,

                    options:
                        quiz.options,

                    correctAnswer:
                        quiz.correctAnswer,

                    explanation:
                        quiz.explanation,

                    answers:
                        new Map(),

                    startedAt,
                    endsAt,

                    interaction,
                }
            );

            // ==========================================
            // QUIZ EMBED
            // ==========================================

            const embed =
                new EmbedBuilder()
                    .setColor(
                        0x5865F2
                    )
                    .setAuthor({
                        name:
                            "🌍 WORLD ADVENTURE CLUB QUIZ",
                    })
                    .setDescription(
                        `### Question No. ${questionNumber}\n\n` +
                        `### ${quiz.question}\n\n` +
                        `⏱️ **Time Remaining:** <t:${endUnix}:R>`
                    )
                    .setFooter({
                        text:
                            "WAC • World Adventure Club",
                    });

            // ==========================================
            // ANSWER BUTTONS
            // ==========================================

            const buttons =
                quiz.options.map(
                    (option, index) => {

                        return new ButtonBuilder()
                            .setCustomId(
                                `quiz_${quizId}_${index}`
                            )
                            .setLabel(
                                option
                            )
                            .setStyle(
                                ButtonStyle.Primary
                            );
                    }
                );

            // ==========================================
            // 2 × 2 LAYOUT
            // ==========================================

            const row1 =
                new ActionRowBuilder()
                    .addComponents(
                        buttons[0],
                        buttons[1]
                    );

            const row2 =
                new ActionRowBuilder()
                    .addComponents(
                        buttons[2],
                        buttons[3]
                    );

            // ==========================================
            // SEND QUIZ
            // ==========================================

            await interaction.editReply({
                embeds: [
                    embed,
                ],

                components: [
                    row1,
                    row2,
                ],
            });

            // ==========================================
            // START TIMESTAMP UPDATER
            // ==========================================

            startTimestampUpdater(
                quizId
            );

            // ==========================================
            // FINISH AFTER 30 SECONDS
            // ==========================================

            setTimeout(
                () =>
                    finishQuiz(
                        quizId
                    ),
                QUIZ_DURATION
            );

        } catch (error) {

            console.error(
                "Quiz generation failed:",
                error
            );

            try {

                await interaction.editReply({
                    content:
                        "❌ I couldn't generate the quiz question. Please try again.",

                    embeds: [],

                    components: [],
                });

            } catch (replyError) {

                console.error(
                    "Failed to send error message:",
                    replyError
                );
            }
        }

        return;
    }

    // ==========================================
    // DAILY QUIZ MODAL
    // ==========================================

    if (interaction.isModalSubmit()) {

        if (
            interaction.customId.startsWith(
                "dailyquiz_submit_"
            )
        ) {

            await handleDailyQuizAnswer(
                interaction
            );

            return;
        }
    }

    // ==========================================
    // DAILY QUIZ COUNTRY DROPDOWN
    // ==========================================

    if (interaction.isStringSelectMenu()) {

        if (
            interaction.customId ===
            "dailyquiz_country"
        ) {

            await handleDailyQuizCountrySelect(
                interaction
            );

            return;
        }
    }

    // ==========================================
    // BUTTON INTERACTION
    // ==========================================

    if (interaction.isButton()) {
        // ------------------------------------------
        // TREASURE CHEST BUTTON
        // ------------------------------------------
        if (interaction.customId.startsWith("treasure_open_")
        ) {
            await handleTreasureChestButton(interaction);
            return;
        }
        // ------------------------------------------
        // COPY USERNAMES BUTTON
        // ------------------------------------------

        if (
            interaction.customId ===
            "countusernames_copy"
        ) {

            await handleCountUsernamesCopy(
                interaction
            );

            return;
        }

        // ------------------------------------------
        // DAILY QUIZ
        // ------------------------------------------
        if (
            interaction.customId.startsWith("dailyquiz_option_")
        ) {
            await handleDailyQuizAnswer(interaction);
            return;
        }

        if (
            interaction.customId ===
            "dailyquiz_answer"
        ) {

            await handleDailyQuizButton(
                interaction
            );

            return;
        }

        // ------------------------------------------
        // NORMAL QUIZ
        // ------------------------------------------

        if (
            !interaction.customId.startsWith(
                "quiz_"
            )
        ) {
            return;
        }

        const parts =
            interaction.customId.split(
                "_"
            );

        const quizId =
            parts[1];

        const selectedAnswer =
            Number(parts[2]);

        const quiz =
            activeQuizzes.get(
                quizId
            );

        // ==========================================
        // QUIZ DOESN'T EXIST
        // ==========================================

        if (!quiz) {

            try {

                await interaction.reply({
                    content:
                        "❌ This quiz has ended.",

                    flags:
                        MessageFlags.Ephemeral,
                });

            } catch (error) {

                console.error(
                    "Failed to respond to expired interaction:",
                    error
                );
            }

            return;
        }

        // ==========================================
        // TIMER EXPIRED
        // ==========================================

        if (
            Date.now() >=
            quiz.endsAt
        ) {

            try {

                await interaction.reply({
                    content:
                        "⏱️ **The 30-second timer has ended!**\n\n" +
                        "Please wait for the **rankings and answer reveal**.",

                    flags:
                        MessageFlags.Ephemeral,
                });

            } catch (error) {

                console.error(
                    "Failed to respond to expired timer interaction:",
                    error
                );
            }

            await finishQuiz(
                quizId
            );

            return;
        }

        // ==========================================
        // USER ALREADY ANSWERED
        // ==========================================

        if (
            quiz.answers.has(
                interaction.user.id
            )
        ) {

            try {

                await interaction.reply({
                    content:
                        "⚠️ You have already answered this quiz!",

                    flags:
                        MessageFlags.Ephemeral,
                });

            } catch (error) {

                console.error(
                    "Failed to respond to duplicate answer:",
                    error
                );
            }

            return;
        }

        // ==========================================
        // CHECK ANSWER
        // ==========================================

        const isCorrect =
            selectedAnswer ===
            quiz.correctAnswer;

        if (BLOCKED_QUIZ_USERS.has(interaction.user.id)) {
            await interaction.reply({
                content: "🚫 You are not allowed to participate in this quiz.",
                flags: MessageFlags.Ephemeral,
            });



            return;
        }



        quiz.answers.set(
            interaction.user.id,
            {
                selectedAnswer,

                isCorrect,

                userId:
                    interaction.user.id,

                username:
                    interaction.user.username,

                answeredAt:
                    Date.now(),
            }
        );

        // ==========================================
        // ANSWER SUBMITTED
        // ==========================================
        // IMPORTANT:
        // We still calculate and store whether the
        // answer is correct above.
        //
        // We simply DO NOT reveal the result to the
        // participant until the quiz finishes.

        try {


            await interaction.reply({
                content:
                    "📝 **Answer submitted!**\n" +
                    "⏳ Wait for the reveal — you'll be **pinged if you're in the Top 5!**",
                flags:
                    MessageFlags.Ephemeral,
            });

        } catch (error) {

            console.error(
                "Failed to send answer submission confirmation:",
                error
            );
        }
    }
});

// ==================================================
// TIMESTAMP UPDATER
// ==================================================

function startTimestampUpdater(
    quizId
) {

    const update = async () => {

        const quiz =
            activeQuizzes.get(
                quizId
            );

        // Quiz already finished
        if (!quiz) {
            return;
        }

        const remaining =
            quiz.endsAt -
            Date.now();

        // Stop updater when time expires
        if (
            remaining <= 0
        ) {
            return;
        }

        const endUnix =
            Math.floor(
                quiz.endsAt / 1000
            );

        try {

            const embed =
                new EmbedBuilder()
                    .setColor(
                        0x5865F2
                    )
                    .setAuthor({
                        name:
                            "🌍 WORLD ADVENTURE CLUB QUIZ",
                    })
                    .setDescription(
                        `### Question No. ${quiz.questionNumber}\n\n`
                            `### ${quiz.question}\n\n` +
                        `⏱️ **Time Remaining:** <t:${endUnix}:R>`
                    )
                    .setFooter({
                        text:
                            "WAC • World Adventure Club",
                    });

            await quiz.interaction.editReply({
                embeds: [
                    embed,
                ],
            });

        } catch (error) {

            // Don't crash the bot if Discord rejects
            // an old/stale interaction.
            console.error(
                "Timestamp update failed:",
                error.message
            );
        }

        // Update again after 1 second
        setTimeout(
            update,
            1000
        );
    };

    update();
}

// ==================================================
// FINISH QUIZ
// ==================================================

async function finishQuiz(
    quizId
) {

    const quiz =
        activeQuizzes.get(
            quizId
        );

    if (!quiz) {
        return;
    }

    // Remove from active quizzes
    activeQuizzes.delete(
        quizId
    );

    try {

        // ==========================================
        // GET FIRST 5 WINNERS
        // ==========================================

        const winners =
            [
                ...quiz.answers.values(),
            ]
                .filter(
                    answer =>
                        answer.isCorrect
                )
                .sort(
                    (a, b) =>
                        a.answeredAt -
                        b.answeredAt
                )
                .slice(
                    0,
                    MAX_WINNERS
                );

        // ==========================================
        // WINNER TEXT
        // ==========================================

        let winnerText;

        if (
            winners.length ===
            0
        ) {

            winnerText =
                "No one answered correctly.";

        } else {

            winnerText =
                winners
                    .map(
                        (
                            winner,
                            index
                        ) =>
                            `${getMedal(index)} <@${winner.userId}>`
                    )
                    .join("\n");
        }

        // ==========================================
        // DISABLE BUTTONS
        // ==========================================

        const disabledButtons =
            quiz.options.map(
                (
                    option,
                    index
                ) => {

                    return new ButtonBuilder()
                        .setCustomId(
                            `quiz_${quizId}_${index}`
                        )
                        .setLabel(
                            option
                        )
                        .setStyle(
                            index ===
                                quiz.correctAnswer
                                ? ButtonStyle.Success
                                : ButtonStyle.Secondary
                        )
                        .setDisabled(
                            true
                        );
                }
            );

        const disabledRow1 =
            new ActionRowBuilder()
                .addComponents(
                    disabledButtons[0],
                    disabledButtons[1]
                );

        const disabledRow2 =
            new ActionRowBuilder()
                .addComponents(
                    disabledButtons[2],
                    disabledButtons[3]
                );

        // ==========================================
        // UPDATE ORIGINAL QUIZ MESSAGE
        // ==========================================

        await quiz.interaction.editReply({
            components: [
                disabledRow1,
                disabledRow2,
            ],
        });

        // ==========================================
        // RESULTS EMBED
        // ==========================================

        const resultsEmbed =
            new EmbedBuilder()
                .setColor(
                    0x57F287
                )
                .setAuthor({
                    name:
                        "🌍 WORLD ADVENTURE CLUB QUIZ",
                })
                .setTitle(
                    "🏆 QUIZ WINNERS"
                )
                .addFields(

                    {
                        name:
                            "🏆 Winners",

                        value:
                            winnerText,

                        inline:
                            false,
                    },

                    {
                        name:
                            "✅ Correct Answer",

                        value:
                            `**${quiz.options[quiz.correctAnswer]}**`,

                        inline:
                            false,
                    },

                    {
                        name:
                            "📚 Did You Know?",

                        value:
                            quiz.explanation,

                        inline:
                            false,
                    }

                )
                .setFooter({
                    text:
                        "WAC • World Adventure Club",
                });

        // ==========================================
        // SEND RESULTS MESSAGE
        // ==========================================

        await quiz.interaction.followUp({
            content:
                winners.length > 0
                    ? winners
                        .map(winner => `<@${winner.userId}>`)
                        .join(" ")
                    : undefined,
            embeds: [
                resultsEmbed,
            ],
        });

    } catch (error) {

        console.error(
            "Failed to finish quiz:",
            error
        );
    }
}

// ==================================================
// MEDALS
// ==================================================

function getMedal(
    index
) {

    const medals = [
        "🥇",
        "🥈",
        "🥉",
        "4️⃣",
        "5️⃣",
    ];

    return (
        medals[index] ||
        "🏅"
    );
}

// ==================================================
// LOGIN
// ==================================================

client.login(
    process.env.DISCORD_TOKEN
);