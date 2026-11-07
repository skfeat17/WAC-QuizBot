// Redis persistence for the weekly competition.
// /weekly action:end removes every Redis key owned by this weekly system.
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
    dailyRecord: (userId, competitionId, date) => `${PREFIX}daily:${userId}:${competitionId}:${date}`,
    dailyRecords: () => `${PREFIX}daily-record-keys`,
    attempts: () => `${PREFIX}attempt-keys`,
    activeAttempts: () => `${PREFIX}active-attempt-keys`,
    activeAttemptsMigrated: () => `${PREFIX}active-attempts-migrated`,
    activeAttemptsMigrationLock: () => `${PREFIX}active-attempts-migration-lock`,
    operationLock: (id, day) => `${PREFIX}operation-lock:${id}:${day}`,
    usedQuestions: () => `${PREFIX}question-hashes`,
    usedSubjects: () => `${PREFIX}used-subject-hashes`,
    usedSubjectNames: () => `${PREFIX}used-subject-names`,
    emergencyIndex: () => `${PREFIX}emergency-question-index`,
    playerQuestionHistory: (userId) => `${PREFIX}player-question-history:${userId}`,
    playerAttemptHistory: (userId) => `${PREFIX}player-attempt-history:${userId}`,
    playerPointsHistory: (userId) => `${PREFIX}player-points-history:${userId}`,
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
    return redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        [key], [token],
    );
}
async function addQuestionsToPool(questions) {
    if (!questions?.length) return;
    await redis.rpush(keys.poolQueue(), ...questions.map((question) => JSON.stringify(question)));
}
async function takeQuestionFromPool() {
    const raw = await redis.lpop(keys.poolQueue());
    if (!raw) return null;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}
const getParticipant = (id) => redis.get(keys.participant(id));
const getAttempt = (id, day) => redis.get(keys.attempt(id, day));
const getDailyRecord = (userId, competitionId, date) =>
    redis.get(keys.dailyRecord(userId, competitionId, date));
async function setDailyRecord(userId, competitionId, date, record) {
    const key = keys.dailyRecord(userId, competitionId, date);
    await redis.set(key, record);
    await redis.sadd(keys.dailyRecords(), key);
    return record;
}
async function initializeDailyRecords(userId, state) {
    if (!userId || !state?.competitionId || !state?.startedAt) return [];
    const startDate = new Date(state.startedAt);
    startDate.setUTCHours(0, 0, 0, 0);
    const records = [];
    for (let offset = 0; offset < 7; offset += 1) {
        const day = new Date(startDate);
        day.setUTCDate(day.getUTCDate() + offset);
        const date = day.toISOString().slice(0, 10);
        const key = keys.dailyRecord(userId, state.competitionId, date);
        const record = {
            userId: String(userId), competitionId: String(state.competitionId), date,
            dayNumber: offset + 1, status: 'pending', questionsAnswered: 0,
            correctAnswers: 0, incorrectAnswers: 0, timedOut: 0, quizPoints: 0,
            streakBonus: 0, missedAttemptUsed: false, restoreStatus: 'available',
            createdAt: Date.now(), updatedAt: Date.now(),
        };
        // Never overwrite progress when a participant returns or a command is retried.
        await redis.set(key, record, { nx: true });
        await redis.sadd(keys.dailyRecords(), key);
        records.push(await redis.get(key));
    }
    return records;
}
async function getDailyRecords(userId, competitionId) {
    const allKeys = await redis.smembers(keys.dailyRecords());
    const prefix = `${PREFIX}daily:${userId}:${competitionId}:`;
    const matching = (allKeys || []).filter((key) => String(key).startsWith(prefix));
    const rows = await Promise.all(matching.map(async (key) => {
        const row = await redis.get(key);
        if (!row) await redis.srem(keys.dailyRecords(), key);
        return row || null;
    }));
    return rows.filter(Boolean).sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

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
        redis.zadd(keys.leaderboard(), { score: Number(participant.points) || 0, member: participant.userId }),
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
    // Save the authoritative attempt first; index updates never delete the attempt.
    await redis.set(key, attempt);
    const indexUpdates = [redis.sadd(keys.attempts(), key)];
    if (attempt?.status === 'active') {
        indexUpdates.push(redis.sadd(keys.activeAttempts(), key));
    } else {
        indexUpdates.push(redis.srem(keys.activeAttempts(), key));
    }
    await Promise.all(indexUpdates);
}

async function deleteAttempt(userId, day) {
    const key = keys.attempt(userId, day);
    await Promise.all([
        redis.del(key),
        redis.srem(keys.attempts(), key),
        redis.srem(keys.activeAttempts(), key),
    ]);
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

// One-time, non-destructive migration: index currently active attempts that predate this optimization.
// Existing attempt records and question history are read only, never deleted by migration.
async function ensureActiveAttemptsMigrated() {
    if (await redis.get(keys.activeAttemptsMigrated())) return;

    const lock = await acquireLock(keys.activeAttemptsMigrationLock(), 60);
    if (!lock) return; // Another process is migrating; retry on the next scheduler tick.

    try {
        if (await redis.get(keys.activeAttemptsMigrated())) return;
        const attemptKeys = await redis.smembers(keys.attempts());
        const activeKeys = [];

        for (const key of (attemptKeys || [])) {
            const attempt = await redis.get(key);
            if (attempt?.status === 'active') activeKeys.push(key);
        }

        if (activeKeys.length) {
            await redis.sadd(keys.activeAttempts(), ...activeKeys);
        }
        await redis.set(keys.activeAttemptsMigrated(), '1');
    } finally {
        await releaseLock(keys.activeAttemptsMigrationLock(), lock).catch(() => {});
    }
}

async function getActiveAttempts() {
    await ensureActiveAttemptsMigrated();
    const attemptKeys = await redis.smembers(keys.activeAttempts());
    const rows = await Promise.all((attemptKeys || []).map(async (key) => {
        const attempt = await redis.get(key);
        if (!attempt || attempt.status !== 'active') {
            await redis.srem(keys.activeAttempts(), key);
            return null;
        }
        return attempt;
    }));
    return rows.filter(Boolean);
}

// Permanent per-player history. clearWeeklyData intentionally never deletes these sets.
const getUsedQuestionIds = async (userId) =>
    (await redis.smembers(keys.playerQuestionHistory(userId)) || []).map(String);
const hasPlayerUsedQuestion = async (userId, questionId) =>
    Boolean(await redis.sismember(keys.playerQuestionHistory(userId), String(questionId)));
const markQuestionUsed = async (userId, questionId) =>
    redis.sadd(keys.playerQuestionHistory(userId), String(questionId));

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


async function appendAttemptHistory(userId, attempt) {
    await redis.lpush(keys.playerAttemptHistory(userId), JSON.stringify(attempt));
    await redis.ltrim(keys.playerAttemptHistory(userId), 0, 99);
}
async function getAttemptHistory(userId, limit = 20) {
    const rows = await redis.lrange(keys.playerAttemptHistory(userId), 0, Math.max(0, limit - 1));
    return (rows || []).map((row) => {
        if (typeof row === 'string') { try { return JSON.parse(row); } catch { return null; } }
        return row;
    }).filter(Boolean);
}
async function appendPointsHistory(userId, entry) {
    await redis.lpush(keys.playerPointsHistory(userId), JSON.stringify(entry));
    await redis.ltrim(keys.playerPointsHistory(userId), 0, 199);
}
async function getPointsHistory(userId, limit = 20) {
    const rows = await redis.lrange(keys.playerPointsHistory(userId), 0, Math.max(0, limit - 1));
    return (rows || []).map((row) => {
        if (typeof row === 'string') { try { return JSON.parse(row); } catch { return null; } }
        return row;
    }).filter(Boolean);
}


async function deleteAttemptDayHistory(userId, dayKey) {
    const attemptHistoryKey = keys.playerAttemptHistory(userId);
    const pointsHistoryKey = keys.playerPointsHistory(userId);
    const [attemptRows, pointsRows] = await Promise.all([
        redis.lrange(attemptHistoryKey, 0, -1),
        redis.lrange(pointsHistoryKey, 0, -1),
    ]);
    const parse = (row) => {
        if (typeof row !== 'string') return row;
        try { return JSON.parse(row); } catch { return null; }
    };
    const keptAttempts = (attemptRows || []).map(parse).filter((row) => row && row.dayKey !== dayKey);
    const keptPoints = (pointsRows || []).map(parse).filter((row) => row && row.dayKey !== dayKey);
    await Promise.all([
        redis.del(attemptHistoryKey, pointsHistoryKey),
        ...(keptAttempts.length ? [redis.rpush(attemptHistoryKey, ...keptAttempts.map((row) => JSON.stringify(row)))] : []),
        ...(keptPoints.length ? [redis.rpush(pointsHistoryKey, ...keptPoints.map((row) => JSON.stringify(row)))] : []),
    ]);
}

async function deleteUserData(userId) {
    const trackedKeys = await redis.smembers(keys.attempts());
    const userAttemptKeys = (trackedKeys || []).filter((key) => String(key).startsWith(`${PREFIX}attempt:${userId}:`));
    const reattemptKeys = [];
    for (const key of userAttemptKeys) {
        const dayKey = String(key).slice(`${PREFIX}attempt:${userId}:`.length);
        const reattempt = `${keys.participant(userId)}:reattempt:${dayKey}`;
        reattemptKeys.push(reattempt, `${reattempt}:bonus`, keys.operationLock(userId, dayKey));
    }
    const existingReattemptKeys = await redis.keys(`${keys.participant(userId)}:reattempt:*`);
    const toDelete = [
        keys.participant(userId), keys.playerAttemptHistory(userId), keys.playerPointsHistory(userId),
        keys.playerQuestionHistory(userId), ...userAttemptKeys, ...reattemptKeys,
        ...((await redis.smembers(keys.dailyRecords())) || []).filter((key) => String(key).startsWith(`${PREFIX}daily:${userId}:`)),
        ...(existingReattemptKeys || []),
    ];
    if (toDelete.length) await redis.del(...toDelete);
    await Promise.all([
        redis.srem(keys.participants(), userId),
        redis.zrem(keys.leaderboard(), userId),
        ...(userAttemptKeys.length ? [redis.srem(keys.attempts(), ...userAttemptKeys), redis.srem(keys.activeAttempts(), ...userAttemptKeys)] : []),
    ]);
    const dailyKeys = toDelete.filter((key) => String(key).startsWith(`${PREFIX}daily:${userId}:`));
    if (dailyKeys.length) await redis.srem(keys.dailyRecords(), ...dailyKeys);
    return userAttemptKeys.length;
}

async function clearWeeklyData() {
    // Complete reset: delete every key owned by this weekly system, including
    // participant profiles, all attempts/histories, reattempt flags, used-question
    // history, question/subject deduplication sets, pools, locks, and indexes.
    // The PREFIX is dedicated to Weekly World Quiz, so unrelated bot data is safe.
    const allWeeklyKeys = await redis.keys(`${PREFIX}*`);
    const keysToDelete = [...new Set([
        ...(allWeeklyKeys || []),
        // This global visibility toggle belongs to the weekly quiz but uses a
        // legacy key outside PREFIX.
        'weekly:rankings:hidden',
    ])];

    // Keep each DEL request reasonably small for Redis/Upstash.
    const batchSize = 100;
    for (let i = 0; i < keysToDelete.length; i += batchSize) {
        await redis.del(...keysToDelete.slice(i, i + batchSize));
    }

    return keysToDelete.length;
}

module.exports = {
    redis, keys, getState, setState, getPool, setPool, getQuestionPoolSize,
    addQuestionsToPool, takeQuestionFromPool, nextEmergencyQuestionIndex, join,
    getParticipant, saveParticipant, getLeaderboard, getAttempt, setAttempt,
    getDailyRecord, setDailyRecord, initializeDailyRecords, getDailyRecords,
    deleteAttempt, deleteAttemptDayHistory, deleteUserData, getTrackedAttempts, getActiveAttempts, acquireLock, releaseLock,
    hasQuestionBeenUsed, hasSubjectBeenUsed, getUsedSubjectNames, getUsedQuestionTexts,
    markQuestionsAndSubjectsUsed, getUsedQuestionIds, hasPlayerUsedQuestion,
    markQuestionUsed, clearWeeklyData, appendAttemptHistory, getAttemptHistory, appendPointsHistory, getPointsHistory,

};
