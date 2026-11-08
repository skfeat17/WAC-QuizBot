// Independent Boss Mode system. Uses its own Redis namespace and does not
// read, write, or modify Weekly Quiz state.
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

const QUESTIONS = Array.isArray(questionData.questions)
    ? questionData.questions
    : [];

const HARD_QUESTIONS = QUESTIONS.filter((question) =>
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
const RESULT_PAUSE_MS = 1_200;
const ADMIN_IDS = COMMAND_ACCESS.weekly || COMMAND_ACCESS.dailyevent || [];

// One timer and one editable original ephemeral response per player.
const activeTimers = new Map();
const liveResponses = new Map();

function isAdmin(userId) {
    return ADMIN_IDS.map(String).includes(String(userId));
}

function pickHardQuestion() {
    if (!HARD_QUESTIONS.length) {
        throw new Error('No valid hard questions found in weekly-questions-v5.json.');
    }
    return HARD_QUESTIONS[crypto.randomInt(0, HARD_QUESTIONS.length)];
}

function speedPoints(elapsedMs) {
    const remaining = Math.max(0, QUESTION_TIME_MS - elapsedMs);
    return Math.max(1, Math.ceil((remaining / QUESTION_TIME_MS) * 100));
}

function bossCommand() {
    return new SlashCommandBuilder()
        .setName('boss')
        .setDescription('Manage World Boss Mode')
        .addStringOption((option) => option
            .setName('action')
            .setDescription('Choose an action')
            .setRequired(true)
            .addChoices(
                { name: 'Start', value: 'start' },
                { name: 'Leaderboard', value: 'leaderboard' },
                { name: 'Participants', value: 'participants' },
                { name: 'End', value: 'end' },
                { name: 'Reset', value: 'reset' },
            ))
        .addIntegerOption((option) => option
            .setName('duration')
            .setDescription('Event duration in minutes (for Start)')
            .setMinValue(1)
            .setMaxValue(1440)
            .setRequired(false));
}

async function getLiveState() {
    const state = await R.getState();
    if (state?.status === 'active' && Date.now() >= Number(state.endsAt)) {
        state.status = 'ended';
        state.endedAt = Date.now();
        await R.setState(state);
    }
    return state;
}

// Keep the original ephemeral response editable for the entire question stream.
// Discord interaction webhooks remain valid for their normal token lifetime.
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
        await live.webhook.editMessage(live.messageId, payload);
        return true;
    } catch (error) {
        if ([50027, 10015].includes(Number(error.code))) {
            liveResponses.delete(id);
            console.warn(`[boss] interaction response expired for user ${id}; saved score is unaffected.`);
            return false;
        }
        console.error(`[boss] message edit failed for user ${id}:`, error);
        return false;
    }
}

function makePlayerEditor(user) {
    return {
        user,
        editReply: (payload) => editPlayerMessage(user.id, payload),
    };
}

async function postNextQuestion(interaction) {
    const userId = String(interaction.user.id);
    const state = await getLiveState();

    if (!state || state.status !== 'active') {
        return interaction.editReply({
            content: '🔴 Boss Mode is not currently active.',
            embeds: [],
            components: [],
        });
    }

    const question = pickHardQuestion();
    const questionId = crypto.randomUUID();
    const startedAt = Date.now();
    const deadlineAt = startedAt + QUESTION_TIME_MS;

    await R.ensureParticipant(interaction.user);
    let session = await R.getSession(userId);
    if (!session) {
        session = { answered: 0, correct: 0, incorrect: 0, timeouts: 0, points: 0, startedAt: Date.now() };
        await R.setSession(userId, session);
    }
    await R.setActiveQuestion(userId, {
        questionId,
        question,
        startedAt,
        deadlineAt,
    });

    // This edits the same original response; no follow-up message is created.
    const response = await interaction.editReply({
        content: '',
        embeds: [E.questionEmbed(question, deadlineAt)],
        components: E.questionComponents(questionId, question),
    });

    const previousTimer = activeTimers.get(userId);
    if (previousTimer) clearTimeout(previousTimer);

    const timer = setTimeout(async () => {
        try {
            const active = await R.getActiveQuestion(userId);
            if (!active || active.questionId !== questionId) return;

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

            const outcome = await settleAnswer(interaction.user, active, null, true);
            await R.clearActiveQuestion(userId);
            const session = await recordSessionAnswer(userId, outcome, true);
            const finished = session.answered >= QUESTIONS_PER_ATTEMPT;

            await editPlayerMessage(userId, {
                content: '',
                embeds: [finished ? E.attemptSummaryEmbed(session, outcome.participant.points, 'Completed') : E.resultEmbed({
                    correct: false, timeout: true, delta: 0,
                    total: outcome.participant.points, question: active.question,
                    questionNumber: session.answered,
                })],
                components: [],
            });

            if (finished) await R.clearSession(userId);
            else {
                await wait(RESULT_PAUSE_MS);
                const stateNow = await getLiveState();
                if (stateNow?.status === 'active') await postNextQuestion(makePlayerEditor(interaction.user));
            }
        } catch (error) {
            console.error('[boss] timeout handler failed:', error);
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

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleAnswer(user, active, selectedIndex, timeout = false) {
    const participant = await R.ensureParticipant(user);
    const correct = !timeout &&
        Number(selectedIndex) === Number(active.question.correctAnswer);
    const elapsed = Math.max(0, Date.now() - Number(active.startedAt));
    const delta = timeout ? 0 : correct ? speedPoints(elapsed) : -50;

    participant.points = Number(participant.points || 0) + delta;
    participant.questionsAnswered = Number(participant.questionsAnswered || 0) + 1;

    if (timeout) {
        participant.timeouts = Number(participant.timeouts || 0) + 1;
    } else if (correct) {
        participant.correct = Number(participant.correct || 0) + 1;
    } else {
        participant.incorrect = Number(participant.incorrect || 0) + 1;
    }

    await R.saveParticipant(participant);
    return { correct, delta, participant, elapsed };
}

async function recordSessionAnswer(userId, outcome, timeout = false) {
    const session = await R.getSession(userId) || { answered: 0, correct: 0, incorrect: 0, timeouts: 0, points: 0, startedAt: Date.now() };
    session.answered += 1;
    session.points += Number(outcome.delta || 0);
    if (timeout) session.timeouts += 1;
    else if (outcome.correct) session.correct += 1;
    else session.incorrect += 1;
    await R.setSession(userId, session);
    return session;
}

async function handleBossButton(interaction) {
    const customId = interaction.customId || '';
    const userId = String(interaction.user.id);

    if (customId === 'boss:challenge') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        rememberResponse(interaction);
        return postNextQuestion(interaction);
    }

    if (customId === 'boss:quit') {
        await interaction.deferUpdate();
        const timer = activeTimers.get(userId);
        if (timer) clearTimeout(timer);
        activeTimers.delete(userId);
        await R.clearActiveQuestion(userId);
        const session = await R.getSession(userId);
        if (!session || !session.answered) {
            await R.clearSession(userId);
            await editPlayerMessage(userId, { content: 'You quit the attempt.', embeds: [], components: [] });
            return;
        }
        await editPlayerMessage(userId, {
            content: '',
            embeds: [E.attemptSummaryEmbed(session, (await R.getParticipant(userId))?.points || 0, 'Quit early')],
            components: [],
        });
        await R.clearSession(userId);
        return;
    }

    if (customId === 'boss:leaderboard') {
        const [rows, state] = await Promise.all([
            R.getLeaderboard(10),
            getLiveState(),
        ]);
        return interaction.reply({
            embeds: [E.leaderboardEmbed(rows, state?.status === 'active' ? 'LIVE' : 'ENDED')],
            flags: MessageFlags.Ephemeral,
        });
    }

    if (!customId.startsWith('boss:answer:')) return;

    const [, , questionId, answerIndex] = customId.split(':');
    await interaction.deferUpdate();

    const active = await R.getActiveQuestion(userId);
    if (!active || active.questionId !== questionId) {
        // Do not create another message for a stale button click.
        await editPlayerMessage(userId, {
            content: '⌛ This question has expired or was already answered.',
            embeds: [],
            components: [],
        });
        return;
    }

    if (Date.now() >= Number(active.deadlineAt)) {
        // Let the timeout handler own scoring and feedback to prevent double scoring.
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

    const outcome = await settleAnswer(interaction.user, active, Number(answerIndex), false);
    const { correct, delta, participant } = outcome;
    await R.clearActiveQuestion(userId);
    const session = await recordSessionAnswer(userId, outcome, false);
    const finished = session.answered >= QUESTIONS_PER_ATTEMPT;

    await editPlayerMessage(userId, {
        content: '',
        embeds: [finished ? E.attemptSummaryEmbed(session, participant.points, 'Completed') : E.resultEmbed({
            correct, timeout: false, delta, total: participant.points,
            question: active.question, questionNumber: session.answered,
        })],
        components: [],
    });

    if (finished) {
        await R.clearSession(userId);
        return;
    }

    setTimeout(async () => {
        try {
            const stateNow = await getLiveState();
            if (stateNow?.status === 'active') await postNextQuestion(makePlayerEditor(interaction.user));
            else await editPlayerMessage(userId, { content: '🏁 Boss Mode has ended. Your score has been saved.', embeds: [], components: [] });
        } catch (error) { console.error('[boss] next question failed:', error); }
    }, RESULT_PAUSE_MS);
}

async function handleBossCommand(interaction) {
    const action = interaction.options.getString('action');
    const duration = interaction.options.getInteger('duration') || 60;

    if (action === 'leaderboard') {
        const [rows, state] = await Promise.all([
            R.getLeaderboard(10),
            getLiveState(),
        ]);
        return interaction.reply({
            embeds: [E.leaderboardEmbed(rows, state?.status === 'active' ? 'LIVE' : 'ENDED')],
            flags: MessageFlags.Ephemeral,
        });
    }

    if (!isAdmin(interaction.user.id)) {
        return interaction.reply({
            content: '❌ You are not authorized to manage Boss Mode.',
            flags: MessageFlags.Ephemeral,
        });
    }

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
                content: 'No valid hard questions were found. Check weekly-questions-v5.json and its schema.',
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

        return interaction.reply({
            embeds: [E.eventEmbed(state, await R.getParticipantCount())],
            components: E.eventComponents(false),
        });
    }

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

        // Stop active timers and invalidate outstanding questions.
        const ids = await R.redis.smembers(`${R.PREFIX}participants`);
        for (const id of ids || []) {
            const timer = activeTimers.get(String(id));
            if (timer) clearTimeout(timer);
            activeTimers.delete(String(id));
            await R.clearActiveQuestion(id);
        }

        return interaction.reply({
            embeds: [E.eventEmbed(state, await R.getParticipantCount())],
            components: E.eventComponents(true),
        });
    }

    if (action === 'participants') {
        const rows = await R.getLeaderboard(100);
        const body = rows.length
            ? rows.map((player, index) =>
                `${index + 1}. <@${player.userId}> — **${player.points} pts** · ✅ ${player.correct} · ❌ ${player.incorrect} · ⏰ ${player.timeouts}`
            ).join('\n')
            : 'No participants yet.';

        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('⚔️ BOSS MODE PARTICIPANTS')
                .setDescription(body)
                .setTimestamp()],
            flags: MessageFlags.Ephemeral,
        });
    }

    if (action === 'reset') {
        const state = await getLiveState();
        if (state?.status === 'active') {
            return interaction.reply({
                content: 'End Boss Mode before resetting its data.',
                flags: MessageFlags.Ephemeral,
            });
        }

        for (const timer of activeTimers.values()) clearTimeout(timer);
        activeTimers.clear();
        liveResponses.clear();
        await R.clearBossData();

        return interaction.reply({
            content: '🧹 Boss Mode data has been cleared. Weekly Quiz data was not touched.',
            flags: MessageFlags.Ephemeral,
        });
    }
}

module.exports = {
    bossCommand,
    handleBossCommand,
    handleBossButton,
};
