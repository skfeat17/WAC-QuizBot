require("dotenv").config();

const { Redis } = require("@upstash/redis");

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ==========================================
// SETTINGS
// ==========================================

const COOLDOWN_SECONDS = 24 * 60 * 60;

const PREFIX = "wac:dailyquiz:";

// ==========================================
// COOLDOWN KEYS
// ==========================================

function cooldownKey(type, userId) {
    return `${PREFIX}${type}:cooldown:${userId}`;
}

async function getUserCooldown(type, userId) {
    return await redis.ttl(
        cooldownKey(type, userId)
    );
}

async function hasUserCooldown(type, userId) {
    const key = cooldownKey(type, userId);

    try {
        const exists = await redis.exists(key);

        return exists === 1;
    } catch (error) {
        console.error(
            "❌ Redis cooldown check error:",
            error.message
        );

        throw error;
    }
}

async function setUserCooldown(type, userId) {
    const key = cooldownKey(type, userId);

    try {
        await redis.set(
            key,
            JSON.stringify({
                participatedAt: Date.now(),
                type,
                userId,
            }),
            {
                ex: COOLDOWN_SECONDS,
            }
        );

        console.log(
            `🔒 Daily Quiz cooldown set: ${type} → ${userId}`
        );
    } catch (error) {
        console.error(
            "❌ Failed to set Daily Quiz cooldown:",
            error.message
        );

        throw error;
    }
}

async function redisDeleteUserCooldown(type, userId) {
    await redis.del(
        cooldownKey(type, userId)
    );
}

// ==========================================
// EVENT STORAGE
// ==========================================

function eventKey(eventId) {
    return `${PREFIX}event:${eventId}`;
}

async function saveEvent(eventId, event) {
    await redis.set(
        eventKey(eventId),
        event,
        {
            ex: COOLDOWN_SECONDS,
        }
    );
}

async function getEvent(eventId) {
    return await redis.get(
        eventKey(eventId)
    );
}

async function updateEvent(eventId, event) {
    await redis.set(
        eventKey(eventId),
        event,
        {
            ex: COOLDOWN_SECONDS,
        }
    );
}


// ==========================================
// ACTIVE DAILY QUIZ LOCK
// ==========================================

const ACTIVE_EVENT_KEY = `${PREFIX}active`;

async function getActiveEventId() {
    try {
        return await redis.get(ACTIVE_EVENT_KEY);
    } catch (error) {
        console.error(
            "Redis active event read error:",
            error.message
        );
        return null;
    }
}

async function acquireActiveEvent(eventId) {
    try {
        const result = await redis.set(
            ACTIVE_EVENT_KEY,
            eventId,
            {
                nx: true,
                ex: COOLDOWN_SECONDS,
            }
        );

        return result === "OK";
    } catch (error) {
        console.error(
            "Redis active event lock error:",
            error.message
        );
        throw error;
    }
}

async function releaseActiveEvent(eventId) {
    try {
        const currentEventId =
            await redis.get(ACTIVE_EVENT_KEY);

        if (
            currentEventId !== null &&
            String(currentEventId) === String(eventId)
        ) {
            await redis.del(ACTIVE_EVENT_KEY);
            return true;
        }

        return false;
    } catch (error) {
        console.error(
            "Redis active event release error:",
            error.message
        );
        return false;
    }
}

// ==========================================
// QUESTION HISTORY
// ==========================================

function questionHistoryKey(type) {
    return `${PREFIX}questions:${type}`;
}

function normalizeContextPart(value) {
    return String(value ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function createQuestionContext({
    type,
    country,
    prompt,
    answers,
    scrambled,
}) {
    const normalizedAnswers =
        Array.isArray(answers)
            ? answers
                .map(normalizeContextPart)
                .sort()
            : [];

    return [
        normalizeContextPart(type),
        normalizeContextPart(country),
        normalizeContextPart(prompt),
        normalizedAnswers.join("|"),
        normalizeContextPart(scrambled),
    ].join(" :: ");
}

async function hasQuestionBeenUsed(
    type,
    context
) {
    return await redis.sismember(
        questionHistoryKey(type),
        context
    );
}

async function saveQuestionContext(
    type,
    context
) {
    await redis.sadd(
        questionHistoryKey(type),
        context
    );
}

async function saveQuestionContexts(
    type,
    contexts
) {
    if (
        !Array.isArray(contexts) ||
        contexts.length === 0
    ) {
        return;
    }

    const uniqueContexts =
        [...new Set(contexts)];

    await redis.sadd(
        questionHistoryKey(type),
        ...uniqueContexts
    );
}

async function getStoredQuestionContexts(type) {
    const contexts =
        await redis.smembers(
            questionHistoryKey(type)
        );

    return Array.isArray(contexts)
        ? contexts
        : [];
}
async function clearAllUserCooldowns() {
    console.log("🧹 Starting clearAllUserCooldowns...");

    const types = [
        "currency",
        "capital",
        "food",
        "unscramble",
    ];

    let deleted = 0;

    for (const type of types) {
        console.log(`🔎 Checking ${type} cooldowns...`);

        let cursor = 0;

        do {
            console.log(`🔎 Scanning ${type}, cursor:`, cursor);

            const result = await redis.scan(cursor, {
                match: `${PREFIX}${type}:cooldown:*`,
                count: 100,
            });

            console.log(`📦 Scan result for ${type}:`, result);

            // Upstash returns cursor as a string
            cursor = Number(result[0]);

            const keys = result[1];

            if (keys.length > 0) {
                console.log(
                    `🗑️ Deleting ${keys.length} ${type} cooldown(s)...`
                );

                await redis.del(...keys);

                deleted += keys.length;
            }
        } while (cursor !== 0);
    }

    console.log(
        `✅ clearAllUserCooldowns finished. Deleted: ${deleted}`
    );

    return deleted;
}
// ==========================================
// EXPORTS
// ==========================================

module.exports = {
    COOLDOWN_SECONDS,

    clearAllUserCooldowns,
    getUserCooldown,
    hasUserCooldown,
    setUserCooldown,
redisDeleteUserCooldown,
    // Events
    saveEvent,
    getEvent,
    updateEvent,
    getActiveEventId,
    acquireActiveEvent,
    releaseActiveEvent,

    // Question history
    createQuestionContext,
    hasQuestionBeenUsed,
    saveQuestionContext,
    saveQuestionContexts,
    getStoredQuestionContexts,
};
