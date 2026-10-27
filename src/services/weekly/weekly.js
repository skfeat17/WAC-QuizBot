// Command handlers and quiz state machine for WAC Weekly World Quiz Champion.
//weekly.js
const crypto = require('node:crypto');
const emergencyData = require('./emergency_with_ids.json');
const { SlashCommandBuilder, EmbedBuilder, MessageFlags, WebhookClient } = require('discord.js');
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
} = require('./weeklyEmbeds');
const { startWeeklyScheduler } = require('./weeklyScheduler');
const { utcDateKey, scoreForAnswer } = require('./weeklyUtils');
const { COMMAND_ACCESS } = require('../COMMAND_ACCESS');

const ADMIN_IDS = COMMAND_ACCESS.weekly || COMMAND_ACCESS.dailyevent || [];
const QUESTIONS_PER_ATTEMPT = 5;
const QUESTION_TIME_MS = 15_000;

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
async function takeReadyQuestion(userId, usedCategories = new Set()) {
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
        !usedIds.has(String(question.id))
    );

    if (!available.length) {
        throw new Error(`You have used every available question in the ${category} category.`);
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

function weeklyCommand() {
    return new SlashCommandBuilder()
        .setName('weekly')
        .setDescription('Manage the Weekly World Quiz competition')
        .addStringOption((option) => option
            .setName('action')
            .setDescription('Choose what to do')
            .setRequired(true)
            .addChoices(
                // { name: 'Start', value: 'start' },
                // { name: 'End', value: 'end' },
                { name: 'Leader', value: 'leader' },
                // { name: 'Reset a user', value: 'reset' },
            ))
        .addUserOption((option) => option
            .setName('user')
            .setDescription('Optional: user to reset (required when action is reset)')
            .setRequired(false));
}

// Daily challenge boundary is UTC/GMT+0, not a rolling 24-hour window.
function getDayKey(state) {
    return `${state.competitionId}:date-${utcDateKey()}`;
}

async function startWeekly(interaction) {
    weeklyLogs.action('START requested', weeklyLogs.formatUser(interaction.user));
    if (!isAdmin(interaction.user.id)) {
        weeklyLogs.blocked(interaction.user, 'not authorized to start the weekly competition');
        return interaction.reply({
            content: '❌ You are not authorized to manage the weekly competition.',
            flags: MessageFlags.Ephemeral,
        });
    }

    // Acknowledge before Redis work.
    await interaction.deferReply();

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
            endsAt: startedAt + 7 * 24 * 60 * 60 * 1000,
            startedBy: interaction.user.id,
            questionsPerParticipant: QUESTIONS_PER_ATTEMPT,
        };

        await R.setState(state);
        weeklyLogs.action('Competition started', `by=${weeklyLogs.formatUser(interaction.user)} | competitionId=${state.competitionId} | endsAt=${new Date(state.endsAt).toISOString()} | rewards=750/500/350 Mora`);
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

async function beginAttempt(interaction) {
    const userId = interaction.user.id;
    weeklyLogs.action('Participate clicked', weeklyLogs.formatUser(interaction.user));
    const state = await R.getState();
    if (!state || state.status !== 'active' || Date.now() >= state.endsAt) {
        weeklyLogs.blocked(interaction.user, 'no active weekly competition');
        return interaction.editReply({ content: '❌ There is no active weekly competition right now.', embeds: [], components: [] });
    }

    const dayKey = getDayKey(state);
    const cacheKey = attemptCacheKey(userId, dayKey);
    const lock = await R.acquireLock(R.keys.operationLock(userId, dayKey), 30);
    if (!lock) {
        weeklyLogs.blocked(interaction.user, 'challenge lock unavailable; another operation is running');
        return interaction.editReply({ content: '⏳ Your challenge is being updated. Please try again in a moment.', embeds: [], components: [] });
    }

    try {
        // Always read shared state while holding the per-user/day lock. This prevents
        // two button clicks or two bot processes from creating duplicate attempts.
        const currentState = await R.getState();
        if (!currentState || currentState.status !== 'active' || Date.now() >= currentState.endsAt) {
            weeklyLogs.blocked(interaction.user, 'competition became unavailable before challenge start');
            return interaction.editReply({ content: '❌ There is no active weekly competition right now.', embeds: [], components: [] });
        }
        const existingAttempt = await R.getAttempt(userId, dayKey);
        if (existingAttempt?.status === 'completed') {
            
            weeklyLogs.blocked(interaction.user, 'daily challenge already completed', `dayKey=${dayKey}`);
            attemptCache.set(cacheKey, existingAttempt);
            return interaction.editReply({ content: '✅ You have already completed today’s challenge. Come back tomorrow!', embeds: [], components: [] });
        }
        if (existingAttempt?.status === 'active' && existingAttempt.questions?.length) {
            weeklyLogs.blocked(interaction.user, 'challenge already in progress', `attempt=${existingAttempt.attemptId}`);
            attemptCache.set(cacheKey, existingAttempt);
            return interaction.editReply({ content: '⚠️ You already have a challenge in progress. Use your existing challenge message. If it was interrupted, wait for the current question timer to finish.', embeds: [], components: [] });
        }

        let attempt = existingAttempt;
        let question;
        try {
            question = await takeReadyQuestion(userId, getAttemptCategories(attempt));
        } catch (error) {
            console.error('[weekly] question unavailable while starting/resuming:', error.message || error);
            const exhausted = String(error.message || '').includes('used every question');
            return interaction.editReply({
                content: exhausted
                    ? '🏁 You have used every available Weekly question. No questions were repeated.'
                    : '⚠️ Questions are temporarily unavailable. Your progress is safe; please try again shortly.',
                embeds: [], components: [],
            });
        }

        const now = Date.now();
        if (attempt?.status === 'active') {
            // Recover a challenge paused because the next question could not be fetched.
            attempt.questions = [question];
            attempt.lastQuestionAt = now;
            attempt.webhook = webhookDetails(interaction);
            attempt.responseMessageId = '@original';
        } else {
            await R.join(userId, interaction.user.globalName || interaction.user.username);
            attempt = {
                attemptId: crypto.randomUUID().slice(0, 12),
                userId,
                competitionId: currentState.competitionId,
                dayKey,
                status: 'active',
                questionIndex: 0,
                totalQuestions: QUESTIONS_PER_ATTEMPT,
                questions: [question],
                points: 0,
                correct: 0,
                incorrect: 0,
                timedOut: 0,
                answered: 0,
                startedAt: now,
                lastQuestionAt: now,
                answers: [],
                responseMessageId: '@original',
                webhook: webhookDetails(interaction),
            };
        }

        attemptCache.set(cacheKey, attempt);
        await R.setAttempt(userId, dayKey, attempt);
        weeklyLogs.action('Attempt started/resumed', `${weeklyLogs.formatUser(interaction.user)} | attempt=${attempt.attemptId} | dayKey=${dayKey}`);
        weeklyLogs.question(interaction.user, attempt.questionIndex + 1, attempt.totalQuestions, question.question, attempt.attemptId);
        await interaction.editReply({
            content: '',
            embeds: [questionEmbed(question, attempt.questionIndex, attempt.totalQuestions, now + QUESTION_TIME_MS)],
            components: answerRows(attempt.attemptId, question, attempt.questionIndex),
        });
        const message = await interaction.fetchReply().catch(() => null);
        if (message) attempt.responseMessageId = message.id;
        attemptCache.set(cacheKey, attempt);
        await R.setAttempt(userId, dayKey, attempt);
        liveResponses.set(attempt.attemptId, { webhook: interaction.webhook, messageId: message?.id || '@original' });
        scheduleTimeout(interaction.client, userId, dayKey, attempt.attemptId, attempt.questionIndex, now);
        if (!existingAttempt) setImmediate(() => updateParticipationMessage(interaction.client, currentState).catch(() => { }));
    } finally {
        await R.releaseLock(R.keys.operationLock(userId, dayKey), lock).catch(() => { });
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
        await interaction.editReply(payload);
        return;
    }

    const live = liveResponses.get(attemptId);
    if (live) {
        await live.webhook.editMessage(live.messageId, payload);
        return;
    }

    // The interaction webhook is persisted with the attempt, allowing timeout edits
    // to recover after a process restart while Discord's interaction token is valid.
    if (attempt?.webhook?.id && attempt?.webhook?.token) {
        const webhook = new WebhookClient({ id: attempt.webhook.id, token: attempt.webhook.token });
        await webhook.editMessage('@original', payload);
    }
}

async function processAnswer(client, input) {
    const {
        userId, dayKey, attemptId, choice, interaction = null,
        expectedQuestionIndex = null, expectedQuestionStartedAt = null,
    } = input;

    let timeout = Boolean(input.timeout);
    const cacheKey = attemptCacheKey(userId, dayKey);
    // One shared lock serializes answers, timeouts, challenge starts, and admin resets
    // for this user/day across all bot processes.
    const lockKey = R.keys.operationLock(userId, dayKey);
    const lock = await R.acquireLock(lockKey, 35);
    if (!lock) {
        weeklyLogs.blocked({ id: userId, username: userId }, 'answer processing lock unavailable', `attempt=${attemptId}`);
        return false;
    }

    let attempt;
    try {
        attempt = await R.getAttempt(userId, dayKey);
        if (!attempt || attempt.status !== 'active' || attempt.attemptId !== attemptId) {
            weeklyLogs.blocked({ id: userId, username: userId }, 'attempt missing, inactive, or mismatched', `attempt=${attemptId}`);
            return false;
        }
        if (expectedQuestionIndex !== null && attempt.questionIndex !== expectedQuestionIndex) {
            weeklyLogs.blocked({ id: userId, username: userId }, 'stale question index', `attempt=${attemptId} | expected=${expectedQuestionIndex} | current=${attempt.questionIndex}`);
            return false;
        }
        if (expectedQuestionStartedAt !== null && attempt.lastQuestionAt !== expectedQuestionStartedAt) {
            weeklyLogs.blocked({ id: userId, username: userId }, 'stale question timer', `attempt=${attemptId}`);
            return false;
        }

        const elapsedMs = Math.max(0, Date.now() - attempt.lastQuestionAt);
        if (!timeout && elapsedMs >= QUESTION_TIME_MS) {
            // Continue within this lock instead of recursively trying to reacquire it.
            timeout = true;
        }

        const [state, participant] = await Promise.all([R.getState(), R.getParticipant(userId)]);
        stateCache = state;
        if (!state || state.competitionId !== attempt.competitionId || state.status !== 'active' || Date.now() >= state.endsAt) {
            weeklyLogs.blocked({ id: userId, username: userId }, 'competition ended or changed during answer', `attempt=${attemptId}`);
            return false;
        }

        // The current question was recorded in this player's permanent history when assigned.
        const questions = Array.isArray(attempt.questions) ? attempt.questions : [];
        const currentQuestion = questions[0];
        if (!currentQuestion) return false;

        const isCorrect = !timeout && Number(choice) === currentQuestion.correctAnswer;
        const pointsDelta = timeout ? 0 : isCorrect ? scoreForAnswer(elapsedMs, QUESTION_TIME_MS) : -15;
        if (timeout) weeklyLogs.timeout({ id: userId, username: userId }, attempt.questionIndex + 1, attemptId);
        else weeklyLogs.answer({ id: userId, username: userId }, attempt.questionIndex + 1, choice, isCorrect, pointsDelta, elapsedMs, attemptId);

        // Prepare the next UI before slower persistence and ranking work.
        attempt.points += pointsDelta;
        // Cache the updated attempt before rendering so an immediate next click sees it.
        attemptCache.set(cacheKey, attempt);
        attempt.answered += 1;
        if (timeout) attempt.timedOut += 1;
        else if (isCorrect) attempt.correct += 1;
        else attempt.incorrect += 1;
        attempt.answers.push({
            questionId: currentQuestion.id,
            choice: timeout ? null : Number(choice),
            correct: isCorrect,
            timeout,
            pointsDelta,
            elapsedMs,
        });
        questions.shift();
        attempt.questions = questions;
        attempt.questionIndex += 1;

        const updatedParticipant = participant ? {
            ...participant,
            points: (Number(participant.points) || 0) + pointsDelta,
            correct: (Number(participant.correct) || 0) + (isCorrect ? 1 : 0),
            incorrect: (Number(participant.incorrect) || 0) + (!timeout && !isCorrect ? 1 : 0),
            answered: (Number(participant.answered) || 0) + 1,
        } : null;

        if (updatedParticipant) participantCache.set(userId, updatedParticipant);

        if (attempt.questionIndex >= attempt.totalQuestions) {
            attempt.status = 'completed';
            attempt.completedAt = Date.now();
            await updateOriginal(attemptId, interaction, {
                content: 'Calculating your final ranking…', embeds: [], components: [],
            }, attempt).catch(() => { });

            // Persist independent records in parallel to reduce end-of-quiz delay.
            await Promise.all([
                persistAttemptInBackground(attempt),
                updatedParticipant ? saveParticipantInBackground(updatedParticipant) : Promise.resolve(),
            ]);
            const leaderboard = await R.getLeaderboard(10000);
            const rank = leaderboard.findIndex((player) => player.userId === userId) + 1;
            weeklyLogs.action('Attempt completed', `user=${userId} | attempt=${attemptId} | points=${attempt.points} | correct=${attempt.correct} | incorrect=${attempt.incorrect} | timedOut=${attempt.timedOut} | rank=${rank}`);
            await updateOriginal(attemptId, interaction, {
                content: '',
                embeds: [resultEmbed(attempt, updatedParticipant, rank)],
                components: [],
            }, attempt);
            liveResponses.delete(attemptId);
return true;
        }

        // Show answer feedback for three seconds before moving to the next question.
        await Promise.all([
            persistAttemptInBackground(attempt),
            updatedParticipant ? saveParticipantInBackground(updatedParticipant) : Promise.resolve(),
        ]);
        await updateOriginal(attemptId, interaction, {
            content: '',
            embeds: [answerFeedbackEmbed({
                correct: isCorrect,
                timeout,
                pointsDelta,
                elapsedMs,
                question: currentQuestion,
                questionNumber: attempt.questionIndex,
            })],
            components: [],
        }, attempt).catch(() => { });
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Start the next question's timer immediately before rendering it.
        attempt.lastQuestionAt = Date.now();
        let nextQuestion;
        try {
            nextQuestion = await takeReadyQuestion(userId, getAttemptCategories(attempt));
        } catch (error) {
            // If generation is temporarily unavailable, keep the current answer
            // recorded and show a retry message rather than silently ending early.
            // Keep the attempt active with an empty question list. The participant can
            // press Participate again to resume without losing today's answered questions.
            attempt.questions = [];
            await Promise.all([
                persistAttemptInBackground(attempt),
                updatedParticipant ? saveParticipantInBackground(updatedParticipant) : Promise.resolve(),
            ]);
            const exhausted = String(error.message || '').includes('used every question');
            await updateOriginal(attemptId, interaction, {
                content: exhausted
                    ? '🏁 You have used every available Weekly question. Your progress is saved; no question was repeated.'
                    : '⚠️ The next question is temporarily unavailable. Your progress is saved. Press **Participate** again to resume.',
                embeds: [], components: [],
            }, attempt).catch(() => { });
            liveResponses.delete(attemptId);
            return false;
        }
        attempt.questions = [nextQuestion];
        weeklyLogs.question({ id: userId, username: userId }, attempt.questionIndex + 1, attempt.totalQuestions, nextQuestion.question, attemptId);
        const deadline = attempt.lastQuestionAt + QUESTION_TIME_MS;

        // This is intentionally before Redis writes: the player sees the next question immediately.
        if (interaction) attempt.webhook = webhookDetails(interaction);
        await updateOriginal(attemptId, interaction, {
            content: '',
            embeds: [questionEmbed(nextQuestion, attempt.questionIndex, attempt.totalQuestions, deadline)],
            components: answerRows(attemptId, nextQuestion, attempt.questionIndex),
        }, attempt);

        scheduleTimeout(client, userId, dayKey, attemptId, attempt.questionIndex, attempt.lastQuestionAt);
        // Persist asynchronously after the next question is already visible. Writes for a
        // participant are serialized so rapid answers cannot overwrite a newer score.
        await Promise.all([
            persistAttemptInBackground(attempt),
            updatedParticipant ? saveParticipantInBackground(updatedParticipant) : Promise.resolve(),
        ]);
        return true;
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

            const existingAttempt = await R.getAttempt(interaction.user.id, getDayKey(state));
            if (existingAttempt?.status === 'completed') {
                    weeklyLogs.blocked(
        interaction.user,
        'daily challenge already completed',
        `dayKey=${getDayKey(state)}`
    );

                await interaction.editReply({
                    content: '✅ You have already completed today’s challenge. Come back tomorrow!',
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

    if (customId === 'weekly:leaderboard' || customId === 'weekly:my-ranking') {

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        console.log(
            `[WEEKLY] ${interaction.user.globalName} clicked ${customId === 'weekly:leaderboard' ? 'LEADERBOARD' : 'CHECK MY RANKING'
            }`
        );
        try {
            const state = stateCache || await R.getState();
            if (!state) {
                await interaction.editReply({ content: 'ℹ️ No weekly competition data is available yet.' });
                return true;
            }
            const rows = await R.getLeaderboard(10000);
            const participantCount = Number(await R.redis.scard(R.keys.participants())) || 0;
            if (customId === 'weekly:leaderboard') {
                await interaction.editReply({
                    embeds: [leaderboardEmbed(state, rows, participantCount)],
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

    // Acknowledge the button press immediately. The same ephemeral message is edited afterwards.
    await interaction.deferUpdate();
    try {
        const [, , attemptId, questionIndexText, choiceText] = customId.split(':');
        const questionIndex = Number(questionIndexText);
        const choice = Number(choiceText);
        const state = stateCache || await R.getState();
        if (!state) return true;
        stateCache = state;

        const dayKey = getDayKey(state);
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
        });
    } catch (error) {
        console.error('[weekly] answer failed:', error.message || error);
        await interaction.followUp({ content: '❌ Could not process that answer. Please try again.', flags: MessageFlags.Ephemeral }).catch(() => { });
    }
    return true;
}

async function handleWeeklyCommand(interaction) {
    const action = interaction.options.getString('action', true);
    weeklyLogs.action(`Command /weekly action:${action}`, weeklyLogs.formatUser(interaction.user));
    if (action === 'start') return startWeekly(interaction);

    if (action === 'leader') {
        if (!isAdmin(interaction.user.id)) {
            weeklyLogs.blocked(interaction.user, `not authorized for /weekly ${action}`);
            return interaction.reply({ content: '❌ This command is restricted to weekly admins.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const state = await R.getState();
        stateCache = state;
        if (!state) {
            return interaction.editReply({
                embeds: [new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 WEEKLY WORLD QUIZ LEADERBOARD').setDescription('No saved weekly event was found.')],
            });
        }
        const [rows, participantCount] = await Promise.all([
            R.getLeaderboard(10000),
            R.redis.scard(R.keys.participants()),
        ]);
        const allScores = rows.length
            ? rows.map((player, index) => `${index + 1}. <@${player.userId}> — **${player.points} points** (✅ ${player.correct || 0}, ❌ ${player.incorrect || 0})`).join('\n')
            : 'No scores yet.';
        const embed = new EmbedBuilder()
            .setColor(0xF1C40F)
            .setTitle('🔒 ADMIN • ALL WEEKLY SCORES')
            .setDescription(allScores.slice(0, 4000))
            .addFields({ name: '👥 Players', value: String(Number(participantCount) || 0), inline: true })
            .setFooter({ text: 'Visible only to you.' })
            .setTimestamp();
        return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    if (action === 'reset') {
        if (!isAdmin(interaction.user.id)) {
            return interaction.reply({ content: '❌ This command is restricted to weekly admins.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const state = await R.getState();
        if (!state) return interaction.editReply('⚠️ No weekly event data found.');
        const target = interaction.options.getUser('user');
        if (!target) return interaction.editReply('⚠️ Please select a user with `/weekly action:reset user:@user`.');

        const dayKey = getDayKey(state);
        const cacheKey = attemptCacheKey(target.id, dayKey);
        const lockKey = R.keys.operationLock(target.id, dayKey);
        const lock = await R.acquireLock(lockKey, 35);
        if (!lock) return interaction.editReply('⏳ That participant’s challenge is being processed. Please run reset again in a moment.');
        try {
            // Drain writes already queued in this process before reading the authoritative records.
            await Promise.all([
                participantWriteChains.get(target.id)?.catch(() => { }),
                attemptWriteChains.get(cacheKey)?.catch(() => { }),
            ]);
            const [attempt, participant] = await Promise.all([
                R.getAttempt(target.id, dayKey),
                R.getParticipant(target.id),
            ]);
            if (!attempt) {
                attemptCache.delete(cacheKey);
                return interaction.editReply(`ℹ️ <@${target.id}> has no saved progress today.`);
            }
            if (participant) {
                participant.points = (Number(participant.points) || 0) - (Number(attempt.points) || 0);
                participant.correct = Math.max(0, (Number(participant.correct) || 0) - (Number(attempt.correct) || 0));
                participant.incorrect = Math.max(0, (Number(participant.incorrect) || 0) - (Number(attempt.incorrect) || 0));
                participant.answered = Math.max(0, (Number(participant.answered) || 0) - (Number(attempt.answered) || 0));
                participantCache.set(target.id, participant);
                await R.saveParticipant(participant);
            }
            await R.deleteAttempt(target.id, dayKey);
            attemptCache.delete(cacheKey);
            liveResponses.delete(attempt.attemptId);
            return interaction.editReply(`♻️ Reset <@${target.id}>'s progress for **${utcDateKey()} (UTC)**. They can challenge again today.`);
        } finally {
            await R.releaseLock(lockKey, lock).catch(() => { });
        }
    }

    if (action === 'end') {
        if (!isAdmin(interaction.user.id)) {
            return interaction.reply({ content: '❌ You are not authorized to manage the weekly competition.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const state = await R.getState();
        if (!state) return interaction.editReply('⚠️ No weekly event data to clear.');

        const winners = await R.getLeaderboard(3);
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
const MEDALS = ['🥇', '🥈', '🥉'];
const PRIZES = [750, 500, 350];

module.exports = { weeklyCommand, handleWeeklyCommand, handleWeeklyButton, startWeeklyScheduler };
