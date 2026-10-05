// mysteryEventRedis.js
require("dotenv").config();

const { Redis } = require("@upstash/redis");

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ==========================================
// SETTINGS
// ==========================================

const PREFIX = "wac:mysteryevent:";

const EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;

// Random player cooldown: 12–16 hours.
const MIN_COOLDOWN_SECONDS = 16 * 60 * 60;
const MAX_COOLDOWN_SECONDS = 24 * 60 * 60;

// Question pool.
const QUESTION_POOL_TARGET = 20;
const QUESTION_POOL_MINIMUM = 5;

// Users who never receive a Mystery Event cooldown.
const MYSTERY_EVENT_COOLDOWN_IMMUNE = [
    "1295671787375296542",
    "1242132608574292118",
];

// ==========================================
// KEY HELPERS
// ==========================================

function eventKey(eventId) {
    return `${PREFIX}event:${eventId}`;
}

function cooldownKey(userId) {
    return `${PREFIX}cooldown:${userId}`;
}

function attemptKey(attemptId) {
    return `${PREFIX}attempt:${attemptId}`;
}

function questionHistoryKey() {
    return `${PREFIX}questions`;
}

function questionSubjectHistoryKey() {
    return `${PREFIX}subjects`;
}

function questionPoolKey() {
    return `${PREFIX}pool`;
}

// ==========================================
// RANDOM COOLDOWN
// ==========================================

function generateRandomCooldownSeconds() {
    const range =
        MAX_COOLDOWN_SECONDS -
        MIN_COOLDOWN_SECONDS +
        1;

    return (
        Math.floor(Math.random() * range) +
        MIN_COOLDOWN_SECONDS
    );
}

// ==========================================
// COOLDOWN
// ==========================================

async function getMysteryCooldown(userId) {
    try {
        return await redis.ttl(
            cooldownKey(userId)
        );
    } catch (error) {
        console.error(
            "❌ Mystery cooldown read error:",
            error.message
        );

        throw error;
    }
}

async function hasMysteryCooldown(userId) {
    if (
        MYSTERY_EVENT_COOLDOWN_IMMUNE.includes(
            String(userId)
        )
    ) {
        return false;
    }

    try {
        return (
            await getMysteryCooldown(userId)
        ) > 0;
    } catch (error) {
        console.error(
            "❌ Mystery cooldown check error:",
            error.message
        );

        throw error;
    }
}

/**
 * Atomically claims a random cooldown.
 *
 * Returns:
 *
 * {
 *     claimed: true,
 *     cooldownSeconds: 12345
 * }
 *
 * OR:
 *
 * {
 *     claimed: false,
 *     cooldownSeconds: null
 * }
 *
 * NX prevents rapid double-clicks from
 * creating/replacing the cooldown.
 */
async function claimMysteryCooldown(userId) {
    if (
        MYSTERY_EVENT_COOLDOWN_IMMUNE.includes(
            String(userId)
        )
    ) {
        return {
            claimed: true,
            cooldownSeconds: 0,
        };
    }

    const cooldownSeconds =
        generateRandomCooldownSeconds();

    try {
        const result = await redis.set(
            cooldownKey(userId),
            {
                userId: String(userId),
                createdAt: Date.now(),
                cooldownSeconds,
            },
            {
                nx: true,
                ex: cooldownSeconds,
            }
        );

        return {
            claimed: result === "OK",
            cooldownSeconds:
                result === "OK"
                    ? cooldownSeconds
                    : null,
        };
    } catch (error) {
        console.error(
            "❌ Mystery cooldown claim error:",
            error.message
        );

        throw error;
    }
}

async function setMysteryCooldown(
    userId,
    cooldownSeconds = null
) {
    if (
        MYSTERY_EVENT_COOLDOWN_IMMUNE.includes(
            String(userId)
        )
    ) {
        return {
            cooldownSeconds: 0,
        };
    }

    const seconds =
        Number.isInteger(cooldownSeconds) &&
        cooldownSeconds >=
            MIN_COOLDOWN_SECONDS &&
        cooldownSeconds <=
            MAX_COOLDOWN_SECONDS
            ? cooldownSeconds
            : generateRandomCooldownSeconds();

    try {
        await redis.set(
            cooldownKey(userId),
            {
                userId: String(userId),
                createdAt: Date.now(),
                cooldownSeconds: seconds,
            },
            {
                ex: seconds,
            }
        );

        return {
            cooldownSeconds: seconds,
        };
    } catch (error) {
        console.error(
            "❌ Mystery cooldown set error:",
            error.message
        );

        throw error;
    }
}

async function clearMysteryCooldown(userId) {
    try {
        const deleted = await redis.del(
            cooldownKey(userId)
        );

        return Number(deleted) > 0;
    } catch (error) {
        console.error(
            "❌ Mystery cooldown clear error:",
            error.message
        );

        throw error;
    }
}

async function listAllMysteryCooldowns() {
    let cursor = 0;
    const cooldowns = [];

    try {
        do {
            const result = await redis.scan(
                cursor,
                {
                    match: `${PREFIX}cooldown:*`,
                    count: 200,
                }
            );

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

            for (const key of keys) {
                const ttl = Number(await redis.ttl(key));

                if (ttl <= 0) {
                    continue;
                }

                const prefix = `${PREFIX}cooldown:`;
                const userId = String(key).startsWith(prefix)
                    ? String(key).slice(prefix.length)
                    : null;

                if (!userId) {
                    continue;
                }

                cooldowns.push({
                    userId,
                    ttl,
                    expiresAt: Date.now() + ttl * 1000,
                });
            }
        } while (cursor !== 0);

        cooldowns.sort((a, b) => a.ttl - b.ttl);

        return cooldowns;
    } catch (error) {
        console.error(
            "❌ Failed to list Mystery Event cooldowns:",
            error.message
        );

        throw error;
    }
}

async function clearAllMysteryCooldowns() {
    let cursor = 0;
    let deleted = 0;

    try {
        do {
            const result = await redis.scan(
                cursor,
                {
                    match: `${PREFIX}cooldown:*`,
                    count: 200,
                }
            );

            let nextCursor;
            let keys;

            if (Array.isArray(result)) {
                nextCursor = result[0];
                keys = result[1] || [];
            } else {
                nextCursor =
                    result?.cursor ?? 0;

                keys =
                    result?.keys || [];
            }

            cursor =
                Number(nextCursor) || 0;

            keys = Array.isArray(keys)
                ? keys
                : [];

            if (keys.length > 0) {
                for (
                    let i = 0;
                    i < keys.length;
                    i += 100
                ) {
                    const chunk =
                        keys.slice(
                            i,
                            i + 100
                        );

                    await redis.del(
                        ...chunk
                    );

                    deleted +=
                        chunk.length;
                }
            }
        } while (cursor !== 0);

        console.log(
            `🧹 Cleared ${deleted} Mystery Event cooldown(s).`
        );

        return deleted;
    } catch (error) {
        console.error(
            "❌ Failed to clear Mystery Event cooldowns:",
            error.message
        );

        throw error;
    }
}

// ==========================================
// ACTIVE EVENT
// ==========================================

const ACTIVE_EVENT_KEY =
    `${PREFIX}active`;

async function getActiveMysteryEventId() {
    try {
        return await redis.get(
            ACTIVE_EVENT_KEY
        );
    } catch (error) {
        console.error(
            "❌ Mystery active event read error:",
            error.message
        );

        return null;
    }
}

async function acquireMysteryEvent(
    eventId
) {
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
        console.error(
            "❌ Mystery active event lock error:",
            error.message
        );

        throw error;
    }
}

async function releaseMysteryEvent(
    eventId
) {
    try {
        const currentEventId =
            await redis.get(
                ACTIVE_EVENT_KEY
            );

        if (
            currentEventId !== null &&
            String(currentEventId) ===
                String(eventId)
        ) {
            await redis.del(
                ACTIVE_EVENT_KEY
            );

            return true;
        }

        return false;
    } catch (error) {
        console.error(
            "❌ Mystery active event release error:",
            error.message
        );

        return false;
    }
}

// ==========================================
// EVENT STORAGE
// ==========================================

async function saveMysteryEvent(
    eventId,
    event
) {
    try {
        await redis.set(
            eventKey(eventId),
            event,
            {
                ex: EVENT_TTL_SECONDS,
            }
        );

        return true;
    } catch (error) {
        console.error(
            "❌ Mystery event save error:",
            error.message
        );

        throw error;
    }
}

async function getMysteryEvent(
    eventId
) {
    try {
        return await redis.get(
            eventKey(eventId)
        );
    } catch (error) {
        console.error(
            "❌ Mystery event read error:",
            error.message
        );

        throw error;
    }
}

async function updateMysteryEvent(
    eventId,
    event
) {
    try {
        await redis.set(
            eventKey(eventId),
            event,
            {
                ex: EVENT_TTL_SECONDS,
            }
        );

        return true;
    } catch (error) {
        console.error(
            "❌ Mystery event update error:",
            error.message
        );

        throw error;
    }
}

async function deleteMysteryEvent(
    eventId
) {
    try {
        await redis.del(
            eventKey(eventId)
        );

        return true;
    } catch (error) {
        console.error(
            "❌ Mystery event delete error:",
            error.message
        );

        throw error;
    }
}

// ==========================================
// QUESTION NORMALIZATION
// ==========================================

function normalizeContextPart(value) {
    return String(value ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(
            /[\u0300-\u036f]/g,
            ""
        )
        .replace(
            /\s+/g,
            " "
        )
        .trim();
}

// ==========================================
// QUESTION CONTEXT
// ==========================================

function createQuestionContext({
    category,
    question,
    answers,
    correctAnswer,
}) {
    const normalizedAnswers =
        Array.isArray(answers)
            ? answers
                  .map(
                      normalizeContextPart
                  )
                  .sort()
            : [];

    return [
        normalizeContextPart(category),
        normalizeContextPart(question),
        normalizedAnswers.join("|"),
        normalizeContextPart(
            correctAnswer
        ),
    ].join(" :: ");
}

// ==========================================
// QUESTION HISTORY
// ==========================================

async function hasQuestionBeenUsed(
    context
) {
    try {
        return await redis.sismember(
            questionHistoryKey(),
            context
        );
    } catch (error) {
        console.error(
            "❌ Mystery question history check error:",
            error.message
        );

        throw error;
    }
}

async function saveQuestionContext(
    context
) {
    try {
        await redis.sadd(
            questionHistoryKey(),
            context
        );

        return true;
    } catch (error) {
        console.error(
            "❌ Mystery question history save error:",
            error.message
        );

        throw error;
    }
}

async function saveQuestionContexts(
    contexts
) {
    if (
        !Array.isArray(contexts) ||
        contexts.length === 0
    ) {
        return;
    }

    const uniqueContexts = [
        ...new Set(
            contexts.filter(Boolean)
        ),
    ];

    if (!uniqueContexts.length) {
        return;
    }

    try {
        await redis.sadd(
            questionHistoryKey(),
            ...uniqueContexts
        );
    } catch (error) {
        console.error(
            "❌ Mystery question histories save error:",
            error.message
        );

        throw error;
    }
}

async function getStoredQuestionContexts() {
    try {
        const contexts =
            await redis.smembers(
                questionHistoryKey()
            );

        return Array.isArray(contexts)
            ? contexts
            : [];
    } catch (error) {
        console.error(
            "❌ Mystery question history read error:",
            error.message
        );

        throw error;
    }
}

// ==========================================
// SUBJECT HISTORY
// ==========================================

async function hasQuestionSubjectBeenUsed(
    subject
) {
    const normalizedSubject =
        normalizeContextPart(subject);

    if (!normalizedSubject) {
        return false;
    }

    try {
        return await redis.sismember(
            questionSubjectHistoryKey(),
            normalizedSubject
        );
    } catch (error) {
        console.error(
            "❌ Mystery subject history check error:",
            error.message
        );

        throw error;
    }
}

async function saveQuestionSubject(
    subject
) {
    const normalizedSubject =
        normalizeContextPart(subject);

    if (!normalizedSubject) {
        return;
    }

    try {
        await redis.sadd(
            questionSubjectHistoryKey(),
            normalizedSubject
        );
    } catch (error) {
        console.error(
            "❌ Mystery subject history save error:",
            error.message
        );

        throw error;
    }
}

async function saveQuestionSubjects(
    subjects
) {
    if (
        !Array.isArray(subjects) ||
        subjects.length === 0
    ) {
        return;
    }

    const normalizedSubjects = [
        ...new Set(
            subjects
                .map(
                    normalizeContextPart
                )
                .filter(Boolean)
        ),
    ];

    if (!normalizedSubjects.length) {
        return;
    }

    try {
        await redis.sadd(
            questionSubjectHistoryKey(),
            ...normalizedSubjects
        );
    } catch (error) {
        console.error(
            "❌ Mystery subjects save error:",
            error.message
        );

        throw error;
    }
}

// ==========================================
// QUESTION POOL
// ==========================================

async function getMysteryQuestionPool() {
    try {
        const pool = await redis.lrange(
            questionPoolKey(),
            0,
            -1
        );

        if (!Array.isArray(pool)) {
            return [];
        }

        return pool
            .map((item) => {
                if (
                    typeof item ===
                    "string"
                ) {
                    try {
                        return JSON.parse(
                            item
                        );
                    } catch {
                        return null;
                    }
                }

                return item;
            })
            .filter(Boolean);
    } catch (error) {
        console.error(
            "❌ Mystery question pool read error:",
            error.message
        );

        throw error;
    }
}

async function getMysteryQuestionPoolSize() {
    try {
        return await redis.llen(
            questionPoolKey()
        );
    } catch (error) {
        console.error(
            "❌ Mystery question pool size error:",
            error.message
        );

        throw error;
    }
}

/**
 * Adds validated questions to the pool.
 */
async function addMysteryQuestionsToPool(
    questions
) {
    if (
        !Array.isArray(questions) ||
        questions.length === 0
    ) {
        return 0;
    }

    try {
        const serializedQuestions =
            questions.map((question) =>
                JSON.stringify(question)
            );

        await redis.rpush(
            questionPoolKey(),
            ...serializedQuestions
        );

        console.log(
            `📦 Added ${questions.length} question(s) to Mystery Event pool.`
        );

        return questions.length;
    } catch (error) {
        console.error(
            "❌ Mystery question pool save error:",
            error.message
        );

        throw error;
    }
}

/**
 * Atomically removes ONE question
 * from the pool.
 *
 * Redis LPOP guarantees that two
 * simultaneous reveal clicks cannot
 * receive the same question.
 */
async function claimMysteryQuestion() {
    try {
        const rawQuestion =
            await redis.lpop(
                questionPoolKey()
            );

        if (!rawQuestion) {
            return null;
        }

        try {
            return typeof rawQuestion ===
                "string"
                ? JSON.parse(rawQuestion)
                : rawQuestion;
        } catch (error) {
            console.error(
                "❌ Invalid question found in Mystery Event pool:",
                error.message
            );

            return null;
        }
    } catch (error) {
        console.error(
            "❌ Mystery question claim error:",
            error.message
        );

        throw error;
    }
}

async function clearMysteryQuestionPool() {
    try {
        const deleted =
            await redis.del(
                questionPoolKey()
            );

        console.log(
            "🧹 Mystery Event question pool cleared."
        );

        return deleted;
    } catch (error) {
        console.error(
            "❌ Mystery question pool clear error:",
            error.message
        );

        throw error;
    }
}

// ==========================================
// ATTEMPT STORAGE
// ==========================================

async function saveMysteryAttempt(
    attemptId,
    attempt
) {
    try {
        await redis.set(
            attemptKey(attemptId),
            attempt,
            {
                ex: EVENT_TTL_SECONDS,
            }
        );

        return true;
    } catch (error) {
        console.error(
            "❌ Mystery attempt save error:",
            error.message
        );

        throw error;
    }
}

async function getMysteryAttempt(
    attemptId
) {
    try {
        return await redis.get(
            attemptKey(attemptId)
        );
    } catch (error) {
        console.error(
            "❌ Mystery attempt read error:",
            error.message
        );

        throw error;
    }
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
    PREFIX,

    EVENT_TTL_SECONDS,

    MIN_COOLDOWN_SECONDS,
    MAX_COOLDOWN_SECONDS,

    QUESTION_POOL_TARGET,
    QUESTION_POOL_MINIMUM,

    MYSTERY_EVENT_COOLDOWN_IMMUNE,

    generateRandomCooldownSeconds,

    getMysteryCooldown,
    listAllMysteryCooldowns,
    hasMysteryCooldown,
    claimMysteryCooldown,
    setMysteryCooldown,
    clearMysteryCooldown,
    clearAllMysteryCooldowns,

    getActiveMysteryEventId,
    acquireMysteryEvent,
    releaseMysteryEvent,

    saveMysteryEvent,
    getMysteryEvent,
    updateMysteryEvent,
    deleteMysteryEvent,

    normalizeContextPart,

    createQuestionContext,

    hasQuestionBeenUsed,
    saveQuestionContext,
    saveQuestionContexts,
    getStoredQuestionContexts,

    hasQuestionSubjectBeenUsed,
    saveQuestionSubject,
    saveQuestionSubjects,

    getMysteryQuestionPool,
    getMysteryQuestionPoolSize,
    addMysteryQuestionsToPool,
    claimMysteryQuestion,
    clearMysteryQuestionPool,

    saveMysteryAttempt,
    getMysteryAttempt,
};