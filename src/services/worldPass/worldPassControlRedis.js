
// src/services/worldPass/worldPassControlRedis.js

require("dotenv").config();

const { Redis } = require("@upstash/redis");

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PREFIX = "wac:worldpass:control:";

const ACTIVE_KEY = `${PREFIX}active`;
const STATS_KEY = `${PREFIX}statistics`;

async function isWorldPassChallengeActive() {
    const value = await redis.get(ACTIVE_KEY);

    return (
        value === true ||
        value === "true" ||
        value === 1 ||
        value === "1"
    );
}

async function setWorldPassChallengeActive(active) {
    await redis.set(ACTIVE_KEY, active ? "true" : "false");
    return true;
}

async function getWorldPassChallengeStatus() {
    const value = await redis.get(ACTIVE_KEY);

    return {
        active: await isWorldPassChallengeActive(),
        storedValue: value,
        key: ACTIVE_KEY,
    };
}

async function incrementWorldPassStat(field, amount = 1) {
    return redis.hincrby(
        STATS_KEY,
        field,
        Number(amount) || 1
    );
}

async function getWorldPassStatistics() {
    const stats = await redis.hgetall(STATS_KEY) || {};

    return {
        entries: Number(stats.entries) || 0,
        correct: Number(stats.correct) || 0,
        incorrect: Number(stats.incorrect) || 0,
        expired: Number(stats.expired) || 0,
        passesSpent: Number(stats.passesSpent) || 0,
        moraQueued: Number(stats.moraQueued) || 0,
    };
}

module.exports = {
    isWorldPassChallengeActive,
    setWorldPassChallengeActive,
    getWorldPassChallengeStatus,
    incrementWorldPassStat,
    getWorldPassStatistics,
};
