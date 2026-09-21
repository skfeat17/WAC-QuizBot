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
const EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;
const PREFIX = "wac:dailyquiz:";

// ==========================================
// COOLDOWN
// ==========================================

function cooldownKey(type, userId) {
    return `${PREFIX}${type}:cooldown:${userId}`;
}

async function getUserCooldown(type, userId) {
    return await redis.ttl(cooldownKey(type, userId));
}

async function hasUserCooldown(type, userId) {
    try {
        return (await getUserCooldown(type, userId)) > 0;
    } catch (error) {
        console.error("❌ Redis cooldown check error:", error.message);
        throw error;
    }
}

async function setUserCooldown(type, userId) {
    await redis.set(
        cooldownKey(type, userId),
        {
            participatedAt: Date.now(),
            type,
            userId,
        },
        { ex: COOLDOWN_SECONDS }
    );
}

async function redisDeleteUserCooldown(type, userId) {
    await redis.del(cooldownKey(type, userId));
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
        { ex: EVENT_TTL_SECONDS }
    );
}

async function getEvent(eventId) {
    return await redis.get(eventKey(eventId));
}

async function updateEvent(eventId, event) {
    await redis.set(
        eventKey(eventId),
        event,
        { ex: EVENT_TTL_SECONDS }
    );
}

// ==========================================
// ACTIVE EVENT LOCK
// ==========================================

const ACTIVE_EVENT_KEY = `${PREFIX}active`;

async function getActiveEventId() {
    try {
        return await redis.get(ACTIVE_EVENT_KEY);
    } catch (error) {
        console.error("❌ Redis active event read error:", error.message);
        return null;
    }
}

async function acquireActiveEvent(eventId) {
    try {
        const result = await redis.set(
            ACTIVE_EVENT_KEY,
            String(eventId),
            {
                nx: true,
                ex: EVENT_TTL_SECONDS,
            }
        );

        return result === "OK";
    } catch (error) {
        console.error("❌ Redis active event lock error:", error.message);
        throw error;
    }
}

async function releaseActiveEvent(eventId) {
    try {
        const currentEventId = await redis.get(ACTIVE_EVENT_KEY);

        if (
            currentEventId !== null &&
            String(currentEventId) === String(eventId)
        ) {
            await redis.del(ACTIVE_EVENT_KEY);
            return true;
        }

        return false;
    } catch (error) {
        console.error("❌ Redis active event release error:", error.message);
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
    const normalizedAnswers = Array.isArray(answers)
        ? answers.map(normalizeContextPart).sort()
        : [];

    return [
        normalizeContextPart(type),
        normalizeContextPart(country),
        normalizeContextPart(prompt),
        normalizedAnswers.join("|"),
        normalizeContextPart(scrambled),
    ].join(" :: ");
}

async function hasQuestionBeenUsed(type, context) {
    return await redis.sismember(questionHistoryKey(type), context);
}

async function saveQuestionContext(type, context) {
    await redis.sadd(questionHistoryKey(type), context);
}

async function saveQuestionContexts(type, contexts) {
    if (!Array.isArray(contexts) || contexts.length === 0) return;

    const uniqueContexts = [...new Set(contexts)];
    await redis.sadd(questionHistoryKey(type), ...uniqueContexts);
}

async function getStoredQuestionContexts(type) {
    const contexts = await redis.smembers(questionHistoryKey(type));
    return Array.isArray(contexts) ? contexts : [];
}

// ==========================================
// CLEAR ALL DAILY EVENT COOLDOWNS
// ==========================================

async function clearAllUserCooldowns() {
    let cursor = 0;
    let deleted = 0;

    try {
        do {
            const result = await redis.scan(cursor, {
                match: `${PREFIX}*:cooldown:*`,
                count: 200,
            });

            // @upstash/redis normally returns [cursor, keys].
            // Accept the object form too so /kill history does not fail
            // if the SDK/runtime returns a structured scan response.
            let nextCursor;
            let keys;

            if (Array.isArray(result)) {
                nextCursor = result[0];
                keys = result[1] || [];
            } else {
                nextCursor = result?.cursor ?? 0;
                keys = result?.keys || [];
            }

            cursor = Number(nextCursor) || 0;
            keys = Array.isArray(keys) ? keys : [];

            if (keys.length > 0) {
                // Delete in safe chunks.
                for (let i = 0; i < keys.length; i += 100) {
                    const chunk = keys.slice(i, i + 100);
                    await redis.del(...chunk);
                    deleted += chunk.length;
                }
            }
        } while (cursor !== 0);

        console.log(`🧹 Cleared ${deleted} Daily Event participation cooldown(s).`);
        return deleted;
    } catch (error) {
        console.error("❌ Failed to clear Daily Event cooldowns:", error.message);
        throw error;
    }
}

module.exports = {
    COOLDOWN_SECONDS,
    clearAllUserCooldowns,
    getUserCooldown,
    hasUserCooldown,
    setUserCooldown,
    redisDeleteUserCooldown,
    saveEvent,
    getEvent,
    updateEvent,
    getActiveEventId,
    acquireActiveEvent,
    releaseActiveEvent,
    createQuestionContext,
    hasQuestionBeenUsed,
    saveQuestionContext,
    saveQuestionContexts,
    getStoredQuestionContexts,
};
