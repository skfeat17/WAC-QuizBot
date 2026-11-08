// Boss Mode Redis storage. Separate namespace: Weekly Quiz data is untouched.
require('dotenv').config();
const { Redis } = require('@upstash/redis');

const redis = new Redis({
    url: process.env.NEW_WEEKLY_REDIS_REST_URL,
    token: process.env.NEW_WEEKLY_REDIS_REST_TOKEN,
});

const PREFIX = 'wac:boss:v1:';
const key = {
    state: `${PREFIX}state`,
    participants: `${PREFIX}participants`,
    participant: (id) => `${PREFIX}participant:${id}`,
    leaderboard: `${PREFIX}leaderboard`,
    activeQuestion: (id) => `${PREFIX}active-question:${id}`,
    session: (id) => `${PREFIX}session:${id}`,
};

async function getState() { return redis.get(key.state); }
async function setState(state) { return redis.set(key.state, state); }
async function getParticipant(userId) { return redis.get(key.participant(userId)); }

async function ensureParticipant(user) {
    const id = String(user.id);
    let participant = await getParticipant(id);
    if (!participant) {
        participant = {
            userId: id,
            username: user.username || `User ${id}`,
            points: 0,
            correct: 0,
            incorrect: 0,
            timeouts: 0,
            questionsAnswered: 0,
            updatedAt: Date.now(),
        };
        await redis.set(key.participant(id), participant);
        await redis.sadd(key.participants, id);
        await redis.zadd(key.leaderboard, { score: 0, member: id });
    }
    return participant;
}

async function saveParticipant(participant) {
    participant.updatedAt = Date.now();
    await redis.set(key.participant(participant.userId), participant);
    await redis.sadd(key.participants, String(participant.userId));
    await redis.zadd(key.leaderboard, {
        score: Number(participant.points) || 0,
        member: String(participant.userId),
    });
    return participant;
}

async function getLeaderboard(limit = 10) {
    const ids = await redis.zrange(key.leaderboard, 0, limit - 1, { rev: true });
    if (!ids?.length) return [];
    const rows = await Promise.all(ids.map((id) => getParticipant(id)));
    return rows.filter(Boolean);
}

async function getParticipantCount() {
    return Number(await redis.scard(key.participants)) || 0;
}

async function setActiveQuestion(userId, data) {
    // TTL is a safety net; question should expire shortly after the 10-second timer.
    return redis.set(key.activeQuestion(userId), data, { ex: 120 });
}
async function getActiveQuestion(userId) {
    return redis.get(key.activeQuestion(userId));
}
async function clearActiveQuestion(userId) {
    return redis.del(key.activeQuestion(userId));
}
async function getSession(userId) { return redis.get(key.session(userId)); }
async function setSession(userId, session) { return redis.set(key.session(userId), session, { ex: 86400 }); }
async function clearSession(userId) { return redis.del(key.session(userId)); }

async function clearBossData() {
    const ids = await redis.smembers(key.participants);
    const keys = [
        key.state, key.participants, key.leaderboard,
        ...ids.map((id) => key.participant(id)),
        ...ids.map((id) => key.activeQuestion(id)),
        ...ids.map((id) => key.session(id)),
    ];
    if (keys.length) await redis.del(...keys);
}

module.exports = {
    redis, PREFIX, getState, setState, getParticipant, ensureParticipant,
    saveParticipant, getLeaderboard, getParticipantCount,
    setActiveQuestion, getActiveQuestion, clearActiveQuestion,
    getSession, setSession, clearSession, clearBossData,
};
