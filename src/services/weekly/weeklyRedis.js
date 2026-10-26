// Redis persistence for the weekly competition.
// Used-question and used-subject history deliberately survives /weekly action:end.
require('dotenv').config();
const { Redis } = require('@upstash/redis');
const crypto = require('node:crypto');

const redis = new Redis({
    url: process.env.NEW_WEEKLY_REDIS_REST_URL,
    token: process.env.NEW_WEEKLY_REDIS_REST_TOKEN,
});

const PREFIX = 'wac:weekly:v2:';
const keys = {
    state: () => `${PREFIX}state`,
    pool: () => `${PREFIX}question-pool`,
    poolQueue: () => `${PREFIX}question-queue`,
    leaderboard: () => `${PREFIX}leaderboard`,
    participants: () => `${PREFIX}participants`,
    participant: (id) => `${PREFIX}participant:${id}`,
    attempt: (id, day) => `${PREFIX}attempt:${id}:${day}`,
    attempts: () => `${PREFIX}attempt-keys`,
    operationLock: (id, day) => `${PREFIX}operation-lock:${id}:${day}`,
    usedQuestions: () => `${PREFIX}question-hashes`,
    usedSubjects: () => `${PREFIX}used-subject-hashes`,
    usedSubjectNames: () => `${PREFIX}used-subject-names`,
    emergencyIndex: () => `${PREFIX}emergency-question-index`,
};

const getState = () => redis.get(keys.state());
const setState = (value) => redis.set(keys.state(), value);
const getPool = () => redis.get(keys.pool());
const setPool = (value) => redis.set(keys.pool(), value);
const getQuestionPoolSize = () => redis.llen(keys.poolQueue());
const nextEmergencyQuestionIndex = () => redis.incr(keys.emergencyIndex());

async function acquireLock(key, ttlSeconds = 30) {
    const token = crypto.randomUUID();
    const result = await redis.set(key, token, { nx: true, ex: ttlSeconds });
    return result ? token : null;
}

async function releaseLock(key, token) {
    if (!token) return 0;
    // Compare-and-delete ensures an expired lock's successor is never deleted by its predecessor.
    return redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        [key],
        [token],
    );
}

async function addQuestionsToPool(questions) {
    if (!questions?.length) return;
    await redis.rpush(keys.poolQueue(), ...questions.map((question) => JSON.stringify(question)));
}

async function takeQuestionFromPool() {
    const raw = await redis.lpop(keys.poolQueue());
    if (!raw) return null;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return null; }
}

const getParticipant = (id) => redis.get(keys.participant(id));
const getAttempt = (id, day) => redis.get(keys.attempt(id, day));

async function join(userId, displayName) {
    const participant = {
        userId, displayName, joinedAt: Date.now(),
        points: 0, correct: 0, incorrect: 0, answered: 0,
    };
    const created = await redis.set(keys.participant(userId), participant, { nx: true });
    if (!created) return { joined: false, participant: await getParticipant(userId) };
    await Promise.all([
        redis.sadd(keys.participants(), userId),
        redis.zadd(keys.leaderboard(), { score: 0, member: userId }),
    ]);
    return { joined: true, participant };
}

async function saveParticipant(participant) {
    await Promise.all([
        redis.set(keys.participant(participant.userId), participant),
        redis.zadd(keys.leaderboard(), {
            score: Number(participant.points) || 0,
            member: participant.userId,
        }),
    ]);
}

async function getLeaderboard(limit = 1000) {
    const ids = await redis.zrange(keys.leaderboard(), 0, limit - 1, { rev: true });
    const players = await Promise.all(ids.map(async (row) => {
        const id = typeof row === 'string' ? row : row.member;
        const participant = await getParticipant(id);
        return participant ? { ...participant, points: Number(participant.points) || 0 } : null;
    }));
    return players.filter(Boolean);
}

async function setAttempt(userId, day, attempt) {
    const key = keys.attempt(userId, day);
    await Promise.all([redis.set(key, attempt), redis.sadd(keys.attempts(), key)]);
}

async function deleteAttempt(userId, day) {
    const key = keys.attempt(userId, day);
    await Promise.all([redis.del(key), redis.srem(keys.attempts(), key)]);
}

async function getTrackedAttempts() {
    const attemptKeys = await redis.smembers(keys.attempts());
    const rows = await Promise.all((attemptKeys || []).map(async (key) => {
        const attempt = await redis.get(key);
        if (!attempt) await redis.srem(keys.attempts(), key);
        return attempt || null;
    }));
    return rows.filter(Boolean);
}

const hasQuestionBeenUsed = async (hash) => Boolean(await redis.sismember(keys.usedQuestions(), hash));
const hasSubjectBeenUsed = async (hash) => Boolean(await redis.sismember(keys.usedSubjects(), hash));
const getUsedSubjectNames = async () => redis.smembers(keys.usedSubjectNames());
const getUsedQuestionTexts = async () => redis.smembers(keys.usedQuestions());

async function markQuestionsAndSubjectsUsed(questions) {
    if (!questions.length) return;
    await Promise.all([
        redis.sadd(keys.usedQuestions(), ...questions.map((q) => q.questionHash)),
        redis.sadd(keys.usedSubjects(), ...questions.map((q) => q.subjectHash)),
        redis.sadd(keys.usedSubjectNames(), ...questions.map((q) => q.subject)),
    ]);
}

async function clearWeeklyData() {
    const [participantIds, attemptKeys] = await Promise.all([
        redis.smembers(keys.participants()),
        redis.smembers(keys.attempts()),
    ]);
    const toDelete = [
        keys.state(), keys.pool(), keys.poolQueue(), keys.leaderboard(), keys.participants(), keys.attempts(),
        ...(participantIds || []).map((id) => keys.participant(id)),
        ...(attemptKeys || []),
    ];
    if (toDelete.length) await redis.del(...toDelete);
}

module.exports = {
    redis, keys, getState, setState, getPool, setPool, getQuestionPoolSize,
    addQuestionsToPool, takeQuestionFromPool, nextEmergencyQuestionIndex, join,
    getParticipant, saveParticipant, getLeaderboard, getAttempt, setAttempt,
    deleteAttempt, getTrackedAttempts, acquireLock, releaseLock, hasQuestionBeenUsed,
    hasSubjectBeenUsed, getUsedSubjectNames, getUsedQuestionTexts,
    markQuestionsAndSubjectsUsed, clearWeeklyData,
};
