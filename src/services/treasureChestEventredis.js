require("dotenv").config();

const { Redis } = require("@upstash/redis");

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PREFIX = "wac:treasure:";

// ==========================================
// 3 DAYS
// ==========================================

const TREASURE_COOLDOWN_SECONDS = 24 * 60 * 60;

// ==========================================
// COOLDOWN
// ==========================================

function getCooldownKey(userId) {
    return `${PREFIX}cooldown:${userId}`;
}

async function getTreasureCooldown(userId) {
    const key = getCooldownKey(userId);

    const ttl = await redis.ttl(key);

    if (ttl <= 0) {
        return 0;
    }

    return ttl;
}

async function hasTreasureCooldown(userId) {
    const ttl = await getTreasureCooldown(userId);

    return ttl > 0;
}

async function setTreasureCooldown(userId) {
    const key = getCooldownKey(userId);

    await redis.set(
        key,
        {
            userId,
            createdAt: Date.now(),
        },
        {
            ex: TREASURE_COOLDOWN_SECONDS,
        }
    );

    return true;
}

async function clearTreasureCooldown(userId) {
    const key = getCooldownKey(userId);

    await redis.del(key);

    return true;
}

// ==========================================
// CLEAR ALL TREASURE HISTORY
// ==========================================

async function clearAllTreasureCooldowns() {
    let cursor = 0;
    let deleted = 0;

    do {
        const result = await redis.scan(cursor, {
            match: `${PREFIX}cooldown:*`,
            count: 100,
        });

        cursor = Number(result[0]);

        const keys = result[1];

        if (keys.length > 0) {
            await redis.del(...keys);
            deleted += keys.length;
        }
    } while (cursor !== 0);

    return deleted;
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
    TREASURE_COOLDOWN_SECONDS,

    getTreasureCooldown,
    hasTreasureCooldown,
    setTreasureCooldown,
    clearTreasureCooldown,
    clearAllTreasureCooldowns,
};