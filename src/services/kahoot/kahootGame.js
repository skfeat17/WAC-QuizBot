// kahootGame.js

const {
    getKahoot,
    saveKahoot,
    getQuestions,
    setActiveKahoot,
    getActiveKahootId,
    clearActiveKahoot,
    addPlayer,
    getPlayers,
    saveAnswer,
    claimAnswer,
    markUsedQuestion,
    getPlayer,
    createKahootRun,
} = require("./kahootRedis");

const {
    calculatePoints,
    rankPlayers,
} = require("./kahootScoring");

const {
    MessageFlags,
} = require("discord.js");

const {
    questionEmbed,
    answerRow,
    leaderboardEmbed,
    finalLeaderboardEmbed,
} = require("./kahootEmbeds");

const {
    notifyPaymentStaff,
} = require("./kahootRewards");

const timers = new Map();

function timerKey(kahootId) {
    return `kahoot:${kahootId}`;
}

function getMentionableUserIds(players) {
    return players
        .filter((player) => !player.isTestBot)
        .map((player) => String(player.id))
        .filter((id) => /^\d{17,20}$/.test(id));
}

/*
 * IMPORTANT:
 *
 * The Kahoot manager interaction itself can be private.
 *
 * The game creates EXACTLY ONE public follow-up message.
 * That same message is then edited for:
 *
 *   Start message
 *   Question
 *   Top 5 leaderboard
 *   Next question
 *   Final leaderboard
 *
 * No channel.send()
 * No client.channels.fetch()
 * No direct channel REST.
 */
async function sendPublicFollowUp(interaction, payload) {
    /*
     * IMPORTANT DISCORD INTERACTION BEHAVIOUR:
     *
     * The Start select interaction is first deferred ephemerally.
     * For a deferred interaction, Discord treats the FIRST follow-up
     * as the original deferred response. Its visibility therefore
     * remains ephemeral.
     *
     * So we intentionally consume that first follow-up, then create
     * the REAL public message with the second follow-up.
     *
     * The second message is the ONLY message we keep/edit during the
     * entire Kahoot.
     */
    await interaction.followUp({
        content: "🎮 Starting Kahoot...",
        ephemeral: false,
    });

    return await interaction.followUp({
        ...payload,
        ephemeral: false,
        fetchReply: true,
    });
}

async function editPublicFollowUp(
    interaction,
    messageId,
    payload
) {
    return await interaction.webhook.editMessage(
        messageId,
        payload
    );
}

async function chooseNextQuestion(kahootId) {
    const kahoot = await getKahoot(kahootId);
    const questions = await getQuestions(kahootId);

    /*
     * The used-question list is stored directly on the Kahoot.
     * Redis history is also maintained, but question sequencing
     * does not depend on Redis set reads.
     */
    const used = new Set(
        (kahoot?.usedQuestionIds || []).map(String)
    );

    return (
        questions.find(
            (question) =>
                !used.has(String(question.id))
        ) || null
    );
}

async function presentQuestion(
    client,
    kahootId,
    interaction
) {
    const kahoot = await getKahoot(kahootId);

    if (
        !kahoot ||
        kahoot.status !== "running"
    ) {
        return {
            success: false,
            reason: "not_running",
        };
    }

    const question = await chooseNextQuestion(
        kahootId
    );

    if (!question) {
        return await finishKahoot(
            client,
            kahootId,
            "completed",
            interaction
        );
    }

    const questions = await getQuestions(
        kahootId
    );

    if (!Array.isArray(kahoot.usedQuestionIds)) {
        kahoot.usedQuestionIds = [];
    }

    const questionId = String(question.id);

    /*
     * Never present the same question twice
     * during the same run.
     */
    if (
        kahoot.usedQuestionIds.includes(
            questionId
        )
    ) {
        return await finishKahoot(
            client,
            kahootId,
            "completed",
            interaction
        );
    }

    kahoot.usedQuestionIds.push(questionId);

    kahoot.currentQuestionIndex += 1;
    kahoot.currentQuestionId = question.id;
    kahoot.currentQuestionStartedAt = Date.now();
    kahoot.currentQuestionEndsAt =
        Date.now() +
        Number(
            kahoot.settings.questionTimer
        ) *
        1000;

    await saveKahoot(kahoot);

    /*
     * Keep Redis question history too.
     * It is intentionally not used as the primary
     * sequencing mechanism.
     */
    try {
        await markUsedQuestion(
            kahootId,
            question.id
        );
    } catch (error) {
        console.error(
            "⚠️ Could not update Redis used-question history:",
            error.message || error
        );
    }

    try {
        const questionPayload = {
            embeds: [
                questionEmbed(
                    kahoot,
                    question,
                    kahoot.currentQuestionIndex,
                    questions.length,
                    Number(
                        kahoot.settings.questionTimer
                    ) * 1000
                ).toJSON(),
            ],
            components: [
                answerRow(
                    kahootId,
                    question
                ).toJSON(),
            ],
        };

        /*
         * EXACTLY ONE public message.
         *
         * The first call creates it.
         * Every later call edits it.
         */
        if (!kahoot.currentMessageId) {
            const message =
                await sendPublicFollowUp(
                    interaction,
                    questionPayload
                );

            kahoot.currentMessageId =
                message.id;

            await saveKahoot(kahoot);
        } else {
            await editPublicFollowUp(
                interaction,
                kahoot.currentMessageId,
                questionPayload
            );
        }

        const timer = setTimeout(
            () =>
                closeQuestion(
                    client,
                    kahootId,
                    question.id,
                    interaction,
                    kahoot.runId
                ),
            Number(
                kahoot.settings.questionTimer
            ) * 1000
        );

        timers.set(
            timerKey(kahootId),
            timer
        );

        return {
            success: true,
            question,
        };
    } catch (error) {
        console.error(
            "❌ Failed to send/edit public Kahoot question:",
            error
        );

        kahoot.status = "created";
        kahoot.currentQuestionId = null;
        kahoot.currentMessageId = null;
        kahoot.currentQuestionStartedAt = null;
        kahoot.currentQuestionEndsAt = null;

        await saveKahoot(kahoot);
        await clearActiveKahoot(kahootId);

        return {
            success: false,
            reason: "message_failed",
            error,
        };
    }
}

async function closeQuestion(
    client,
    kahootId,
    questionId,
    interaction,
    runId = null
) {
    const kahoot = await getKahoot(kahootId);

    if (
        !kahoot ||
        kahoot.status !== "running" ||
        Number(kahoot.currentQuestionId) !==
        Number(questionId) ||
        (runId &&
            kahoot.runId !== runId)
    ) {
        return;
    }

    const timer = timers.get(
        timerKey(kahootId)
    );

    if (timer) {
        clearTimeout(timer);
    }

    timers.delete(
        timerKey(kahootId)
    );

    const players =
        await getPlayers(kahootId);

    try {
        /*
         * First remove answer buttons from the
         * SAME public message.
         */
        if (kahoot.currentMessageId) {
            try {
                await editPublicFollowUp(
                    interaction,
                    kahoot.currentMessageId,
                    {
                        components: [],
                    }
                );
            } catch (error) {
                console.error(
                    "⚠️ Could not disable Kahoot answer buttons:",
                    error.message || error
                );
            }
        }

        const questions =
            await getQuestions(kahootId);

        const isLastQuestion =
            Number(
                kahoot.currentQuestionIndex
            ) >=
            questions.length - 1;

        /*
         * Last question:
         * immediately show final leaderboard.
         */
        if (isLastQuestion) {
            return await finishKahoot(
                client,
                kahootId,
                "completed",
                interaction
            );
        }

        /*
         * Intermediate questions:
         * replace the question with Top 5.
         */
        await editPublicFollowUp(
            interaction,
            kahoot.currentMessageId,
            {
                content: players
                    .filter((player) => !player.isTestBot)
                    .slice(0, 5)
                    .map((player) => `<@${player.id}>`)
                    .join("\n"),

                embeds: [
                    leaderboardEmbed(
                        kahoot,
                        players
                    ).toJSON(),
                ],
                components: [],
                allowedMentions: {
                    users:
                        getMentionableUserIds(
                            players
                        ),
                },
            }
        );

        const leaderboardTimer =
            Number(
                kahoot.settings
                    .leaderboardTimer
            ) * 1000;

        /*
         * After the leaderboard timer,
         * edit the SAME message into the next question.
         */
        const nextTimer = setTimeout(
            async () => {
                try {
                    const latest =
                        await getKahoot(
                            kahootId
                        );

                    /*
                     * Ignore callbacks belonging
                     * to an older run.
                     */
                    if (
                        !latest ||
                        latest.status !==
                        "running" ||
                        latest.runId !==
                        kahoot.runId
                    ) {
                        return;
                    }

                    const result =
                        await presentQuestion(
                            client,
                            kahootId,
                            interaction
                        );

                    if (!result.success) {
                        console.error(
                            "❌ Failed to advance Kahoot:",
                            result.reason
                        );
                    }
                } catch (error) {
                    console.error(
                        "❌ Kahoot next-question timer failed:",
                        error.message || error
                    );
                }
            },
            leaderboardTimer
        );

        timers.set(
            timerKey(kahootId),
            nextTimer
        );

        return {
            success: true,
            leaderboardShown: true,
        };
    } catch (error) {
        console.error(
            "❌ Kahoot question close failed:",
            error
        );
    }
}

async function startKahoot(
    client,
    kahootId,
    interaction
) {
    const kahoot =
        await getKahoot(kahootId);

    if (!kahoot) {
        return {
            success: false,
            reason: "not_found",
        };
    }

    const questions =
        await getQuestions(kahootId);

    if (!questions.length) {
        return {
            success: false,
            reason: "no_questions",
        };
    }

    const active =
        await getActiveKahootId();

    if (
        active &&
        active !== kahootId
    ) {
        return {
            success: false,
            reason: "another_active",
        };
    }

    /*
     * START ALWAYS MEANS RESTART.
     */
    const existingTimer =
        timers.get(
            timerKey(kahootId)
        );

    if (existingTimer) {
        clearTimeout(existingTimer);
        timers.delete(
            timerKey(kahootId)
        );
    }

    const runId =
        await createKahootRun(
            kahootId
        );

    kahoot.status = "running";
    kahoot.runId = runId;
    kahoot.startedAt = Date.now();
    kahoot.channelId =
        interaction.channelId;
    kahoot.startedBy =
        interaction.user.id;

    /*
     * Reset the complete run.
     */
    kahoot.currentQuestionIndex = -1;
    kahoot.currentQuestionId = null;
    kahoot.currentMessageId = null;
    kahoot.currentQuestionStartedAt = null;
    kahoot.currentQuestionEndsAt = null;
    kahoot.usedQuestionIds = [];

    await saveKahoot(kahoot);
    await setActiveKahoot(kahootId);

    /*
     * ONE AND ONLY ONE public follow-up.
     *
     * The Start interaction itself may already have
     * been deferred ephemerally by kahoot.js.
     *
     * Explicit ephemeral:false makes this follow-up
     * the public game message.
     */
    const startMessage =
        await sendPublicFollowUp(
            interaction,
            {
                content:
                    `🎮 **${kahoot.name}** has successfully started!\n` +
                    `Get ready — the first question is coming up.`,
            }
        );

    kahoot.currentMessageId =
        startMessage.id;

    await saveKahoot(kahoot);

    /*
     * Replace the start announcement with Q1.
     * No second public message is created.
     */
    const result =
        await presentQuestion(
            client,
            kahootId,
            interaction
        );

    if (!result.success) {
        return result;
    }

    return {
        success: true,
        restarted: true,
        runId,
        kahoot,
    };
}

async function safeAnswerEdit(interaction, content) {
    try {
        if (!interaction.deferred && !interaction.replied) {
            return false;
        }

        await interaction.editReply(content);
        return true;
    } catch (error) {
        console.error(
            "⚠️ Could not send Kahoot answer result:",
            error.message || error
        );
        return false;
    }
}

async function submitAnswer(
    client,
    interaction,
    alreadyDeferred = false
) {
    const parts =
        interaction.customId.split(":");

    // kahoot:answer:gameId:questionId:index
    const [
        ,
        ,
        kahootId,
        questionId,
        selectedIndex,
    ] = parts;

    /*
     * ACKNOWLEDGE THE BUTTON IMMEDIATELY.
     *
     * Do this before ANY Redis/database work.
     * Otherwise a slow Redis request can make Discord
     * show "Interaction failed".
     */
    try {
        if (!alreadyDeferred && !interaction.deferred && !interaction.replied) {
            await interaction.deferReply({
                flags:
                    MessageFlags.Ephemeral,
            });
        }
    } catch (error) {
        console.error(
            "❌ Failed to acknowledge Kahoot answer interaction:",
            error.message || error
        );
        return;
    }

    const kahoot =
        await getKahoot(kahootId);

    if (
        !kahoot ||
        kahoot.status !== "running"
    ) {
        await safeAnswerEdit(interaction,
            "❌ This Kahoot is not currently running."
        );
        return;
    }

    if (
        Number(
            kahoot.currentQuestionId
        ) !== Number(questionId)
    ) {
        await safeAnswerEdit(interaction,
            "❌ This question is no longer active."
        );
        return;
    }

    const now = Date.now();

    if (
        now >
        Number(
            kahoot.currentQuestionEndsAt
        )
    ) {
        await safeAnswerEdit(interaction,
            "⏱️ Time is up!"
        );
        return;
    }

    const questions =
        await getQuestions(kahootId);

    const question =
        questions.find(
            (q) =>
                Number(q.id) ===
                Number(questionId)
        );

    if (!question) {
        await safeAnswerEdit(interaction,
            "❌ Question no longer exists."
        );
        return;
    }

    /*
     * CLAIM THE ANSWER ATOMICALLY.
     *
     * This MUST happen before calculating/awarding points.
     * HSETNX guarantees that two simultaneous clicks from
     * the same user cannot both receive points.
     */
    let claimed = false;

    try {
        claimed = await claimAnswer(
            kahootId,
            questionId,
            interaction.user.id
        );
    } catch (error) {
        console.error(
            "❌ Failed to claim Kahoot answer:",
            error.message || error
        );

        await safeAnswerEdit(interaction,
            "❌ Your answer could not be recorded. Please try again."
        );
        return;
    }

    if (!claimed) {
        await safeAnswerEdit(interaction,
            "⚠️ You have already answered this question."
        );
        return;
    }

    const elapsedMs =
        now -
        Number(
            kahoot.currentQuestionStartedAt
        );

    const correct =
        Number(selectedIndex) ===
        Number(question.correctIndex);

    const points =
        calculatePoints({
            correct,
            elapsedMs,
            timerMs:
                Number(
                    kahoot.settings
                        .questionTimer
                ) * 1000,
        });

    /*
     * SHOW THE RESULT FIRST.
     *
     * Do NOT wait for player/answer persistence.
     */
    const resultMessage = correct
        ? `✅ Correct! **+${points.toFixed(
            2
        )} points**`
        : `❌ Incorrect! **0.00 points**`;

    try {
        await safeAnswerEdit(interaction,
            resultMessage
        );
    } finally {
        /*
         * Persist everything AFTER the user has already
         * received their result.
         *
         * This is intentionally non-blocking so Redis writes
         * cannot make the interaction feel slow.
         */
        void persistAnswerResult({
            kahootId,
            questionId,
            userId:
                interaction.user.id,
            username:
                interaction.user.username,
            displayName:
                interaction.member
                    ?.displayName ||
                interaction.user.globalName ||
                interaction.user.username,
            selectedIndex:
                Number(selectedIndex),
            correct,
            points,
            elapsedMs,
            answeredAt: now,
        });
    }
}

async function persistAnswerResult({
    kahootId,
    questionId,
    userId,
    username,
    displayName,
    selectedIndex,
    correct,
    points,
    elapsedMs,
    answeredAt,
}) {
    try {
        /*
         * Fetch the latest player AFTER the immediate
         * interaction response, then apply this answer.
         */
        let player =
            await getPlayer(
                kahootId,
                userId
            );

        if (!player) {
            player = {
                id: userId,
                username,
                displayName:
                    displayName ||
                    username,
                score: 0,
                totalAnswerMs: 0,
                answeredQuestions: 0,
                correctAnswers: 0,
                participated: false,
                joinedAt: Date.now(),
            };
        }

        player.username = username;
        player.displayName =
            displayName || username;

        player.score =
            Number(player.score || 0) +
            Number(points || 0);

        player.totalAnswerMs =
            Number(
                player.totalAnswerMs || 0
            ) +
            Number(elapsedMs || 0);

        player.answeredQuestions =
            Number(
                player.answeredQuestions || 0
            ) + 1;

        player.participated = true;

        player.lastAnswerAt =
            answeredAt;

        if (correct) {
            player.correctAnswers =
                Number(
                    player.correctAnswers || 0
                ) + 1;
        }

        await redisUpdatePlayer(
            kahootId,
            player
        );

        /*
         * The answer was atomically claimed before the
         * response. Now replace the claim marker with
         * the complete answer data.
         */
        await saveAnswer(
            kahootId,
            questionId,
            {
                userId,
                selectedIndex,
                correct,
                points,
                elapsedMs,
                answeredAt,
            }
        );

        console.log(
            `💾 KAHOOT ANSWER SAVED | ${kahootId} | ${userId} | +${Number(points || 0).toFixed(2)}`
        );
    } catch (error) {
        /*
         * The user has already received their result, so
         * persistence errors are logged instead of being
         * surfaced as an interaction failure.
         */
        console.error(
            "❌ Background Kahoot answer persistence failed:",
            {
                kahootId,
                questionId,
                userId,
                error:
                    error.message || error,
            }
        );
    }
}


async function redisUpdatePlayer(
    kahootId,
    player
) {
    await addPlayer(
        kahootId,
        player
    );
}

async function finishKahoot(
    client,
    kahootId,
    reason = "completed",
    interaction = null
) {
    const kahoot =
        await getKahoot(kahootId);

    if (!kahoot) {
        return {
            success: false,
            reason: "not_found",
        };
    }

    if (
        kahoot.status !== "running"
    ) {
        return {
            success: false,
            reason: "not_running",
        };
    }

    const timer =
        timers.get(
            timerKey(kahootId)
        );

    if (timer) {
        clearTimeout(timer);
    }

    timers.delete(
        timerKey(kahootId)
    );

    kahoot.status =
        reason === "terminated"
            ? "terminated"
            : "finished";

    kahoot.finishedAt =
        Date.now();

    const players =
        await getPlayers(kahootId);

    const ranked =
        rankPlayers(players);

    await saveKahoot(kahoot);
    await clearActiveKahoot(
        kahootId
    );

    /*
     * FINAL LEADERBOARD:
     *
     * Edit the SAME public message.
     * Never create another public follow-up.
     */
    if (interaction) {
        try {
            if (
                kahoot.currentMessageId
            ) {
                await editPublicFollowUp(
                    interaction,
                    kahoot.currentMessageId,
                    {
                        content: null,
                        embeds: [
                            finalLeaderboardEmbed(
                                kahoot,
                                ranked
                            ).toJSON(),
                        ],
                        components: [],
                        allowedMentions: {
                            users:
                                getMentionableUserIds(
                                    ranked
                                ),
                        },
                    }
                );
            }
        } catch (error) {
            console.error(
                "❌ Final Kahoot leaderboard failed:",
                error.message || error
            );
        }
    }

    /*
     * Payment staff are notified only when
     * the Kahoot completes normally.
     *
     * Manual termination/end does not pay.
     */
    if (
        reason === "completed"
    ) {
        try {
            /*
             * Test bots are never sent to the
             * payment system.
             */
            const realPlayers =
                ranked.filter(
                    (player) =>
                        !player.isTestBot
                );

            await notifyPaymentStaff({
                client,
                kahoot,
                rankedPlayers:
                    realPlayers,
            });
        } catch (error) {
            console.error(
                "❌ Kahoot payment notification failed:",
                error
            );
        }
    }

    return {
        success: true,
        kahoot,
        ranked,
    };
}

module.exports = {
    startKahoot,
    submitAnswer,
    finishKahoot,
    presentQuestion,
    closeQuestion,
};
