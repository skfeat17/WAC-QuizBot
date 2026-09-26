require("dotenv").config();

const { Redis } = require("@upstash/redis");

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PREFIX = "wac:treasure:";

// ==========================================
// CONFIG
// ==========================================

// 3 DAYS
const TREASURE_COOLDOWN_SECONDS = 24 * 60 * 60;

// Active chest can remain available for 24 hours
const TREASURE_CHEST_TTL_SECONDS =
    24 * 60 * 60;

// Prevent two people from claiming
// the same chest simultaneously
const TREASURE_CLAIM_LOCK_SECONDS = 30;

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
    const ttl =
        await getTreasureCooldown(userId);

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
// ACTIVE TREASURE CHESTS
// ==========================================

function getActiveChestKey(eventId) {
    return `${PREFIX}active:${eventId}`;
}

async function saveActiveTreasureChest(chest) {
    const key =
        getActiveChestKey(chest.eventId);

    await redis.set(
        key,
        chest,
        {
            ex: TREASURE_CHEST_TTL_SECONDS,
        }
    );

    return true;
}

async function getActiveTreasureChest(eventId) {
    const key =
        getActiveChestKey(eventId);

    return await redis.get(key);
}

async function deleteActiveTreasureChest(eventId) {
    const key =
        getActiveChestKey(eventId);

    await redis.del(key);

    return true;
}

// ==========================================
// ATOMIC TREASURE CLAIM LOCK
// ==========================================

function getTreasureClaimLockKey(eventId) {
    return `${PREFIX}claim:${eventId}`;
}

/**
 * Only ONE person can successfully claim
 * a particular treasure chest.
 *
 * Redis NX = create only if key doesn't exist.
 *
 * If two people click at the same time:
 *
 * User A -> OK
 * User B -> null
 *
 * Therefore only one winner.
 */
async function claimTreasureChest(
    eventId,
    userId
) {
    const key =
        getTreasureClaimLockKey(eventId);

    const result = await redis.set(
        key,
        {
            userId,
            claimedAt: Date.now(),
        },
        {
            nx: true,
            ex: TREASURE_CLAIM_LOCK_SECONDS,
        }
    );

    return result === "OK";
}
async function setTreasureCooldownForDuration(userId, seconds) {
    const key = getCooldownKey(userId);

    await redis.set(
        key,
        {
            userId,
            createdAt: Date.now(),
            restoredByAdmin: true,
        },
        {
            ex: seconds,
        }
    );

    return true;
}
// ==========================================
// EXPORTS
// ==========================================

module.exports = {
    // Cooldown
    TREASURE_COOLDOWN_SECONDS,
    getTreasureCooldown,
    hasTreasureCooldown,
    setTreasureCooldown,
    clearTreasureCooldown,
    clearAllTreasureCooldowns,
    setTreasureCooldownForDuration,
    // Active chest
    saveActiveTreasureChest,
    getActiveTreasureChest,
    deleteActiveTreasureChest,

    // Atomic winner lock
    claimTreasureChest,
};