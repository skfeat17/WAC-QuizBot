// Command handlers and quiz state machine for WAC Weekly World Quiz Champion.
//weekly.js
const crypto = require('node:crypto');
const emergencyData = require('./weekly-question-v3.json');
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, WebhookClient } = require('discord.js');
const R = require('./weeklyRedis');
const weeklyLogs = require('./weeklyLogs');
const {
    participationEmbed,
    participationComponents,
    leaderboardEmbed,
    questionEmbed,
    answerRows,
    resultEmbed,
    challengeReadyEmbed,
    challengeReadyComponents,
    answerFeedbackEmbed,
    profileEmbed, profileComponents, profileMenuEmbed, rulesGuideEmbed,
} = require('./weeklyEmbeds');
const { startWeeklyScheduler } = require('./weeklyScheduler');
const { utcDateKey, scoreForAnswer } = require('./weeklyUtils');
const { COMMAND_ACCESS } = require('../COMMAND_ACCESS');

const ADMIN_IDS = COMMAND_ACCESS.weekly || COMMAND_ACCESS.dailyevent || [];
const QUESTIONS_PER_ATTEMPT = 5;
const QUESTION_TIME_MS = 15_000;
const DIFFICULTY_SEQUENCE = ['easy', 'medium', 'easy', 'medium', 'hard'];
const DIFFICULTY_MULTIPLIERS = { easy: 1, medium: 1.5, hard: 2 };
const BASE_INCORRECT_PENALTY = 15;
const MEDALS = ['🥇', '🥈', '🥉', '🏅', '🎖️'];
const PRIZES = [1000, 750, 550, 400, 300];

// Holds the ephemeral response webhook for timeout-driven edits during this process.
const liveResponses = new Map();
const attemptCache = new Map();
const participantCache = new Map();
const participantWriteChains = new Map();
const attemptWriteChains = new Map();
let stateCache = null;
const emergencyQuestions = Array.isArray(emergencyData.questions) ? emergencyData.questions : [];
const questionById = new Map(emergencyQuestions.map((question) => [String(question.id), question]));
const questionCategories = [...new Set(emergencyQuestions.map((question) => question.category).filter(Boolean))];

function attemptCacheKey(userId, dayKey) { return `${userId}:${dayKey}`; }
function webhookDetails(interaction) { return { id: interaction.applicationId, token: interaction.token }; }

/**
 * Returns categories already answered in this attempt, using saved question IDs.
 * This also works when an interrupted attempt is resumed.
 */
function getAttemptCategories(attempt) {
    const categories = new Set();
    for (const answer of attempt?.answers || []) {
        const question = questionById.get(String(answer.questionId));
        if (question?.category) categories.add(question.category);
    }
    for (const question of attempt?.questions || []) {
        if (question?.category) categories.add(question.category);
    }
    return categories;
}

/**
 * Select exactly one random question from each category per attempt.
 * A player's permanent Redis history is updated before the question is returned,
 * so an assigned question stays used even if the attempt is abandoned.
 */
async function takeReadyQuestion(userId, usedCategories = new Set(), difficulty = 'easy') {
    if (!emergencyQuestions.length) throw new Error('The weekly question bank is empty.');

    const usedIds = new Set(await R.getUsedQuestionIds(userId));
    const remainingCategories = questionCategories.filter((category) => !usedCategories.has(category));

    if (!remainingCategories.length) {
        throw new Error('Every question category has already been used in this attempt.');
    }

    // Pick a random remaining category, then a random unused question in that category.
    const category = remainingCategories[crypto.randomInt(0, remainingCategories.length)];
    const available = emergencyQuestions.filter((question) =>
        question?.id &&
        question.category === category &&
        String(question.difficulty || '').toLowerCase() === difficulty &&
        !usedIds.has(String(question.id))
    );

    if (!available.length) {
        throw new Error(`You have used every available ${difficulty} question in the ${category} category.`);
    }

    const question = available[crypto.randomInt(0, available.length)];
    // Await persistence before displaying; abandoned attempts still consume the question.
    await R.markQuestionUsed(userId, String(question.id));
    return question;
}

function persistAttemptInBackground(attempt) {
    const key = attemptCacheKey(attempt.userId, attempt.dayKey);
    const previous = attemptWriteChains.get(key) || Promise.resolve();
    const next = previous.catch(() => { }).then(() => R.setAttempt(attempt.userId, attempt.dayKey, attempt));
    attemptWriteChains.set(key, next);
    next.catch((error) => console.error('[weekly] attempt save failed:', error.message || error))
        .finally(() => { if (attemptWriteChains.get(key) === next) attemptWriteChains.delete(key); });
    return next;
}

function saveParticipantInBackground(participant) {
    const userId = participant.userId;
    participantCache.set(userId, participant);
    const previous = participantWriteChains.get(userId) || Promise.resolve();
    const next = previous.catch(() => { }).then(() => R.saveParticipant(participant));
    participantWriteChains.set(userId, next);
    next.catch((error) => console.error('[weekly] participant save failed:', error.message || error))
        .finally(() => { if (participantWriteChains.get(userId) === next) participantWriteChains.delete(userId); });
    return next;
}
const isAdmin = (userId) => ADMIN_IDS.map(String).includes(String(userId));

// Global rankings lock. This affects every participant, not just the admin
// who toggles it. The value is stored in Redis so it survives restarts.
const RANKINGS_HIDDEN_KEY = 'weekly:rankings:hidden';

async function areRankingsHidden() {
    return String((await R.redis.get(RANKINGS_HIDDEN_KEY)) ?? '').trim() === '1';
}

function leaderboardSealedEmbed() {
    return new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('🤫 THE LEADERBOARD IS SEALED!')
        .setDescription([
            'The weekly standings are currently confidential.',
            '',
            '🏆 No leaderboard previews. No individual rankings. No spoilers.',
            '',
            'All results will be revealed during the official announcement.',
        ].join('\n'))
        .setFooter({ text: 'Weekly World Quiz • Rankings Temporarily Hidden' })
        .setTimestamp();
}

function hideRankCommand() {
    return new SlashCommandBuilder()
        .setName('hide')
        .setDescription('Seal weekly rankings for everyone')
        .addSubcommand((subcommand) => subcommand
            .setName('rank')
            .setDescription('Hide the leaderboard and all individual ranks globally'));
}

function unhideRankCommand() {
    return new SlashCommandBuilder()
        .setName('unhide')
        .setDescription('Reveal weekly rankings for everyone')
        .addSubcommand((subcommand) => subcommand
            .setName('rank')
            .setDescription('Restore leaderboard and individual rank visibility globally'));
}

async function handleRankPrivacyCommand(interaction) {
    if (!isAdmin(interaction.user.id)) {
        weeklyLogs.blocked(interaction.user, 'not authorized to change global ranking visibility');
        return interaction.reply({
            content: '❌ Only weekly admins can change global ranking visibility.',
            flags: MessageFlags.Ephemeral,
        });
    }

    const action = interaction.options?.getString('action') || interaction.commandName;
    const shouldHide = action === 'hide';

    // /weekly is normally deferred by handleWeeklyCommand (or index.js).
    // Only acknowledge here when this handler is called directly.
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    try {
        if (shouldHide) {
            await R.redis.set(RANKINGS_HIDDEN_KEY, '1');
        } else {
            await R.redis.del(RANKINGS_HIDDEN_KEY);
        }

        weeklyLogs.action(
            shouldHide ? 'Global rankings sealed' : 'Global rankings revealed',
            weeklyLogs.formatUser(interaction.user),
        );

        return interaction.editReply({
            content: shouldHide
                ? '🔒 **Weekly rankings are now sealed for everyone.**\n\nThe public leaderboard, My Ranking, profile rank, and challenge-result rank are hidden until `/unhide rank` is used.'
                : '🔓 **Weekly rankings are now visible to everyone.**\n\nThe leaderboard, My Ranking, profile rank, and challenge-result rank have been restored.',
        });
    } catch (error) {
        console.error('[weekly] global rank visibility update failed:', error.message || error);
        return interaction.editReply('❌ Could not update ranking visibility. Please try again.');
    }
}

function weeklyCommand() {
    return new SlashCommandBuilder()
        .setName('weekly')
        .setDescription('Manage the Weekly World Quiz competition')
        .addStringOption((option) => option
            .setName('action')
            .setDescription('Choose what to do')
            .setRequired(true)
            .addChoices(
                { name: 'Start', value: 'start' },
                // { name: 'End', value: 'end' },
                { name: 'Participants List', value: 'leader' },
                { name: 'Reset user attempt (one day)', value: 'resetday' },
                { name: 'Delete all user data', value: 'deleteuser' },
                { name: 'Hide Rankings', value: 'hide' },
                { name: 'Unhide Rankings', value: 'unhide' },
            ))
        .addUserOption((option) => option
            .setName('user')
            .setDescription('User to reset or delete (required for user actions)')
            .setRequired(false))
        .addStringOption((option) => option
            .setName('date')
            .setDescription('UTC date YYYY-MM-DD for resetday; defaults to today')
            .setRequired(false));
}

// Daily challenge boundary is UTC/GMT+0, not a rolling 24-hour window.
function getDayKey(state) {
    return `${state.competitionId}:date-${utcDateKey()}`;
}

async function ensureUserDailyRecords(userId, state) {
    const records = await R.initializeDailyRecords(userId, state);
    // Reconcile pre-existing attempts when this feature is introduced mid-event.
    for (const daily of records) {
        const dayKey = `${state.competitionId}:date-${daily.date}`;
        const attempt = await R.getAttempt(userId, dayKey);
        if (!attempt) continue;
        const answers = Array.isArray(attempt.answers) ? attempt.answers : [];
        const quizPoints = answers.reduce((sum, answer) => sum + (Number(answer.pointsDelta) || 0), 0);
        const completed = attempt.status === 'completed';
        const next = {
            ...daily,
            status: completed ? 'completed' : (attempt.status === 'active' || attempt.status === 'registered' ? 'in_progress' : daily.status),
            questionsAnswered: Number(attempt.answered) || answers.length,
            correctAnswers: Number(attempt.correct) || 0,
            incorrectAnswers: Number(attempt.incorrect) || 0,
            timedOut: Number(attempt.timedOut) || 0,
            quizPoints,
            streakBonus: Number(attempt.streakBonus) || 0,
            attemptId: attempt.attemptId || daily.attemptId || null,
            missedAttemptUsed: Boolean(daily.missedAttemptUsed || (attempt.isMissedAttempt && completed)),
            restoreStatus: attempt.isMissedAttempt ? (completed ? 'used' : 'in_progress') : daily.restoreStatus,
            updatedAt: Date.now(),
        };
        if (JSON.stringify(next) !== JSON.stringify(daily)) {
            await R.setDailyRecord(userId, state.competitionId, daily.date, next);
        }
    }
    return R.getDailyRecords(userId, state.competitionId);
}

async function updateDailyRecordFromAttempt(attempt, extra = {}) {
    const date = String(attempt?.dayKey || '').split(':date-')[1];
    if (!date || !attempt?.userId || !attempt?.competitionId) return null;
    const state = await R.getState();
    const existing = await R.getDailyRecord(attempt.userId, attempt.competitionId, date);
    const startDate = state?.startedAt ? new Date(state.startedAt).toISOString().slice(0, 10) : date;
    const dayNumber = Math.floor((Date.parse(`${date}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86400000) + 1;
    const current = existing || {
        userId: String(attempt.userId), competitionId: String(attempt.competitionId), date,
        dayNumber, status: 'pending', questionsAnswered: 0, correctAnswers: 0,
        incorrectAnswers: 0, timedOut: 0, quizPoints: 0, streakBonus: 0,
        missedAttemptUsed: false, restoreStatus: 'available', createdAt: Date.now(),
    };
    const answers = Array.isArray(attempt.answers) ? attempt.answers : [];
    const quizPoints = answers.reduce((sum, answer) => sum + (Number(answer.pointsDelta) || 0), 0);
    const completed = attempt.status === 'completed';
    const next = {
        ...current,
        status: completed ? 'completed' : 'in_progress',
        questionsAnswered: Number(attempt.answered) || answers.length,
        correctAnswers: Number(attempt.correct) || 0,
        incorrectAnswers: Number(attempt.incorrect) || 0,
        timedOut: Number(attempt.timedOut) || 0,
        quizPoints,
        streakBonus: Number(attempt.streakBonus) || 0,
        missedAttemptUsed: Boolean(current.missedAttemptUsed || (attempt.isMissedAttempt && completed)),
        restoreStatus: attempt.isMissedAttempt ? (completed ? 'used' : 'in_progress') : (current.restoreStatus || 'available'),
        attemptId: attempt.attemptId || current.attemptId || null,
        updatedAt: Date.now(),
        ...extra,
    };
    return R.setDailyRecord(attempt.userId, attempt.competitionId, date, next);
}

async function startWeekly(interaction) {
    weeklyLogs.action('START requested', weeklyLogs.formatUser(interaction.user));
    if (!isAdmin(interaction.user.id)) {
        weeklyLogs.blocked(interaction.user, 'not authorized to start the weekly competition');
        return interaction.editReply({
            content: '❌ You are not authorized to manage the weekly competition.',
            embeds: [],
            components: [],
        });
    }

    try {
        const existing = await R.getState();
        if (existing) {
            weeklyLogs.blocked(interaction.user, 'a weekly event already exists', `status=${existing.status}`);
            const message = existing.status === 'active'
                ? '⚠️ A weekly competition is already active.'
                : '⚠️ A completed weekly event is still saved. Use `/weekly end` to clear it before starting another.';
            return interaction.editReply({ content: message, embeds: [], components: [] });
        }

        // Participants receive questions from the local JSON bank, tracked per player.
        const startedAt = Date.now();
        const state = {
            competitionId: crypto.randomUUID(),
            status: 'active',
            startedAt,
            // Seven UTC calendar days: records are Day 1 through Day 7, ending at the next UTC midnight.
            endsAt: (() => {
                const end = new Date(startedAt);
                end.setUTCHours(0, 0, 0, 0);
                end.setUTCDate(end.getUTCDate() + 7);
                return end.getTime();
            })(),
            startedBy: interaction.user.id,
            questionsPerParticipant: QUESTIONS_PER_ATTEMPT,
        };

        await R.setState(state);
        weeklyLogs.action('Competition started', `by=${weeklyLogs.formatUser(interaction.user)} | competitionId=${state.competitionId} | endsAt=${new Date(state.endsAt).toISOString()} | rewards=1000/750/550/400/300 Mora`);
        stateCache = state;
        // Do not start AI generation while a player is in a quiz. Refill is checked
        // after a participant's final score has been displayed.
        // As requested, /weekly start sends only the participation embed.
        await interaction.editReply({
            embeds: [participationEmbed(state, Number(await R.redis.scard(R.keys.participants())) || 0)],
            components: participationComponents(),
            allowedMentions: { parse: [] },
        });
        const publicMessage = await interaction.fetchReply().catch(() => null);
        if (publicMessage) {
            state.announcementChannelId = publicMessage.channelId;
            state.announcementMessageId = publicMessage.id;
            await R.setState(state);
            stateCache = state;
        }
        startWeeklyScheduler(interaction.client, recoverExpiredAttempts);
    } catch (error) {
        console.error('[weekly] start failed:', error.message || error);
        await interaction.editReply({
            content: `❌ Could not start the weekly event: ${String(error.message || error).slice(0, 700)}\nNo competition was started.`,
            embeds: [],
            components: [],
        }).catch(() => { });
    }
}

async function updateParticipationMessage(client, state) {
    if (!state?.announcementChannelId || !state?.announcementMessageId) return;
    try {
        const [channel, participantCount] = await Promise.all([
            client.channels.fetch(state.announcementChannelId),
            R.redis.scard(R.keys.participants()),
        ]);
        const message = channel && await channel.messages.fetch(state.announcementMessageId);
        if (!message) return;
        await message.edit({
            embeds: [participationEmbed(state, Number(participantCount) || 0)],
            components: participationComponents(state.status !== 'active'),
            allowedMentions: { parse: [] },
        });
    } catch (error) {
        console.error('[weekly] participation embed update failed:', error.message || error);
    }
}

async function beginAttempt(interaction, requestedDayKey = null) {
    const userId = interaction.user.id;

    // weeklyLogs.action(
    //     'Participate clicked',
    //     weeklyLogs.formatUser(interaction.user)
    // );

    // Reuse the process-local state snapshot when available; it is refreshed by
    // competition start/end handlers. Fall back to Redis after a restart.
    const state = stateCache || await R.getState();

    if (!state || state.status !== 'active' || Date.now() >= state.endsAt) {
        weeklyLogs.blocked(interaction.user, 'no active weekly competition');
        return interaction.editReply({
            content: '❌ There is no active weekly competition right now.',
            embeds: [],
            components: [],
        });
    }

    const todayDayKey = getDayKey(state);
    const dayKey = requestedDayKey || todayDayKey;

    if (requestedDayKey) {
        const datePart = String(requestedDayKey).split(':date-')[1];
        const todayDate = utcDateKey();
        const startDate = new Date(state.startedAt).toISOString().slice(0, 10);

        const dailyRecord = datePart
            ? await R.getDailyRecord(userId, state.competitionId, datePart)
            : null;
        if (
            !datePart ||
            datePart >= todayDate ||
            datePart < startDate ||
            requestedDayKey.split(':date-')[0] !== String(state.competitionId) ||
            !dailyRecord || dailyRecord.status === 'completed' || dailyRecord.missedAttemptUsed
        ) {
            return interaction.editReply({
                content: 'That missed challenge date is not available.',
                embeds: [],
                components: [],
            });
        }
    }

    const cacheKey = attemptCacheKey(userId, dayKey);
    const lockKey = R.keys.operationLock(userId, dayKey);
    const lock = await R.acquireLock(lockKey, 30);

    if (!lock) {
        weeklyLogs.blocked(
            interaction.user,
            'challenge lock unavailable; another operation is running'
        );

        return interaction.editReply({
            content: '⏳ Your challenge is being updated. Please try again in a moment.',
            embeds: [],
            components: [],
        });
    }

    try {
        // The lock prevents a competing start/end operation for this user/day;
        // avoid a second serial Redis state read when the cached state is current.
        const currentState = stateCache || await R.getState();

        if (
            !currentState ||
            currentState.status !== 'active' ||
            Date.now() >= currentState.endsAt
        ) {
            weeklyLogs.blocked(
                interaction.user,
                'competition became unavailable before challenge start'
            );

            return interaction.editReply({
                content: '❌ There is no active weekly competition right now.',
                embeds: [],
                components: [],
            });
        }

        const reattemptKey =
            `${R.keys.participant(userId)}:reattempt:${dayKey}`;

        // These reads do not depend on one another, so do them concurrently.
        const [existingAttempt, reattemptStatus] = await Promise.all([
            R.getAttempt(userId, dayKey),
            R.redis.get(reattemptKey),
        ]);
        const isReattempt = reattemptStatus === 'available';
        const reattemptBonusKey = `${reattemptKey}:bonus`;
        const preservedStreakBonus = isReattempt
            ? Math.max(0, Number(await R.redis.get(reattemptBonusKey)) || 0)
            : 0;

        // A used reattempt cannot be started again if the original attempt
        // no longer exists in Redis.
        if (!existingAttempt && reattemptStatus === 'used') {
            return interaction.editReply({
                content: '🔒 Your one reattempt for today has already been used.',
                embeds: [],
                components: [],
            });
        }

        // Completed attempts can be replaced only when a reattempt is available.
        if (existingAttempt?.status === 'completed' && !isReattempt) {
            weeklyLogs.blocked(
                interaction.user,
                'daily challenge already completed',
                `dayKey=${dayKey}`
            );

            attemptCache.set(cacheKey, existingAttempt);

            return interaction.editReply({
                content: '✅ You have already completed today’s challenge. Come back tomorrow!',
                embeds: [],
                components: [],
            });
        }

        // If an attempt is active, recover its existing question instead of
        // creating another attempt or replacing the question.
        if (existingAttempt?.status === 'active' && existingAttempt.questions?.length) {
            const attempt = existingAttempt;
            const question = attempt.questions[attempt.questions.length - 1];

            const questionStartedAt = Number(attempt.lastQuestionAt) || Date.now();
            const deadline = questionStartedAt + QUESTION_TIME_MS;
            const remainingTime = deadline - Date.now();

            // Do not restart the timer for a question that has already expired.
            if (remainingTime <= 0) {
                attemptCache.set(cacheKey, attempt);

                return interaction.editReply({
                    content: '⏳ Your current question has expired. Please wait for the challenge to update before trying again.',
                    embeds: [],
                    components: [],
                });
            }

            attempt.webhook = webhookDetails(interaction);
            attempt.responseMessageId = '@original';

            attemptCache.set(cacheKey, attempt);
            await R.setAttempt(userId, dayKey, attempt);

            await interaction.editReply({
                content: '',
                embeds: [
                    questionEmbed(
                        question,
                        attempt.questionIndex,
                        attempt.totalQuestions,
                        deadline
                    ),
                ],
                components: answerRows(
                    attempt.attemptId,
                    question,
                    attempt.questionIndex,
                    false,
                    attempt.dayKey
                ),
            });

            const message = await interaction.fetchReply().catch(() => null);

            if (message) {
                attempt.responseMessageId = message.id;
            }

            attemptCache.set(cacheKey, attempt);
            await R.setAttempt(userId, dayKey, attempt);

            liveResponses.set(attempt.attemptId, {
                webhook: interaction.webhook,
                messageId: message?.id || '@original',
            });

            // Preserve the original timer start so the question does not
            // receive extra time when the player resumes it.
            scheduleTimeout(
                interaction.client,
                userId,
                dayKey,
                attempt.attemptId,
                attempt.questionIndex,
                questionStartedAt
            );

            weeklyLogs.action(
                'Attempt resumed',
                `${weeklyLogs.formatUser(interaction.user)} | attempt=${attempt.attemptId} | dayKey=${dayKey}`
            );

            return;
        }

        let attempt = existingAttempt;
        let question;

        try {
            // Question history lookup/reservation and participant registration are
            // independent; overlap their Redis latency instead of waiting serially.
            const [preparedQuestion] = await Promise.all([
                takeReadyQuestion(
                    userId,
                    getAttemptCategories(attempt),
                    DIFFICULTY_SEQUENCE[Number(attempt?.questionIndex) || 0] || 'hard'
                ),
                R.join(userId, interaction.user.globalName || interaction.user.username),
            ]);
            question = preparedQuestion;
        } catch (error) {
            console.error(
                '[weekly] question unavailable while starting/resuming:',
                error.message || error
            );

            const exhausted = String(error.message || '').includes('used every question');

            return interaction.editReply({
                content: exhausted
                    ? '🏁 You have used every available Weekly question. No questions were repeated.'
                    : '⚠️ Questions are temporarily unavailable. Your progress is safe; please try again shortly.',
                embeds: [],
                components: [],
            });
        }

        const attemptCreatedAt = Date.now();

        // Daily-record reconciliation is not needed to render the question, so it
        // runs off the critical path.
        ensureUserDailyRecords(userId, currentState).catch((error) =>
            console.error('[weekly] daily record initialization failed:', error.message || error)
        );

        attempt = {
            attemptId: crypto.randomUUID().slice(0, 12),
            userId,
            competitionId: currentState.competitionId,
            dayKey,
            isReattempt,
            // Carry forward the original day's bonus without awarding it twice.
            preservedStreakBonus: isReattempt ? preservedStreakBonus : 0,
            isMissedAttempt: Boolean(requestedDayKey),
            status: 'active',
            questionIndex: 0,
            totalQuestions: QUESTIONS_PER_ATTEMPT,
            questions: [question],
            points: 0,
            correct: 0,
            incorrect: 0,
            timedOut: 0,
            answered: 0,
            startedAt: attemptCreatedAt,
            lastQuestionAt: attemptCreatedAt,
            answers: [],
            responseMessageId: '@original',
            webhook: webhookDetails(interaction),
        };

        // Consume the reattempt only after a replacement attempt has been
        // successfully prepared.
        attemptCache.set(cacheKey, attempt);
        await R.setAttempt(userId, dayKey, attempt);
        // Daily-record bookkeeping is not needed to render or answer the question.
        // Keep the UI responsive and reconcile the record asynchronously.
        updateDailyRecordFromAttempt(
            attempt,
            requestedDayKey ? { restoreStartedAt: attemptCreatedAt } : {}
        ).catch((error) => console.error('[weekly] daily record background save failed:', error.message || error));

        if (isReattempt) {
            await R.redis.set(reattemptKey, 'used', {
                ex: 8 * 24 * 60 * 60,
            });
        }

        weeklyLogs.action(
            isReattempt ? 'Reattempt started' : 'Attempt started',
            `${weeklyLogs.formatUser(interaction.user)} | attempt=${attempt.attemptId} | dayKey=${dayKey}`
        );

        weeklyLogs.question(
            interaction.user,
            attempt.questionIndex + 1,
            attempt.totalQuestions,
            question.question,
            attempt.attemptId
        );

        // Start the visible timer only when the question is ready to be shown.
        // Redis/setup latency above must not consume the player's 15 seconds.
        const questionStartedAt = Date.now();
        attempt.lastQuestionAt = questionStartedAt;

        await interaction.editReply({
            content: '',
            embeds: [
                questionEmbed(
                    question,
                    attempt.questionIndex,
                    attempt.totalQuestions,
                    questionStartedAt + QUESTION_TIME_MS
                ),
            ],
            components: answerRows(
                attempt.attemptId,
                question,
                attempt.questionIndex,
                false,
                attempt.dayKey
            ),
        });

        // The original interaction response is editable without an extra fetchReply round-trip.
        // Keep the in-memory attempt authoritative for immediate answer handling.
        liveResponses.set(attempt.attemptId, {
            webhook: interaction.webhook,
            messageId: '@original',
        });
        persistAttemptInBackground(attempt);

        scheduleTimeout(
            interaction.client,
            userId,
            dayKey,
            attempt.attemptId,
            attempt.questionIndex,
            questionStartedAt
        );

        if (!existingAttempt) {
            setImmediate(() =>
                updateParticipationMessage(
                    interaction.client,
                    currentState
                ).catch(() => { })
            );
        }
    } finally {
        await R.releaseLock(lockKey, lock).catch(() => { });
    }
}



function scheduleTimeout(client, userId, dayKey, attemptId, questionIndex, questionStartedAt) {
    // A timer is valid only for the exact question index and start timestamp it was created for.
    const delay = Math.max(0, questionStartedAt + QUESTION_TIME_MS - Date.now()) + 50;
    const timer = setTimeout(() => {
        processAnswer(client, {
            userId,
            dayKey,
            attemptId,
            choice: null,
            timeout: true,
            expectedQuestionIndex: questionIndex,
            expectedQuestionStartedAt: questionStartedAt,
        }).catch((error) => console.error('[weekly] question timeout failed:', error.message || error));
    }, delay);
    timer.unref?.();
}

async function updateOriginal(attemptId, interaction, payload, attempt = null) {
    if (interaction) {
        try {
            await interaction.editReply(payload);
            return true;
        } catch (error) {
            console.error(`[weekly] could not edit quiz response attempt=${attemptId}:`, error.message || error);
            return false;
        }
    }

    const live = liveResponses.get(attemptId);
    if (live) {
        try {
            await live.webhook.editMessage(live.messageId, payload);
            return true;
        } catch (error) {
            // Discord interaction webhook tokens expire (normally after 15 minutes).
            // The quiz result is already saved; an expired ephemeral response must
            // not make timeout recovery or answer processing crash.
            if (Number(error.code) === 50027 || Number(error.code) === 10015) {
                console.warn(`[weekly] quiz response token expired; result remains saved (attempt=${attemptId}).`);
                liveResponses.delete(attemptId);
                return false;
            }
            console.error(`[weekly] live quiz response edit failed attempt=${attemptId}:`, error.message || error);
            return false;
        }
    }

    // The interaction webhook is persisted with the attempt, allowing timeout edits
    // to recover after a process restart while Discord's interaction token is valid.
    if (attempt?.webhook?.id && attempt?.webhook?.token) {
        try {
            const webhook = new WebhookClient({ id: attempt.webhook.id, token: attempt.webhook.token });
            await webhook.editMessage('@original', payload);
            return true;
        } catch (error) {
            if (Number(error.code) === 50027 || Number(error.code) === 10015) {
                console.warn(`[weekly] saved quiz response token expired; result remains saved (attempt=${attemptId}).`);
                return false;
            }
            console.error(`[weekly] saved quiz response edit failed attempt=${attemptId}:`, error.message || error);
            return false;
        }
    }

    return false;
}

async function processAnswer(client, input) {
    const {
        userId,
        dayKey,
        attemptId,
        choice,
        interaction = null,
        expectedQuestionIndex = null,
        expectedQuestionStartedAt = null,
        pressedAt = null,
    } = input;

    let timeout = Boolean(input.timeout);
    const cacheKey = attemptCacheKey(userId, dayKey);
    const lockKey = R.keys.operationLock(userId, dayKey);
    const lock = await R.acquireLock(lockKey, 35);

    if (!lock) {
        weeklyLogs.blocked(
            { id: userId, username: userId },
            'answer processing lock unavailable',
            `attempt=${attemptId}`
        );
        return false;
    }

    try {
        const attempt = attemptCache.get(cacheKey) || await R.getAttempt(userId, dayKey);

        if (
            !attempt ||
            attempt.status !== 'active' ||
            attempt.attemptId !== attemptId
        ) {
            weeklyLogs.blocked(
                { id: userId, username: userId },
                'attempt missing, inactive, or mismatched',
                `attempt=${attemptId}`
            );
            return false;
        }

        if (
            expectedQuestionIndex !== null &&
            attempt.questionIndex !== expectedQuestionIndex
        ) {
            weeklyLogs.blocked(
                { id: userId, username: userId },
                'stale question index',
                `attempt=${attemptId} | expected=${expectedQuestionIndex} | current=${attempt.questionIndex}`
            );
            return false;
        }

        if (
            expectedQuestionStartedAt !== null &&
            attempt.lastQuestionAt !== expectedQuestionStartedAt
        ) {
            weeklyLogs.blocked(
                { id: userId, username: userId },
                'stale question timer',
                `attempt=${attemptId}`
            );
            return false;
        }

        // Capture the click timestamp in the button handler, before any Redis/network waits.
        const answerReceivedAt = Number.isFinite(Number(pressedAt)) ? Number(pressedAt) : Date.now();
        const elapsedMs = Math.max(0, answerReceivedAt - attempt.lastQuestionAt);

        if (!timeout && elapsedMs >= QUESTION_TIME_MS) {
            timeout = true;
        }

        // Prefer same-process memory snapshots to avoid unnecessary Redis round trips.
        // Redis remains the fallback after a restart or cache miss.
        const [state, participant] = await Promise.all([
            stateCache || R.getState(),
            participantCache.get(userId) || R.getParticipant(userId),
        ]);

        stateCache = state;

        if (
            !state ||
            state.competitionId !== attempt.competitionId ||
            state.status !== 'active' ||
            Date.now() >= state.endsAt
        ) {
            weeklyLogs.blocked(
                { id: userId, username: userId },
                'competition ended or changed during answer',
                `attempt=${attemptId}`
            );
            return false;
        }

        const questions = Array.isArray(attempt.questions)
            ? attempt.questions
            : [];

        const currentQuestion = questions[0];

        if (!currentQuestion) {
            return false;
        }

        const isCorrect =
            !timeout &&
            Number(choice) === currentQuestion.correctAnswer;

        const difficulty = String(
            currentQuestion.difficulty || 'easy'
        ).toLowerCase();

        const multiplier = DIFFICULTY_MULTIPLIERS[difficulty] || 1;
        const basePoints = scoreForAnswer(elapsedMs, QUESTION_TIME_MS);

        const pointsDelta = timeout
            ? 0
            : isCorrect
                ? Math.round(basePoints * multiplier)
                : -Math.round(BASE_INCORRECT_PENALTY * multiplier);

        if (timeout) {
            weeklyLogs.timeout(
                { id: userId, username: userId },
                attempt.questionIndex + 1,
                attemptId
            );
        } else {
            weeklyLogs.answer(
                { id: userId, username: userId },
                attempt.questionIndex + 1,
                choice,
                isCorrect,
                pointsDelta,
                elapsedMs,
                attemptId
            );
        }

        // Update the attempt.
        attempt.points = (Number(attempt.points) || 0) + pointsDelta;
        attempt.answered = (Number(attempt.answered) || 0) + 1;

        if (timeout) {
            attempt.timedOut = (Number(attempt.timedOut) || 0) + 1;
        } else if (isCorrect) {
            attempt.correct = (Number(attempt.correct) || 0) + 1;
        } else {
            attempt.incorrect = (Number(attempt.incorrect) || 0) + 1;
        }

        attempt.answers = Array.isArray(attempt.answers)
            ? attempt.answers
            : [];

        attempt.answers.push({
            questionId: currentQuestion.id,
            choice: timeout ? null : Number(choice),
            correct: isCorrect,
            timeout,
            pointsDelta,
            difficulty,
            multiplier,
            elapsedMs,
        });

        questions.shift();
        attempt.questions = questions;
        attempt.questionIndex += 1;

        attemptCache.set(cacheKey, attempt);

        // Calculate the participant's answer score.
        // The final streak bonus is added separately below.
        let updatedParticipant = participant
            ? {
                ...participant,
                points: (Number(participant.points) || 0) + pointsDelta,
                correct:
                    (Number(participant.correct) || 0) +
                    (isCorrect ? 1 : 0),
                incorrect:
                    (Number(participant.incorrect) || 0) +
                    (!timeout && !isCorrect ? 1 : 0),
                answered: (Number(participant.answered) || 0) + 1,
            }
            : null;

        if (updatedParticipant) {
            participantCache.set(userId, updatedParticipant);
        }
        // Persist bookkeeping off the critical UI path; answer feedback should not wait on Redis.
        updateDailyRecordFromAttempt(attempt).catch((error) =>
            console.error('[weekly] daily record background save failed:', error.message || error)
        );

        R.appendPointsHistory(userId, {
            at: Date.now(),
            dayKey,
            type: timeout
                ? 'timeout'
                : isCorrect
                    ? 'correct'
                    : 'incorrect',
            delta: pointsDelta,
            balance: updatedParticipant?.points ?? 0,
            difficulty,
            questionId: currentQuestion.id,
        }).catch((error) => {
            console.error(
                '[weekly] points history save failed:',
                error.message || error
            );
        });

        // Prepare the next question while feedback is visible, instead of making
        // players wait for Redis/question selection after the feedback delay.
        const nextQuestionPromise = attempt.questionIndex < attempt.totalQuestions
            ? takeReadyQuestion(
                userId,
                getAttemptCategories(attempt),
                DIFFICULTY_SEQUENCE[attempt.questionIndex] || 'hard'
            ).then((question) => ({ question }), (error) => ({ error }))
            : null;

        // Show feedback for the final answer too, before switching to results.
        // Previously the final-question branch skipped this feedback embed entirely.
        if (attempt.questionIndex >= attempt.totalQuestions) {
            await updateOriginal(
                attemptId,
                interaction,
                {
                    content: '',
                    embeds: [
                        answerFeedbackEmbed({
                            correct: isCorrect,
                            timeout,
                            pointsDelta,
                            elapsedMs,
                            question: currentQuestion,
                            questionNumber: attempt.questionIndex,
                        }),
                    ],
                    components: [],
                },
                attempt
            ).catch(() => { });

            // Keep the final answer feedback visible before showing the results.
            await new Promise((resolve) => setTimeout(resolve, 3000));
        }

        // Finish the challenge.
        if (attempt.questionIndex >= attempt.totalQuestions) {
            const attemptDate =
                String(attempt.dayKey || '').split(':date-')[1] ||
                utcDateKey();

            const previousDateObject = new Date(
                `${attemptDate}T00:00:00.000Z`
            );

            previousDateObject.setUTCDate(
                previousDateObject.getUTCDate() - 1
            );

            const previousDate = previousDateObject
                .toISOString()
                .slice(0, 10);

            const previousDayKey =
                `${attempt.competitionId}:date-${previousDate}`;

            const previousAttempt = await R.getAttempt(
                userId,
                previousDayKey
            );

            const nextStreak =
                previousAttempt?.status === 'completed'
                    ? (
                        Number(previousAttempt.streak) ||
                        Number(participant?.currentStreak) ||
                        1
                    ) + 1
                    : 1;

            // Every completed replacement earns a newly calculated daily bonus.
            // The old attempt's bonus was reversed when the reattempt was confirmed.
            const streakBonus = attempt.isMissedAttempt ? 0 : 25 * nextStreak;

            attempt.streak = attempt.isMissedAttempt ? 0 : nextStreak;
            attempt.streakBonus = streakBonus;

            // Include the bonus in the attempt's final score.
            attempt.points =
                (Number(attempt.points) || 0) + streakBonus;

            if (updatedParticipant) {
                if (!attempt.isMissedAttempt) {
                    updatedParticipant.points =
                        (Number(updatedParticipant.points) || 0) + streakBonus;
                    updatedParticipant.streakBonusTotal =
                        (Number(updatedParticipant.streakBonusTotal) || 0) + streakBonus;
                    if (attemptDate === utcDateKey()) updatedParticipant.currentStreak = nextStreak;
                }
                if (!attempt.isReattempt) {
                    updatedParticipant.challengesCompleted =
                        (Number(updatedParticipant.challengesCompleted) || 0) + 1;
                }
                participantCache.set(userId, updatedParticipant);
            }

            attempt.status = 'completed';
            attempt.completedAt = Date.now();
            await updateDailyRecordFromAttempt(attempt);

            await updateOriginal(
                attemptId,
                interaction,
                {
                    content: 'Calculating your final ranking…',
                    embeds: [],
                    components: [],
                },
                attempt
            ).catch(() => { });

            // Save the final participant balance before calculating the rank.
            await Promise.all([
                persistAttemptInBackground(attempt),
                updatedParticipant
                    ? saveParticipantInBackground(updatedParticipant)
                    : Promise.resolve(),
                R.appendAttemptHistory(userId, attempt),
                R.appendPointsHistory(userId, {
                    at: Date.now(),
                    dayKey,
                    type: attempt.isMissedAttempt ? 'missed-attempt-no-bonus' : (attempt.isReattempt ? 'reattempt-streak-bonus' : 'streak-bonus'),
                    delta: streakBonus,
                    balance: updatedParticipant?.points ?? 0,
                    note: attempt.isMissedAttempt
                        ? 'Restored missed attempt; no daily streak bonus'
                        : attempt.isReattempt
                            ? `Replacement attempt day ${nextStreak} streak bonus`
                            : `Day ${nextStreak} streak bonus`,
                }),
            ]);

            // Reload the saved participant instead of trusting the local object.
            const savedParticipant = await R.getParticipant(userId);

            if (
                updatedParticipant &&
                Number(savedParticipant?.points) !==
                Number(updatedParticipant.points)
            ) {
                console.error(
                    '[weekly] POINTS MISMATCH',
                    JSON.stringify({
                        userId,
                        attemptId,
                        expectedPoints: updatedParticipant.points,
                        savedPoints: savedParticipant?.points ?? null,
                        streakBonus,
                        pointsDelta,
                    })
                );
            }

            // Refresh the cache with the actual saved Redis record.
            if (savedParticipant) {
                participantCache.set(userId, savedParticipant);
            }

            const leaderboard = await R.getLeaderboard(10000);

            const rank =
                leaderboard.findIndex(
                    (player) => player.userId === userId
                ) + 1;

            weeklyLogs.action(
                'Attempt completed',
                `user=${userId} | attempt=${attemptId} | ` +
                `questionPoints=${attempt.points - streakBonus} | ` +
                `streakBonus=${streakBonus} | ` +
                `attemptPoints=${attempt.points} | ` +
                `participantPoints=${savedParticipant?.points ?? 'missing'} | ` +
                `correct=${attempt.correct} | ` +
                `incorrect=${attempt.incorrect} | ` +
                `timedOut=${attempt.timedOut} | rank=${rank}`
            );

            const rankingsHidden = await areRankingsHidden();

            await updateOriginal(
                attemptId,
                interaction,
                {
                    content: '',
                    embeds: [
                        resultEmbed(
                            attempt,
                            savedParticipant || updatedParticipant,
                            rank,
                            rankingsHidden
                        ),
                    ],
                    components: [],
                },
                attempt
            );

            liveResponses.delete(attemptId);
            return true;
        }

        // Edit Discord first; Redis writes should not delay answer feedback.
        await updateOriginal(
            attemptId,
            interaction,
            {
                content: '',
                embeds: [
                    answerFeedbackEmbed({
                        correct: isCorrect,
                        timeout,
                        pointsDelta,
                        elapsedMs,
                        question: currentQuestion,
                        questionNumber: attempt.questionIndex,
                    }),
                ],
                components: [],
            },
            attempt
        ).catch(() => { });

        // Persist from the updated in-memory snapshot in the background.
        // Write chains preserve order if another answer/save arrives meanwhile.
        persistAttemptInBackground(attempt);
        if (updatedParticipant) saveParticipantInBackground(updatedParticipant);

        // Display answer feedback while the background writes complete.
        await new Promise((resolve) => setTimeout(resolve, 3000));

        attempt.lastQuestionAt = Date.now();

        let nextQuestion;

        try {
            // Normally preloading finishes while answer feedback is visible. If it
            // takes longer, show progress rather than leaving an empty message.
            const preparedQuickly = await Promise.race([
                nextQuestionPromise,
                new Promise((resolve) => setTimeout(() => resolve(null), 350)),
            ]);
            if (preparedQuickly === null) {
                await updateOriginal(attemptId, interaction, {
                    content: '⏳ **Preparing the next question…**',
                    embeds: [],
                    components: [],
                }, attempt).catch(() => { });
            }
            const preparedNext = preparedQuickly || await nextQuestionPromise;
            if (preparedNext?.error) throw preparedNext.error;
            nextQuestion = preparedNext?.question;
            if (!nextQuestion) throw new Error('The next question could not be prepared.');
        } catch (error) {
            attempt.questions = [];

            await Promise.all([
                persistAttemptInBackground(attempt),
                updatedParticipant
                    ? saveParticipantInBackground(updatedParticipant)
                    : Promise.resolve(),
            ]);

            const exhausted = String(error.message || '').includes(
                'used every question'
            );

            await updateOriginal(
                attemptId,
                interaction,
                {
                    content: exhausted
                        ? '🏁 You have used every available Weekly question. Your progress is saved; no question was repeated.'
                        : '⚠️ The next question is temporarily unavailable. Your progress is saved. Press **Participate** again to resume.',
                    embeds: [],
                    components: [],
                },
                attempt
            ).catch(() => { });

            liveResponses.delete(attemptId);
            return false;
        }

        attempt.questions = [nextQuestion];

        weeklyLogs.question(
            { id: userId, username: userId },
            attempt.questionIndex + 1,
            attempt.totalQuestions,
            nextQuestion.question,
            attemptId
        );

        const deadline = attempt.lastQuestionAt + QUESTION_TIME_MS;

        if (interaction) {
            attempt.webhook = webhookDetails(interaction);
        }

        await updateOriginal(
            attemptId,
            interaction,
            {
                content: '',
                embeds: [
                    questionEmbed(
                        nextQuestion,
                        attempt.questionIndex,
                        attempt.totalQuestions,
                        deadline
                    ),
                ],
                components: answerRows(
                    attemptId,
                    nextQuestion,
                    attempt.questionIndex,
                    false,
                    attempt.dayKey
                ),
            },
            attempt
        );

        scheduleTimeout(
            client,
            userId,
            dayKey,
            attemptId,
            attempt.questionIndex,
            attempt.lastQuestionAt
        );

        await Promise.all([
            persistAttemptInBackground(attempt),
            updatedParticipant
                ? saveParticipantInBackground(updatedParticipant)
                : Promise.resolve(),
        ]);

        return true;
    } catch (error) {
        console.error(
            `[weekly] processAnswer failed for user=${userId}, attempt=${attemptId}:`,
            error
        );
        throw error;
    } finally {
        await R.releaseLock(lockKey, lock).catch(() => { });
    }
}


async function recoverExpiredAttempts(client) {
    try {
        const attempts = await R.getActiveAttempts();
        const now = Date.now();
        for (const attempt of attempts) {
            if (!attempt || attempt.status !== 'active' || !attempt.questions?.length) continue;
            if (now - Number(attempt.lastQuestionAt || 0) < QUESTION_TIME_MS) continue;
            processAnswer(client, {
                userId: attempt.userId,
                dayKey: attempt.dayKey,
                attemptId: attempt.attemptId,
                choice: null,
                timeout: true,
                expectedQuestionIndex: attempt.questionIndex,
                expectedQuestionStartedAt: attempt.lastQuestionAt,
            }).catch((error) => console.error('[weekly] recovered timeout failed:', error.message || error));
        }
    } catch (error) {
        console.error('[weekly] timeout recovery scan failed:', error.message || error);
    }
}

async function handleWeeklyButton(interaction, client) {

    // Reattach restart-recovery callbacks whenever the bot receives a quiz button.
    startWeeklyScheduler(client, recoverExpiredAttempts);
    const customId = interaction.customId;
    const buttonNames = {
        'weekly:profile': 'My Profile',
        'weekly:my-profile': 'My Profile',
        'weekly:profile:history': 'Profile History',
        'weekly:points-history': 'Points History',
        'weekly:attempt-history': 'Attempt History',
        'weekly:missed': 'Missed Attempts',
        'weekly:missed:restore': 'Restore Missed Attempt',
        'weekly:reattempt': 'Reattempt',
        'weekly:reattempt:confirm': 'Confirm Reattempt',
        'weekly:reattempt:cancel': 'Cancel Reattempt',
        'weekly:leaderboard': 'Leaderboard',
        'weekly:my-ranking': 'Check My Ranking',
        'weekly:home': 'Home',
        'weekly:rules-guide': 'Rules & Guide',
        'weekly:participate': 'Participate',
        'weekly:challenge': 'Challenge',
        'weekly:ready': 'Start Challenge',
    };

    const buttonName = buttonNames[customId] || 'Other';

    weeklyLogs.action(`🎯 ${buttonName} │ 👤 ${interaction.user.globalName || interaction.user.username} │ 🆔 ${interaction.user.id}`);
    // Rules & Guide is a separate ephemeral response; quiz answer handling stays unchanged.
    if (customId === 'weekly:rules-guide') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply({ embeds: [rulesGuideEmbed()], components: [] });
    }

    if (customId === 'weekly:participate' || customId === 'weekly:challenge') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const state = await R.getState();
            if (!state || state.status !== 'active' || Date.now() >= state.endsAt) {
                await interaction.editReply({
                    content: '❌ There is no active weekly competition right now.',
                    embeds: [],
                    components: [],
                });
                return true;
            }

            // This reconciliation may involve several Redis round trips. It is
            // bookkeeping, so do it in the background rather than delaying the UI.
            ensureUserDailyRecords(interaction.user.id, state).catch((error) =>
                console.error('[weekly] daily record initialization failed:', error.message || error)
            );
            const todayDayKey = getDayKey(state);
            let existingAttempt = await R.getAttempt(interaction.user.id, todayDayKey);
            if (existingAttempt?.status === 'completed') {
                weeklyLogs.blocked(
                    interaction.user,
                    'daily challenge already completed',
                    `dayKey=${getDayKey(state)}`
                );

                await interaction.editReply({
                    content: '✅ You’ve already completed today’s challenge! Come back tomorrow or use your **one daily reattempt** via **My Profile → Reattempt**.\n\n📅 Have any missed challenges? You can attempt eligible missed days via **My Profile → Missed Attempts**!',
                    embeds: [],
                    embeds: [],
                    components: [],
                });
                return true;
            }
            if (existingAttempt?.status === 'active' && existingAttempt.questions?.length) {
                await interaction.editReply({
                    content: '⚠️ You already have a challenge in progress. Use your existing challenge message. If it was interrupted, wait for the current question timer to finish.',
                    embeds: [],
                    components: [],
                });
                return true;
            }

            // Create a persistent per-user/per-day record as soon as the user
            // participates, before they press Challenge. Past-day recovery is
            // only offered for dates with this record and unfinished progress.
            if (!existingAttempt) {
                existingAttempt = {
                    userId: interaction.user.id,
                    competitionId: state.competitionId,
                    dayKey: todayDayKey,
                    status: 'registered',
                    participatedAt: Date.now(),
                    startedAt: null,
                    points: 0,
                    correct: 0,
                    incorrect: 0,
                    timedOut: 0,
                    answered: 0,
                    questionIndex: 0,
                    totalQuestions: QUESTIONS_PER_ATTEMPT,
                    questions: [],
                    answers: [],
                };
                await R.setAttempt(interaction.user.id, todayDayKey, existingAttempt);
                attemptCache.set(attemptCacheKey(interaction.user.id, todayDayKey), existingAttempt);
            }
            // Keep the challenge-ready screen independent of daily-record writes.
            R.getDailyRecord(interaction.user.id, state.competitionId, utcDateKey())
                .then((todayRecord) => {
                    if (!todayRecord || todayRecord.status === 'completed') return null;
                    return R.setDailyRecord(interaction.user.id, state.competitionId, utcDateKey(), {
                        ...todayRecord,
                        status: 'in_progress',
                        participatedAt: todayRecord.participatedAt || Date.now(),
                        updatedAt: Date.now(),
                    });
                })
                .catch((error) => console.error('[weekly] participation record update failed:', error.message || error));

            await interaction.editReply({
                embeds: [challengeReadyEmbed()],
                components: challengeReadyComponents(),
            });
        } catch (error) {
            console.error('[weekly] challenge ready screen failed:', error.message || error);
            await interaction.editReply({
                content: '❌ Could not prepare the challenge. Please try again shortly.',
                embeds: [],
                components: [],
            }).catch(() => { });
        }
        return true;
    }

    if (customId === 'weekly:ready') {
        await interaction.deferUpdate();
        try {
            await interaction.editReply({
                content: '⏳ **Preparing your first question…** Your 15-second timer will start when the question appears.',
                embeds: [],
                components: [],
            });
            await beginAttempt(interaction);
        } catch (error) {
            console.error('[weekly] ready challenge start failed:', error.message || error);
            await interaction.editReply({
                content: '❌ Could not start the challenge. Please try again shortly.',
                embeds: [],
                components: [],
            }).catch(() => { });
        }
        return true;
    }

    if (customId === 'weekly:profile' || customId === 'weekly:my-profile' || customId === 'weekly:profile:history') {
        if (customId === 'weekly:profile:history') await interaction.deferUpdate();
        else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const state = await R.getState();
            if (!state) return interaction.editReply({ content: 'ℹ️ No weekly competition data is available yet.' });
            const rows = await R.getLeaderboard(10000);
            const participant = await R.getParticipant(interaction.user.id);
            const dayKey = getDayKey(state);
            const todayAttempt = await R.getAttempt(interaction.user.id, dayKey);
            const attempts = await R.getAttemptHistory(interaction.user.id, 100);
            const rankIndex = rows.findIndex((row) => String(row.userId) === String(interaction.user.id));
            const rank = rankIndex < 0 ? 0 : rankIndex + 1;

            // The leaderboard is sorted from highest to lowest points.
            // The player immediately above this user is rows[rankIndex - 1].
            const nextRankPoints = rankIndex > 0
                ? Number(rows[rankIndex - 1].points) || 0
                : null;

            const participantCount = Number(await R.redis.scard(R.keys.participants())) || 0;
            const rankingsHidden = await areRankingsHidden();

            await interaction.editReply({
                embeds: [profileEmbed({
                    user: interaction.user,
                    participant,
                    rank,
                    participantCount,
                    todayAttempt,
                    attempts,
                    rankingsHidden,
                    nextRankPoints,
                })],
                components: profileComponents(),
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            console.error('[weekly] profile load failed:', error.message || error);
            await interaction.editReply({ content: '❌ Could not load your profile right now.' }).catch(() => { });
        }
        return true;
    }

    if (customId.startsWith('weekly:points-history') || customId.startsWith('weekly:attempt-history')) {
        await interaction.deferUpdate();
        try {
            const isPoints = customId.startsWith('weekly:points-history');
            // IDs are weekly:<history-type>:<page-action>:<current-page>.
            // Also accept legacy weekly:<history-type>:<page> buttons.
            const idParts = customId.split(':');
            const pageAction = idParts[2];
            const parsedPage = pageAction === 'prev' || pageAction === 'next'
                ? Number(idParts[3]) || 0
                : Number(pageAction) || 0;
            const page = pageAction === 'prev'
                ? Math.max(0, parsedPage - 1)
                : pageAction === 'next'
                    ? parsedPage + 1
                    : Math.max(0, parsedPage);
            const pageSize = 5;
            const allRows = isPoints
                ? await R.getPointsHistory(interaction.user.id, 200)
                : await R.getAttemptHistory(interaction.user.id, 100);
            const rows = allRows.slice(page * pageSize, (page + 1) * pageSize);
            const description = isPoints
                ? (rows.length ? rows.map((row) => {
                    const delta = Number(row.delta) || 0;
                    const sign = delta > 0 ? '+' : '';
                    const date = Math.floor((Number(row.at) || Date.now()) / 1000);
                    return `• <t:${date}:f> — **${sign}${delta} points**\n  ${String(row.type || 'points').replaceAll('-', ' ')}${row.difficulty ? ` · ${row.difficulty}` : ''}${row.note ? ` · ${row.note}` : ''}\n  Balance: **${Number(row.balance) || 0}**`;
                }).join('\n\n') : (page ? 'No more point history.' : 'No point changes recorded yet.'))
                : (rows.length ? rows.map((row) => {
                    const date = Math.floor((Number(row.completedAt || row.startedAt) || Date.now()) / 1000);
                    const day = String(row.dayKey || '').split(':date-')[1] || 'Unknown date';
                    return `• **${day}** · <t:${date}:R>\n  **${Number(row.points) || 0} points** · ✅ ${row.correct || 0} · ❌ ${row.incorrect || 0} · ⏰ ${row.timedOut || 0}\n  ${row.isReattempt ? 'Reattempt' : row.isMissedAttempt ? 'Missed-day attempt' : 'Daily attempt'} · Streak bonus: **${Number(row.streakBonus) || 0}**`;
                }).join('\n\n') : (page ? 'No more attempt history.' : 'No completed attempts recorded yet.'));
            const embed = new EmbedBuilder().setColor(0x5865F2)
                .setTitle(isPoints ? `📊 Points History • Page ${page + 1}` : `📝 Attempt History • Page ${page + 1}`)
                .setDescription(description.slice(0, 4000))
                .setFooter({ text: `${allRows.length} records available • Showing ${rows.length}` }).setTimestamp();
            const maxPage = Math.max(0, Math.ceil(allRows.length / pageSize) - 1);
            const components = [];
            const row = new ActionRowBuilder();
            const historyType = isPoints ? 'points-history' : 'attempt-history';
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`weekly:${historyType}:prev:${page}`)
                    .setLabel('Previous')
                    .setEmoji('⬅️')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page <= 0),
                new ButtonBuilder()
                    .setCustomId(`weekly:${historyType}:next:${page}`)
                    .setLabel('Next')
                    .setEmoji('➡️')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page >= maxPage),
                new ButtonBuilder()
                    .setCustomId('weekly:profile')
                    .setLabel('Back to Profile')
                    .setEmoji('👤')
                    .setStyle(ButtonStyle.Primary),
            );
            components.push(row);
            await interaction.editReply({ embeds: [embed], components });
        } catch (error) {
            console.error('[weekly] history load failed:', error.message || error);
            await interaction.editReply({ content: '❌ Could not load your history right now.' }).catch(() => { });
        }
        return true;
    }

    if (customId === 'weekly:home') {
        const state = await R.getState();
        await interaction.update({ embeds: [participationEmbed(state, Number(await R.redis.scard(R.keys.participants())) || 0)], components: participationComponents(), allowedMentions: { parse: [] } });
        return true;
    }

    if (customId === 'weekly:missed') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const state = await R.getState();
            if (!state || state.status !== 'active' || Date.now() >= state.endsAt) {
                return interaction.editReply({
                    content: 'There is no active weekly competition.',
                    embeds: [],
                    components: [],
                });
            }

            await ensureUserDailyRecords(interaction.user.id, state);
            const today = utcDateKey();
            const dailyRecords = await R.getDailyRecords(interaction.user.id, state.competitionId);
            const eligible = dailyRecords.filter((record) =>
                record.date < today && record.status !== 'completed' &&
                !record.missedAttemptUsed && record.restoreStatus !== 'used'
            ).map((record) => record.date).sort();

            if (!eligible.length) {
                return interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x95A5A6)
                            .setTitle('📅 Missed Attempts')
                            .setDescription('✅ You have no missed attempts available right now.'),
                    ],
                    components: [],
                });
            }

            const firstDate = eligible[0];
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🔄 Restore a Missed Attempt')
                .setDescription([
                    `You have **${eligible.length} missed attempt${eligible.length === 1 ? '' : 's'}** available.`,
                    '',
                    'Click **Restore Attempt** and I’ll automatically start your **earliest missed day**.',
                    'After you complete it, return here to restore the next missed day.',
                    '',
                    '🎯 **Quiz points:** Earned normally',
                    '🔥 **Daily streak bonus:** Not awarded for restored attempts',
                ].join('\n'))
                .addFields({
                    name: '⏭️ Next restoration',
                    value: `**${firstDate}** (earliest missed day)`,
                })
                .setFooter({ text: 'Only one missed day is restored at a time.' });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('weekly:missed:restore')
                    .setLabel('Restore Attempt')
                    .setEmoji('🔄')
                    .setStyle(ButtonStyle.Success),
            );

            await interaction.editReply({ embeds: [embed], components: [row] });
        } catch (error) {
            console.error('[weekly] missed challenge menu failed:', error.message || error);
            await interaction.editReply({
                content: 'Could not load missed attempts. Please try again.',
                embeds: [],
                components: [],
            }).catch(() => { });
        }
        return true;
    }

    if (customId === 'weekly:missed:restore') {
        await interaction.deferUpdate();
        // Immediate feedback while locating and preparing the earliest missed day.
        await interaction.editReply({
            content: '⏳ **Preparing your missed challenge…** Your 15-second timer will start when the question appears.',
            embeds: [],
            components: [],
        }).catch(() => { });
        try {
            const state = await R.getState();
            if (!state || state.status !== 'active' || Date.now() >= state.endsAt) {
                return interaction.editReply({
                    content: 'There is no active weekly competition.',
                    embeds: [],
                    components: [],
                });
            }

            await ensureUserDailyRecords(interaction.user.id, state);
            const today = utcDateKey();
            const dailyRecords = await R.getDailyRecords(interaction.user.id, state.competitionId);
            const earliest = dailyRecords.find((record) =>
                record.date < today && record.status !== 'completed' &&
                !record.missedAttemptUsed && record.restoreStatus !== 'used'
            );
            const earliestMissedDate = earliest?.date || null;

            if (!earliestMissedDate) {
                return interaction.editReply({
                    content: '✅ You have no missed attempts available right now.',
                    embeds: [],
                    components: [],
                });
            }

            // beginAttempt resumes an existing in-progress record or starts this
            // user's earliest eligible missed day. The day is never user-selected.
            return beginAttempt(
                interaction,
                `${state.competitionId}:date-${earliestMissedDate}`,
            );
        } catch (error) {
            console.error('[weekly] missed attempt restore failed:', error.message || error);
            return interaction.editReply({
                content: 'Could not start the missed attempt. Please try again.',
                embeds: [],
                components: [],
            }).catch(() => { });
        }
    }

    if (customId === 'weekly:reattempt') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const state = await R.getState();
            if (!state || state.status !== 'active') return interaction.editReply('There is no active weekly competition.');
            const dayKey = getDayKey(state);
            const attempt = await R.getAttempt(interaction.user.id, dayKey);
            if (!attempt || attempt.status !== 'completed') return interaction.editReply('Complete today’s challenge before using a reattempt.');
            if (await R.redis.get(`${R.keys.participant(interaction.user.id)}:reattempt:${dayKey}`)) return interaction.editReply('You have already used today’s reattempt.');
            const embed = new EmbedBuilder().setColor(0xE67E22).setTitle('⚠️ Reattempt Today’s Challenge?')
                .setDescription('Are you sure you want to reattempt today’s challenge?\n\n**This will remove the entire current daily result, including its streak bonus, from your weekly total.** Your previous attempt will remain in Attempt History.\n\nWhen you finish the replacement attempt, a new streak bonus will be calculated and awarded.')
                .setFooter({ text: 'This action cannot be undone.' });
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('weekly:reattempt:confirm').setLabel('Yes, Reattempt').setEmoji('🔁').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('weekly:reattempt:cancel').setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Secondary),
            );
            await interaction.editReply({ embeds: [embed], components: [row] });
        } catch (error) {
            console.error('[weekly] reattempt prompt failed:', error.message || error);
            await interaction.editReply('Could not prepare your reattempt. Please try again.').catch(() => { });
        }
        return true;
    }

    if (customId === 'weekly:reattempt:cancel') {
        await interaction.update({ content: 'Reattempt cancelled. Your current score is unchanged.', embeds: [], components: [] });
        return true;
    }

    if (customId === 'weekly:reattempt:confirm') {
        await interaction.deferUpdate();
        try {
            const state = await R.getState();
            if (!state || state.status !== 'active') return interaction.editReply({ content: 'There is no active weekly competition.', embeds: [], components: [] });
            const dayKey = getDayKey(state);
            const attempt = await R.getAttempt(interaction.user.id, dayKey);
            if (!attempt || attempt.status !== 'completed') return interaction.editReply({ content: 'Complete today’s challenge before using a reattempt.', embeds: [], components: [] });
            const reattemptKey = `${R.keys.participant(interaction.user.id)}:reattempt:${dayKey}`;
            if (await R.redis.get(reattemptKey)) return interaction.editReply({ content: 'You have already used today’s reattempt.', embeds: [], components: [] });
            const lockKey = R.keys.operationLock(interaction.user.id, dayKey);
            const lock = await R.acquireLock(lockKey, 35);
            if (!lock) return interaction.editReply({ content: 'Your score is being updated. Try again shortly.', embeds: [], components: [] });
            try {
                // Wait for queued answer saves before reversing the completed attempt;
                // otherwise a stale background save could restore the old balance.
                const cacheKey = attemptCacheKey(interaction.user.id, dayKey);
                await Promise.all([
                    participantWriteChains.get(interaction.user.id)?.catch(() => { }),
                    attemptWriteChains.get(cacheKey)?.catch(() => { }),
                ]);
                const participant = await R.getParticipant(interaction.user.id);
                const originalStreakBonus = Math.max(0, Number(attempt.streakBonus) || 0);
                const originalTotal = Number(attempt.points) || 0;
                if (participant) {
                    // A reattempt replaces the entire daily result, including its
                    // bonus. The replacement attempt will calculate and award a new bonus.
                    participant.points = (Number(participant.points) || 0) - originalTotal;
                    participant.correct = Math.max(0, (Number(participant.correct) || 0) - (Number(attempt.correct) || 0));
                    participant.incorrect = Math.max(0, (Number(participant.incorrect) || 0) - (Number(attempt.incorrect) || 0));
                    participant.answered = Math.max(0, (Number(participant.answered) || 0) - (Number(attempt.answered) || 0));
                    participant.streakBonusTotal = Math.max(0, (Number(participant.streakBonusTotal) || 0) - originalStreakBonus);
                    participant.currentStreak = Math.max(0, (Number(attempt.streak) || Number(participant.currentStreak) || 0) - 1);
                    await R.saveParticipant(participant);
                    participantCache.set(interaction.user.id, participant);
                }
                await R.appendPointsHistory(interaction.user.id, { at: Date.now(), dayKey, type: 'reattempt-score-reversal', delta: -originalTotal, balance: participant?.points ?? 0, note: 'Entire previous daily result reversed, including its streak bonus; replacement will earn a new bonus' });
                await R.redis.set(`${reattemptKey}:bonus`, '0', { ex: 8 * 24 * 60 * 60 });
                await R.redis.set(reattemptKey, 'available', { ex: 8 * 24 * 60 * 60 });
                await R.deleteAttempt(interaction.user.id, dayKey);
                await interaction.editReply({ content: '🔁 Today’s previous score and streak bonus have been removed. Press **Challenge** to start your one reattempt; a new streak bonus will be calculated when you finish.', embeds: [], components: [] });
            } finally { await R.releaseLock(lockKey, lock).catch(() => { }); }
        } catch (error) {
            console.error('[weekly] reattempt failed:', error.message || error);
            await interaction.editReply({ content: 'Could not prepare your reattempt. Please try again.', embeds: [], components: [] }).catch(() => { });
        }
        return true;
    }

    if (customId === 'weekly:leaderboard' || customId === 'weekly:my-ranking') {

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        // console.log(
        //     `[WEEKLY] ${interaction.user.globalName} clicked ${customId === 'weekly:leaderboard' ? 'LEADERBOARD' : 'CHECK MY RANKING'
        //     }`
        // );
        try {
            const state = stateCache || await R.getState();
            if (!state) {
                await interaction.editReply({ content: 'ℹ️ No weekly competition data is available yet.' });
                return true;
            }
            const rankingsHidden = await areRankingsHidden();

            if (rankingsHidden) {
                if (customId === 'weekly:leaderboard') {
                    await interaction.editReply({
                        content: '',
                        embeds: [leaderboardSealedEmbed()],
                        components: [],
                        allowedMentions: { parse: [] },
                    });
                } else {
                    await interaction.editReply({
                        content: '🔒 **YOUR WEEKLY RANKING IS SEALED**\\n\\nIndividual ranks and scores are currently hidden by the event administrators.',
                        embeds: [],
                        components: [],
                        allowedMentions: { parse: [] },
                    });
                }
                return true;
            }

            const rows = await R.getLeaderboard(10000);
            const participantCount = Number(await R.redis.scard(R.keys.participants())) || 0;
            if (customId === 'weekly:leaderboard') {
                // A player counts as participated today as soon as their daily
                // attempt record exists (registered, active, or completed).
                // This uses the UTC day key and intentionally ignores reattempt status.
                const todayDayKey = getDayKey(state);
                const todayAttempts = await Promise.all(
                    rows.map((player) => R.getAttempt(player.userId, todayDayKey))
                );
                const participatedToday = new Set(
                    rows
                        .filter((player, index) => Boolean(todayAttempts[index]))
                        .map((player) => String(player.userId))
                );

                await interaction.editReply({
                    embeds: [leaderboardEmbed(state, rows, participantCount, participatedToday)],
                    allowedMentions: { parse: [] },
                });
            } else {
                const index = rows.findIndex((player) => player.userId === interaction.user.id);
                const player = index >= 0 ? rows[index] : null;
                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('📊 Your Weekly Ranking')
                    .setDescription(player
                        ? `🏅 **Rank:** #${index + 1} of ${rows.length}\n✨ **Points:** ${player.points}\n✅ **Correct answers:** ${player.correct || 0}\n📝 **Answers submitted:** ${player.answered || 0}`
                        : 'You have not scored any weekly points yet. Press **Challenge** to get started!')
                    .setFooter({ text: 'This ranking is visible only to you.' })
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
            }
        } catch (error) {
            console.error('[weekly] private ranking failed:', error.message || error);
            await interaction.editReply({ content: '❌ Could not load the ranking right now.' }).catch(() => { });
        }
        return true;
    }

    if (!customId.startsWith('weekly:answer:')) return false;

    // Capture answer time before Discord acknowledgements or any Redis/network work.
    const pressedAt = Date.now();
    // Acknowledge the button press immediately. The same ephemeral message is edited afterwards.
    await interaction.deferUpdate();
    // Give immediate visual feedback while scoring/locking/Redis work continues.
    // processAnswer replaces this message with answer feedback or the next question.
    await interaction.editReply({
        content: '⏳ **Checking your answer…**',
        embeds: [],
        components: [],
    }).catch(() => { });
    try {
        const [, , attemptId, encodedDate, questionIndexText, choiceText] = customId.split(':');
        const questionIndex = Number(questionIndexText);
        const choice = Number(choiceText);
        const state = stateCache || await R.getState();
        if (!state) return true;
        stateCache = state;

        // A missed attempt belongs to its original day, not today's key.
        const date = encodedDate ? Buffer.from(encodedDate, 'base64url').toString('utf8') : null;
        const dayKey = date ? `${state.competitionId}:date-${date}` : getDayKey(state);
        const attempt = attemptCache.get(attemptCacheKey(interaction.user.id, dayKey)) || await R.getAttempt(interaction.user.id, dayKey);
        if (!attempt || attempt.attemptId !== attemptId || attempt.status !== 'active' || attempt.questionIndex !== questionIndex) {
            weeklyLogs.blocked(interaction.user, 'stale or invalid answer button', `attempt=${attemptId} | clickedQuestion=${questionIndex}`);
            await interaction.followUp({ content: 'This question has already moved on. Please answer the question currently shown.', flags: MessageFlags.Ephemeral }).catch(() => { });
            return true;
        }

        if (Date.now() - attempt.lastQuestionAt >= QUESTION_TIME_MS) {
            await processAnswer(client, {
                userId: interaction.user.id,
                dayKey,
                attemptId,
                choice: null,
                timeout: true,
                expectedQuestionIndex: questionIndex,
                expectedQuestionStartedAt: attempt.lastQuestionAt,
            });
            return true;
        }

        await processAnswer(client, {
            userId: interaction.user.id,
            dayKey,
            attemptId,
            choice,
            interaction,
            expectedQuestionIndex: questionIndex,
            expectedQuestionStartedAt: attempt.lastQuestionAt,
            pressedAt,
        });
    } catch (error) {
        console.error('[weekly] answer failed:', error.message || error);
        await interaction.followUp({ content: '❌ Could not process that answer. Please try again.', flags: MessageFlags.Ephemeral }).catch(() => { });
    }
    return true;
}

async function handleWeeklyCommand(interaction) {
    const action = interaction.options.getString('action', true);

    // index.js normally acknowledges /weekly before any other command routing.
    // Keep this fallback for direct calls, without acknowledging twice.
    if (!interaction.deferred && !interaction.replied) {
        const weeklyAdmins = COMMAND_ACCESS.weekly || COMMAND_ACCESS.dailyevent || [];
        const isAuthorizedStart = action === 'start' && weeklyAdmins.map(String).includes(String(interaction.user.id));
        await interaction.deferReply(isAuthorizedStart ? {} : { flags: MessageFlags.Ephemeral });
    }

    weeklyLogs.action(`Command /weekly action:${action}`, weeklyLogs.formatUser(interaction.user));
    if (action === 'hide' || action === 'unhide') {
        return handleRankPrivacyCommand(interaction);
    }
    if (action === 'start') return startWeekly(interaction);

    if (action === 'leader') {
        if (!isAdmin(interaction.user.id)) {
            weeklyLogs.blocked(interaction.user, `not authorized for /weekly ${action}`);
            return interaction.editReply({ content: '❌ This command is restricted to weekly admins.', embeds: [], components: [] });
        }
        const state = await R.getState();
        stateCache = state;
        if (!state) {
            return interaction.editReply({
                embeds: [new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 WEEKLY WORLD QUIZ LEADERBOARD').setDescription('No saved weekly event was found.')],
            });
        }

        // Admin-only view: admins can still inspect participants and scores while public rankings are sealed.

        const [rows, participantCount] = await Promise.all([
            R.getLeaderboard(10000),
            R.redis.scard(R.keys.participants()),
        ]);
        const allScores = rows.length
            ? rows.map((player, index) => `${index + 1}. <@${player.userId}> — ${player.points} points (Correct: ${player.correct || 0}, Incorrect: ${player.incorrect || 0})`).join('\n')
            : 'No scores yet.';
        const message = `🏆 **WEEKLY PARTICIPANTS LIST**\n👥 **Players:** ${Number(participantCount) || 0}\n\n${allScores}`;
        // Send plain message content (not an embed). Split safely at Discord's 2,000-char limit.
        const chunks = [];
        let remaining = message;
        while (remaining.length > 1900) {
            let splitAt = remaining.lastIndexOf('\n', 1900);
            if (splitAt < 1) splitAt = 1900;
            chunks.push(remaining.slice(0, splitAt));
            remaining = remaining.slice(splitAt).trimStart();
        }
        chunks.push(remaining);
        await interaction.editReply({ content: chunks.shift(), embeds: [], components: [], allowedMentions: { parse: [] } });
        for (const chunk of chunks) {
            await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        }
        return;
    }

    if (action === 'resetday' || action === 'reset') {
        if (!isAdmin(interaction.user.id)) {
            return interaction.editReply({ content: '❌ This command is restricted to weekly admins.', embeds: [], components: [] });
        }


        const state = await R.getState();
        if (!state) return interaction.editReply('⚠️ No weekly event data found.');
        const target = interaction.options.getUser('user');
        if (!target) return interaction.editReply('⚠️ Select a user with `/weekly action:resetday user:@user date:YYYY-MM-DD`.');

        const requestedDate = interaction.options.getString('date') || utcDateKey();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) || Number.isNaN(Date.parse(`${requestedDate}T00:00:00.000Z`))) {
            return interaction.editReply('⚠️ Date must use `YYYY-MM-DD` (UTC), for example `2026-10-28`.');
        }
        const dayKey = `${state.competitionId}:date-${requestedDate}`;
        const cacheKey = attemptCacheKey(target.id, dayKey);
        const lockKey = R.keys.operationLock(target.id, dayKey);
        const reattemptKey = `${R.keys.participant(target.id)}:reattempt:${dayKey}`;
        const lock = await R.acquireLock(lockKey, 35);
        if (!lock) return interaction.editReply('⏳ That participant’s challenge is being processed. Try again shortly.');

        try {
            await Promise.all([
                participantWriteChains.get(target.id)?.catch(() => { }),
                attemptWriteChains.get(cacheKey)?.catch(() => { }),
            ]);

            const [attempt, participant] = await Promise.all([
                R.getAttempt(target.id, dayKey),
                R.getParticipant(target.id),
            ]);

            await R.redis.del(reattemptKey, `${reattemptKey}:bonus`);
            if (!attempt) {
                attemptCache.delete(cacheKey);
                return interaction.editReply(`ℹ️ <@${target.id}> has no saved attempt for **${requestedDate} UTC**. Reattempt restrictions for that date were cleared.`);
            }

            if (participant) {
                const attemptPoints = Number(attempt.points) || 0;
                const streakBonus = Math.max(0, Number(attempt.streakBonus) || 0);

                participant.points = (Number(participant.points) || 0) - attemptPoints;
                participant.correct = Math.max(0, (Number(participant.correct) || 0) - (Number(attempt.correct) || 0));
                participant.incorrect = Math.max(0, (Number(participant.incorrect) || 0) - (Number(attempt.incorrect) || 0));
                participant.answered = Math.max(0, (Number(participant.answered) || 0) - (Number(attempt.answered) || 0));
                if (attempt.status === 'completed') {
                    participant.challengesCompleted = Math.max(0, (Number(participant.challengesCompleted) || 0) - 1);
                }
                participant.streakBonusTotal = Math.max(0, (Number(participant.streakBonusTotal) || 0) - streakBonus);

                // Recompute current streak from consecutive completed daily attempts ending today.
                const currentDate = utcDateKey();
                let streak = 0;
                let cursor = new Date(`${currentDate}T00:00:00.000Z`);
                for (let i = 0; i < 7; i++) {
                    const date = cursor.toISOString().slice(0, 10);
                    if (date === requestedDate) {
                        cursor.setUTCDate(cursor.getUTCDate() - 1);
                        continue;
                    }
                    const prior = await R.getAttempt(target.id, `${state.competitionId}:date-${date}`);
                    if (prior?.status !== 'completed') break;
                    streak++;
                    cursor.setUTCDate(cursor.getUTCDate() - 1);
                }
                participant.currentStreak = streak;
                participantCache.set(target.id, participant);
                await R.saveParticipant(participant);

            }

            await R.deleteAttempt(target.id, dayKey);
            await R.deleteAttemptDayHistory(target.id, dayKey);
            attemptCache.delete(cacheKey);
            if (attempt.attemptId) liveResponses.delete(attempt.attemptId);

            return interaction.editReply(`♻️ Reset <@${target.id}>’s entire attempt data for **${requestedDate} UTC**. The attempt, reattempt status, attempt history, and associated counters/points were cleared for that day.`);
        } finally {
            await R.releaseLock(lockKey, lock).catch(() => { });
        }
    }

    if (action === 'deleteuser') {
        if (!isAdmin(interaction.user.id)) {
            return interaction.reply({ content: '❌ This command is restricted to weekly admins.', flags: MessageFlags.Ephemeral });
        }

        const target = interaction.options.getUser('user');
        if (!target) return interaction.editReply('⚠️ Select a user with `/weekly action:deleteuser user:@user`.');

        await Promise.all([
            participantWriteChains.get(target.id)?.catch(() => { }),
            ...[...attemptWriteChains.entries()]
                .filter(([key]) => key.startsWith(`${target.id}:`))
                .map(([, promise]) => promise.catch(() => { })),
        ]);

        const userAttemptIds = [...attemptCache.entries()]
            .filter(([key]) => key.startsWith(`${target.id}:`))
            .map(([, attempt]) => attempt?.attemptId)
            .filter(Boolean);
        const removedAttempts = await R.deleteUserData(target.id);
        participantCache.delete(target.id);
        for (const key of [...attemptCache.keys()]) {
            if (key.startsWith(`${target.id}:`)) attemptCache.delete(key);
        }
        for (const attemptId of userAttemptIds) liveResponses.delete(attemptId);
        participantWriteChains.delete(target.id);
        for (const key of [...attemptWriteChains.keys()]) {
            if (key.startsWith(`${target.id}:`)) attemptWriteChains.delete(key);
        }

        return interaction.editReply(`🗑️ Deleted <@${target.id}>’s weekly profile, leaderboard entry, all attempts, attempt/points history, reattempt flags, and personal used-question history (${removedAttempts} attempt records removed).`);
    }

    if (action === 'end') {
        if (!isAdmin(interaction.user.id)) {
            return interaction.editReply({ content: '❌ You are not authorized to manage the weekly competition.', embeds: [], components: [] });
        }

        const state = await R.getState();
        if (!state) return interaction.editReply('⚠️ No weekly event data to clear.');

        const winners = await R.getLeaderboard(5);
        weeklyLogs.action('Final rewards calculated', winners.map((player, index) => `place=${index + 1} user=${player.userId} reward=${PRIZES[index]} Mora points=${player.points}`).join(' | ') || 'no scored participants');
        const summary = winners.length
            ? winners.map((player, index) => `${MEDALS[index]} <@${player.userId}> — **${PRIZES[index]} Mora** (${player.points} points)`).join('\n')
            : 'No participants scored points.';

        // Tell the admin the results before deleting event scores. Deduplication history remains.
        await interaction.editReply({
            content: `🧹 **Weekly event data cleared.**\n\nFinal winners before deletion:\n${summary}`,
            allowedMentions: { parse: [] },
        });
        await R.clearWeeklyData();
        stateCache = null;
        liveResponses.clear();
        attemptCache.clear();
        participantCache.clear();
        participantWriteChains.clear();
        attemptWriteChains.clear();
    }
}

// Keep the final-winner summary consistent with the public leaderboard prizes.
module.exports = {
    weeklyCommand,
    handleWeeklyCommand,
    handleWeeklyButton,
    startWeeklyScheduler,
    hideRankCommand,
    unhideRankCommand,
    handleRankPrivacyCommand,
};
