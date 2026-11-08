// Independent Boss Mode system.
// Uses its own Redis namespace. Weekly Quiz data is untouched.

const crypto = require('node:crypto');

const {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags,
    WebhookClient,
} = require('discord.js');

const R = require('./bossRedis');
const E = require('./bossEmbeds');
const questionData = require('./weekly-questions-v5.json');
const { COMMAND_ACCESS } = require('../COMMAND_ACCESS');

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

const QUESTIONS = Array.isArray(questionData.questions)
    ? questionData.questions
    : [];

const HARD_QUESTIONS = QUESTIONS.filter(question =>
    question &&
    question.id != null &&
    String(question.difficulty || '').toLowerCase() === 'hard' &&
    typeof question.question === 'string' &&
    Array.isArray(question.options) &&
    question.options.length >= 2 &&
    Number.isInteger(Number(question.correctAnswer)) &&
    Number(question.correctAnswer) >= 0 &&
    Number(question.correctAnswer) < question.options.length
);

const QUESTION_TIME_MS = 10_000;
const QUESTIONS_PER_ATTEMPT = 5;
const RESULT_PAUSE_MS = 1200;

const ADMIN_IDS = [
    ...(COMMAND_ACCESS.weekly || []),
    ...(COMMAND_ACCESS.dailyevent || []),
].map(String);

const activeTimers = new Map();
const nextQuestionTimers = new Map();
const liveResponses = new Map();

// Prevent simultaneous processing of multiple answer taps.
const processingAnswers = new Set();

// --------------------------------------------------
// LOGGING
// --------------------------------------------------

function getPlayerName(user) {
    return user.globalName || user.username || user.id;
}

function bossLog(action, details = {}) {
    const timestamp = new Date().toISOString();

    const message = Object.entries(details)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
            const clean = String(value).replace(/[\r\n]+/g, ' ');
            return `${key}: ${clean}`;
        })
        .join(' | ');

    console.log(
        `[BOSS MODE]` +
        (message ? ` | ${message}` : '')
    );
}

function optionLabel(option) {
    if (option && typeof option === 'object') {
        return String(
            option.label ??
            option.text ??
            option.name ??
            JSON.stringify(option)
        );
    }

    return String(option);
}

function getOptionLetter(index) {
    return String.fromCharCode(65 + Number(index));
}

function getCorrectAnswer(question) {
    const index = Number(question.correctAnswer);

    return `${getOptionLetter(index)} (${optionLabel(question.options[index])})`;
}

function getOptions(question) {
    return question.options
        .map((option, index) =>
            `${getOptionLetter(index)}: ${optionLabel(option)}`
        )
        .join(' | ');
}

function isAdmin(userId) {
    return ADMIN_IDS.includes(String(userId));
}

// --------------------------------------------------
// QUESTIONS
// --------------------------------------------------

function pickHardQuestion() {
    if (!HARD_QUESTIONS.length) {
        throw new Error(
            'No valid hard questions found in weekly-questions-v5.json'
        );
    }

    return HARD_QUESTIONS[
        crypto.randomInt(0, HARD_QUESTIONS.length)
    ];
}

function speedPoints(elapsedMs) {
    const remaining = Math.max(
        0,
        QUESTION_TIME_MS - elapsedMs
    );

    return Math.max(
        1,
        Math.ceil((remaining / QUESTION_TIME_MS) * 100)
    );
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --------------------------------------------------
// SLASH COMMAND
// --------------------------------------------------

function bossCommand() {
    return new SlashCommandBuilder()
        .setName('boss')
        .setDescription('Manage World Boss Mode')
        .addStringOption(option =>
            option
                .setName('action')
                .setDescription('Choose an action')
                .setRequired(true)
                .addChoices(
                    { name: 'Start', value: 'start' },
                    { name: 'Leaderboard', value: 'leaderboard' },
                    { name: 'Participants', value: 'participants' },
                    { name: 'End', value: 'end' },
                    { name: 'Reset', value: 'reset' }
                )
        )
        .addIntegerOption(option =>
            option
                .setName('duration')
                .setDescription('Event duration in minutes')
                .setMinValue(1)
                .setMaxValue(1440)
                .setRequired(false)
        );
}

// --------------------------------------------------
// EVENT STATE
// --------------------------------------------------

async function getLiveState() {
    const state = await R.getState();

    if (
        state?.status === 'active' &&
        Date.now() >= Number(state.endsAt)
    ) {
        state.status = 'ended';
        state.endedAt = Date.now();

        await R.setState(state);

        bossLog('EVENT AUTO-ENDED', {
            time: new Date(state.endedAt).toISOString(),
        });
    }

    return state;
}

// --------------------------------------------------
// EPHEMERAL RESPONSE MANAGEMENT
// --------------------------------------------------

function rememberResponse(interaction) {
    liveResponses.set(String(interaction.user.id), {
        webhook: new WebhookClient({
            id: interaction.applicationId,
            token: interaction.token,
        }),
        messageId: '@original',
    });
}

async function editPlayerMessage(userId, payload) {
    const id = String(userId);
    const live = liveResponses.get(id);

    if (!live) return false;

    try {
        await live.webhook.editMessage(
            live.messageId,
            payload
        );

        return true;
    } catch (error) {
        if ([50027, 10015].includes(Number(error.code))) {
            liveResponses.delete(id);

            bossLog('RESPONSE EXPIRED', {
                userId: id,
            });

            return false;
        }

        bossLog('MESSAGE EDIT ERROR', {
            userId: id,
            error: error.message,
        });

        return false;
    }
}

function makePlayerEditor(user) {
    return {
        user,
        editReply: payload =>
            editPlayerMessage(user.id, payload),
    };
}

// --------------------------------------------------
// SESSION MANAGEMENT
// --------------------------------------------------

async function recordSessionAnswer(
    userId,
    outcome,
    timeout = false
) {
    const session = await R.getSession(userId) || {
        answered: 0,
        correct: 0,
        incorrect: 0,
        timeouts: 0,
        points: 0,
        startedAt: Date.now(),
    };

    session.answered += 1;
    session.points += Number(outcome.delta || 0);

    if (timeout) {
        session.timeouts += 1;
    } else if (outcome.correct) {
        session.correct += 1;
    } else {
        session.incorrect += 1;
    }

    await R.setSession(userId, session);

    return session;
}

async function settleAnswer(
    user,
    active,
    selectedIndex,
    timeout = false
) {
    const participant = await R.ensureParticipant(user);

    const correct = !timeout &&
        Number(selectedIndex) ===
        Number(active.question.correctAnswer);

    const elapsed = Math.max(
        0,
        Date.now() - Number(active.startedAt)
    );

    const delta = timeout
        ? 0
        : correct
            ? speedPoints(elapsed)
            : -50;

    participant.points =
        Number(participant.points || 0) + delta;

    participant.questionsAnswered =
        Number(participant.questionsAnswered || 0) + 1;

    if (timeout) {
        participant.timeouts =
            Number(participant.timeouts || 0) + 1;
    } else if (correct) {
        participant.correct =
            Number(participant.correct || 0) + 1;
    } else {
        participant.incorrect =
            Number(participant.incorrect || 0) + 1;
    }

    await R.saveParticipant(participant);

    return {
        correct,
        delta,
        participant,
        elapsed,
    };
}

// --------------------------------------------------
// NEXT QUESTION
// --------------------------------------------------

async function postNextQuestion(interaction) {
    const userId = String(interaction.user.id);
    const player = getPlayerName(interaction.user);

    const state = await getLiveState();

    if (!state || state.status !== 'active') {
        return interaction.editReply({
            content: '🔴 Boss Mode is not currently active.',
            embeds: [],
            components: [],
        });
    }

    let session = await R.getSession(userId);

    if (
        session &&
        Number(session.answered) >= QUESTIONS_PER_ATTEMPT
    ) {
        await R.clearSession(userId);
        return;
    }

    const question = pickHardQuestion();
    const questionId = crypto.randomUUID();

    const startedAt = Date.now();
    const deadlineAt = startedAt + QUESTION_TIME_MS;

    await R.ensureParticipant(interaction.user);

    if (!session) {
        session = {
            answered: 0,
            correct: 0,
            incorrect: 0,
            timeouts: 0,
            points: 0,
            startedAt: Date.now(),
        };

        await R.setSession(userId, session);
    }

    await R.setActiveQuestion(userId, {
        questionId,
        question,
        startedAt,
        deadlineAt,
    });

    // Full question and options in one log line.
    bossLog('QUESTION', {
        player,
        progress: `${session.answered + 1}/5`,
        question: question.question,
        options: getOptions(question),
        answer: getCorrectAnswer(question),
    });

    const response = await interaction.editReply({
        content: '',
        embeds: [
            E.questionEmbed(question, deadlineAt),
        ],
        components: E.questionComponents(
            questionId,
            question
        ),
    });

    const previousTimer = activeTimers.get(userId);

    if (previousTimer) {
        clearTimeout(previousTimer);
    }

    const timer = setTimeout(async () => {
        try {
            const active = await R.getActiveQuestion(userId);

            if (
                !active ||
                active.questionId !== questionId
            ) {
                return;
            }

            const currentState = await getLiveState();

            if (currentState?.status !== 'active') {
                await R.clearActiveQuestion(userId);

                await editPlayerMessage(userId, {
                    content: '🔴 Boss Mode has ended.',
                    embeds: [],
                    components: [],
                });

                return;
            }

            // Claim the question so an answer tap cannot score twice.
            if (processingAnswers.has(userId)) return;
            processingAnswers.add(userId);

            try {
                const outcome = await settleAnswer(
                    interaction.user,
                    active,
                    null,
                    true
                );

                await R.clearActiveQuestion(userId);

                const updatedSession = await recordSessionAnswer(
                    userId,
                    outcome,
                    true
                );

                const finished =
                    updatedSession.answered >= QUESTIONS_PER_ATTEMPT;

                bossLog('TIMEOUT', {
                    player,
                    progress: `${updatedSession.answered}/5`,
                    correct: getCorrectAnswer(active.question),
                    points: '+0',
                    total: outcome.participant.points,
                });

                if (finished) {
                    bossLog('ATTEMPT COMPLETED', {
                        player,
                        correct: updatedSession.correct,
                        incorrect: updatedSession.incorrect,
                        timeouts: updatedSession.timeouts,
                        attemptPoints: updatedSession.points,
                        total: outcome.participant.points,
                    });
                }

                await editPlayerMessage(userId, {
                    content: '',
                    embeds: [
                        finished
                            ? E.attemptSummaryEmbed(
                                updatedSession,
                                outcome.participant.points,
                                'Completed'
                            )
                            : E.resultEmbed({
                                correct: false,
                                timeout: true,
                                delta: 0,
                                total: outcome.participant.points,
                                question: active.question,
                                questionNumber: updatedSession.answered,
                            }),
                    ],
                    components: [],
                });

                if (finished) {
                    await R.clearSession(userId);
                } else {
                    await wait(RESULT_PAUSE_MS);

                    const stateNow = await getLiveState();

                    if (stateNow?.status === 'active') {
                        await postNextQuestion(
                            makePlayerEditor(interaction.user)
                        );
                    }
                }
            } finally {
                processingAnswers.delete(userId);
            }
        } catch (error) {
            bossLog('TIMEOUT ERROR', {
                player,
                error: error.message,
            });
        } finally {
            if (activeTimers.get(userId) === timer) {
                activeTimers.delete(userId);
            }
        }
    }, QUESTION_TIME_MS);

    activeTimers.set(userId, timer);
    timer.unref?.();

    return response;
}

// --------------------------------------------------
// BUTTON HANDLER
// --------------------------------------------------

async function handleBossButton(interaction) {
    const customId = interaction.customId || '';
    const userId = String(interaction.user.id);
    const player = getPlayerName(interaction.user);

    // START ATTEMPT
    if (customId === 'boss:challenge') {
        const state = await getLiveState();

        if (!state || state.status !== 'active') {
            return interaction.reply({
                content: '🔴 Boss Mode is not currently active.',
                flags: MessageFlags.Ephemeral,
            });
        }

        if (await R.getSession(userId)) {
            return interaction.reply({
                content: 'You already have an active attempt.',
                flags: MessageFlags.Ephemeral,
            });
        }

        bossLog('ATTEMPT STARTED', {
            player,
            questions: '5',
        });

        await interaction.deferReply({
            flags: MessageFlags.Ephemeral,
        });

        rememberResponse(interaction);

        return postNextQuestion(interaction);
    }

    // QUIT ATTEMPT
    if (customId === 'boss:quit') {
        await interaction.deferUpdate();

        const timer = activeTimers.get(userId);

        if (timer) clearTimeout(timer);

        activeTimers.delete(userId);

        const nextTimer = nextQuestionTimers.get(userId);

        if (nextTimer) clearTimeout(nextTimer);

        nextQuestionTimers.delete(userId);

        if (processingAnswers.has(userId)) {
            bossLog('QUIT IGNORED', {
                player,
                reason: 'Answer is being processed',
            });
            return;
        }

        await R.clearActiveQuestion(userId);

        const session = await R.getSession(userId);
        const participant = await R.getParticipant(userId);

        bossLog('QUIT', {
            player,
            progress: `${session?.answered || 0}/5`,
            attemptPoints: session?.points || 0,
            total: participant?.points || 0,
        });

        if (!session || !session.answered) {
            await R.clearSession(userId);

            await editPlayerMessage(userId, {
                content: 'You quit the attempt.',
                embeds: [],
                components: [],
            });

            return;
        }

        await editPlayerMessage(userId, {
            content: '',
            embeds: [
                E.attemptSummaryEmbed(
                    session,
                    participant?.points || 0,
                    'Quit early'
                ),
            ],
            components: [],
        });

        await R.clearSession(userId);

        return;
    }

    // LEADERBOARD BUTTON
    if (customId === 'boss:leaderboard') {
        bossLog('LEADERBOARD VIEWED', {
            player,
        });

        const [rows, state] = await Promise.all([
            R.getLeaderboard(10),
            getLiveState(),
        ]);

        return interaction.reply({
            embeds: [
                E.leaderboardEmbed(
                    rows,
                    state?.status === 'active' ? 'LIVE' : 'ENDED'
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    }

    if (!customId.startsWith('boss:answer:')) {
        return;
    }

    const [, , questionId, answerIndex] =
        customId.split(':');

    // Avoid concurrent answer processing.
    if (processingAnswers.has(userId)) {
        return interaction.deferUpdate();
    }

    processingAnswers.add(userId);

    try {
        await interaction.deferUpdate();

        const active = await R.getActiveQuestion(userId);

        if (
            !active ||
            active.questionId !== questionId
        ) {
            bossLog('STALE TAP', {
                player,
                selected: getOptionLetter(answerIndex),
            });

            return;
        }

        if (Date.now() >= Number(active.deadlineAt)) {
            bossLog('LATE TAP', {
                player,
                selected: `${getOptionLetter(answerIndex)} (${optionLabel(active.question.options[Number(answerIndex)])})`,
            });

            return;
        }

        const state = await getLiveState();

        if (state?.status !== 'active') {
            const timer = activeTimers.get(userId);

            if (timer) clearTimeout(timer);

            activeTimers.delete(userId);

            await R.clearActiveQuestion(userId);

            await editPlayerMessage(userId, {
                content: '🔴 Boss Mode has ended.',
                embeds: [],
                components: [],
            });

            return;
        }

        const timer = activeTimers.get(userId);

        if (timer) clearTimeout(timer);

        activeTimers.delete(userId);

        const selectedIndex = Number(answerIndex);
        const selectedOption = active.question.options[selectedIndex];

        const outcome = await settleAnswer(
            interaction.user,
            active,
            selectedIndex,
            false
        );

        await R.clearActiveQuestion(userId);

        const session = await recordSessionAnswer(
            userId,
            outcome,
            false
        );

        const finished =
            session.answered >= QUESTIONS_PER_ATTEMPT;

        // Compact answer log with global name.
        bossLog('ANSWER', {
            player,
            progress: `${session.answered}/5`,
            selected: `${getOptionLetter(selectedIndex)} (${optionLabel(selectedOption)})`,
            result: outcome.correct ? 'CORRECT' : 'WRONG',
            correct: getCorrectAnswer(active.question),
            points: outcome.delta > 0
                ? `+${outcome.delta}`
                : outcome.delta,
            total: outcome.participant.points,
        });

        if (finished) {
            bossLog('ATTEMPT COMPLETED', {
                player,
                correct: session.correct,
                incorrect: session.incorrect,
                timeouts: session.timeouts,
                attemptPoints: session.points,
                total: outcome.participant.points,
            });
        }

        await editPlayerMessage(userId, {
            content: '',
            embeds: [
                finished
                    ? E.attemptSummaryEmbed(
                        session,
                        outcome.participant.points,
                        'Completed'
                    )
                    : E.resultEmbed({
                        correct: outcome.correct,
                        timeout: false,
                        delta: outcome.delta,
                        total: outcome.participant.points,
                        question: active.question,
                        questionNumber: session.answered,
                    }),
            ],
            components: [],
        });

        if (finished) {
            await R.clearSession(userId);
            return;
        }

        const nextTimer = setTimeout(async () => {
            try {
                nextQuestionTimers.delete(userId);

                const stateNow = await getLiveState();

                if (stateNow?.status === 'active') {
                    await postNextQuestion(
                        makePlayerEditor(interaction.user)
                    );
                } else {
                    await editPlayerMessage(userId, {
                        content: '🏁 Boss Mode has ended. Your score has been saved.',
                        embeds: [],
                        components: [],
                    });
                }
            } catch (error) {
                bossLog('NEXT QUESTION ERROR', {
                    player,
                    error: error.message,
                });
            }
        }, RESULT_PAUSE_MS);

        nextQuestionTimers.set(userId, nextTimer);

    } catch (error) {
        bossLog('ANSWER ERROR', {
            player,
            error: error.message,
        });
    } finally {
        processingAnswers.delete(userId);
    }
}

// --------------------------------------------------
// SLASH COMMAND HANDLER
// --------------------------------------------------

async function handleBossCommand(interaction) {
    const action = interaction.options.getString('action');
    const duration =
        interaction.options.getInteger('duration') || 60;

    const player = getPlayerName(interaction.user);

    // LEADERBOARD
    if (action === 'leaderboard') {
        bossLog('LEADERBOARD VIEWED', {
            player,
        });

        const [rows, state] = await Promise.all([
            R.getLeaderboard(10),
            getLiveState(),
        ]);

        return interaction.reply({
            embeds: [
                E.leaderboardEmbed(
                    rows,
                    state?.status === 'active' ? 'LIVE' : 'ENDED'
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    }

    // ADMIN CHECK
    if (!isAdmin(interaction.user.id)) {
        bossLog('UNAUTHORIZED COMMAND', {
            player,
            action,
        });

        return interaction.reply({
            content: '❌ You are not authorized to manage Boss Mode.',
            flags: MessageFlags.Ephemeral,
        });
    }

    // START
    if (action === 'start') {
        const existing = await getLiveState();

        if (existing?.status === 'active') {
            return interaction.reply({
                content: 'Boss Mode is already active.',
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!HARD_QUESTIONS.length) {
            return interaction.reply({
                content: 'No valid hard questions were found. Check weekly-questions-v5.json.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const state = {
            status: 'active',
            startedAt: Date.now(),
            endsAt: Date.now() + duration * 60_000,
            durationMinutes: duration,
        };

        await R.clearBossData();
        await R.setState(state);

        bossLog('EVENT STARTED', {
            admin: player,
            duration: `${duration} minutes`,
            hardQuestions: HARD_QUESTIONS.length,
        });

        return interaction.reply({
            embeds: [
                E.eventEmbed(
                    state,
                    await R.getParticipantCount()
                ),
            ],
            components: E.eventComponents(false),
        });
    }

    // END
    if (action === 'end') {
        const state = await getLiveState();

        if (!state || state.status !== 'active') {
            return interaction.reply({
                content: 'Boss Mode is not active.',
                flags: MessageFlags.Ephemeral,
            });
        }

        state.status = 'ended';
        state.endedAt = Date.now();

        await R.setState(state);

        const ids = await R.redis.smembers(
            `${R.PREFIX}participants`
        );

        for (const id of ids || []) {
            const timer = activeTimers.get(String(id));

            if (timer) clearTimeout(timer);

            activeTimers.delete(String(id));

            const nextTimer = nextQuestionTimers.get(String(id));

            if (nextTimer) clearTimeout(nextTimer);

            nextQuestionTimers.delete(String(id));

            await R.clearActiveQuestion(id);
        }

        bossLog('EVENT ENDED', {
            admin: player,
            participants: await R.getParticipantCount(),
        });

        return interaction.reply({
            embeds: [
                E.eventEmbed(
                    state,
                    await R.getParticipantCount()
                ),
            ],
            components: E.eventComponents(true),
        });
    }

    // PARTICIPANTS
    if (action === 'participants') {
        bossLog('PARTICIPANTS VIEWED', {
            admin: player,
        });

        const rows = await R.getLeaderboard(100);

        const body = rows.length
            ? rows.map((participant, index) =>
                `${index + 1}. <@${participant.userId}> — **${participant.points} pts** · ✅ ${participant.correct} · ❌ ${participant.incorrect} · ⏰ ${participant.timeouts}`
            ).join('\n')
            : 'No participants yet.';

        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle('⚔️ BOSS MODE PARTICIPANTS')
                    .setDescription(body)
                    .setTimestamp(),
            ],
            flags: MessageFlags.Ephemeral,
        });
    }

    // RESET
    if (action === 'reset') {
        const state = await getLiveState();

        if (state?.status === 'active') {
            return interaction.reply({
                content: 'End Boss Mode before resetting its data.',
                flags: MessageFlags.Ephemeral,
            });
        }

        for (const timer of activeTimers.values()) {
            clearTimeout(timer);
        }

        for (const timer of nextQuestionTimers.values()) {
            clearTimeout(timer);
        }

        activeTimers.clear();
        nextQuestionTimers.clear();
        liveResponses.clear();
        processingAnswers.clear();

        await R.clearBossData();

        bossLog('EVENT RESET', {
            admin: player,
            weeklyQuiz: 'UNCHANGED',
        });

        return interaction.reply({
            content: '🧹 Boss Mode data has been cleared. Weekly Quiz data was not touched.',
            flags: MessageFlags.Ephemeral,
        });
    }
}

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
    bossCommand,
    handleBossCommand,
    handleBossButton,
};