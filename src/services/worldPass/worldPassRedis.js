
// src/services/worldPass/worldPassRedis.js

require("dotenv").config();

const crypto = require("node:crypto");
const { Redis } = require("@upstash/redis");

const { WORLD_PASS_CONFIG } = require("./worldPassConfig");

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PREFIX = WORLD_PASS_CONFIG.REDIS.prefix;

const INVENTORY_TTL =
    WORLD_PASS_CONFIG.REDIS.inventoryTtlSeconds;

const ATTEMPT_TTL =
    WORLD_PASS_CONFIG.REDIS.attemptTtlSeconds;

const REWARD_TTL =
    WORLD_PASS_CONFIG.REDIS.rewardTtlSeconds;

const TIERS = Object.keys(WORLD_PASS_CONFIG.CHALLENGES);

// Global index: tracks active attempts across every player.
const GLOBAL_ACTIVE_KEY = `${PREFIX}active:all`;

// ==========================================
// REDIS KEYS
// ==========================================

function inventoryKey(userId) {
    return `${PREFIX}inventory:${userId}`;
}

function reservedKey(userId) {
    return `${PREFIX}reserved:${userId}`;
}

function attemptKey(attemptId) {
    return `${PREFIX}attempt:${attemptId}`;
}

function activeKey(userId) {
    return `${PREFIX}active:${userId}`;
}

function poolKey(tier) {
    return `${PREFIX}pool:${tier}`;
}

function historyKey(tier) {
    return `${PREFIX}history:${tier}`;
}

function rewardKey(attemptId) {
    return `${PREFIX}reward:${attemptId}`;
}

function pendingRewardsKey() {
    return `${PREFIX}rewards:pending`;
}

function passAwardKey(sourceId) {
    return `${PREFIX}pass-award:${sourceId}`;
}

// ==========================================
// HELPERS
// ==========================================

function isValidTier(tier) {
    return TIERS.includes(String(tier));
}

function createAttemptId() {
    return crypto.randomUUID();
}

function parseRedisObject(value) {
    if (!value) return null;

    if (typeof value === "object") {
        return value;
    }

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function normalizeInventory(data = {}) {
    const result = {};

    for (const tier of TIERS) {
        const amount = Number(data[tier] || 0);

        result[tier] =
            Number.isSafeInteger(amount) && amount >= 0
                ? amount
                : 0;
    }

    return result;
}

// ==========================================
// LUA: AWARD PASS ONCE
// ==========================================

const AWARD_PASS_SCRIPT = `
local awardKey = KEYS[1]
local inventoryKey = KEYS[2]

local tier = ARGV[1]
local ttl = tonumber(ARGV[2])

if redis.call("EXISTS", awardKey) == 1 then
    return 0
end

redis.call("HINCRBY", inventoryKey, tier, 1)
redis.call("EXPIRE", inventoryKey, ttl)

redis.call("SET", awardKey, tier, "EX", ttl, "NX")

return 1
`;

// ==========================================
// AWARD PASS
// ==========================================

async function awardPass(userId, tier, sourceId) {
    userId = String(userId);
    tier = String(tier);
    sourceId = String(sourceId);

    if (!isValidTier(tier)) {
        throw new Error(`[World Pass] Invalid pass tier: ${tier}`);
    }

    if (!sourceId || sourceId === "undefined") {
        throw new Error("[World Pass] Missing pass award source ID.");
    }

    try {
        const result = await redis.eval(
            AWARD_PASS_SCRIPT,
            [
                passAwardKey(sourceId),
                inventoryKey(userId),
            ],
            [
                tier,
                INVENTORY_TTL,
            ]
        );

        return Number(result) === 1;
    } catch (error) {
        console.error(
            "[World Pass] Pass award failed:",
            error.message
        );

        throw error;
    }
}

// ==========================================
// INVENTORY
// ==========================================

async function getPassInventory(userId) {
    try {
        const [inventory, reserved] = await Promise.all([
            redis.hgetall(inventoryKey(String(userId))),
            redis.hgetall(reservedKey(String(userId))),
        ]);

        const owned = normalizeInventory(inventory || {});
        const held = normalizeInventory(reserved || {});

        const result = {};

        for (const tier of TIERS) {
            result[tier] = {
                owned: owned[tier],
                reserved: held[tier],
                available: Math.max(
                    0,
                    owned[tier] - held[tier]
                ),
            };
        }

        return result;
    } catch (error) {
        console.error(
            "[World Pass] Inventory read failed:",
            error.message
        );

        throw error;
    }
}

// ==========================================
// QUESTION POOL
// ==========================================

async function getQuestionPoolSize(tier) {
    if (!isValidTier(tier)) {
        throw new Error("Invalid question tier.");
    }

    return Number(await redis.llen(poolKey(tier)));
}

async function addQuestionsToPool(tier, questions) {
    if (!isValidTier(tier)) {
        throw new Error("Invalid question tier.");
    }

    if (!Array.isArray(questions) || !questions.length) {
        return 0;
    }

    const valid = questions.filter((question) => {
        return (
            question &&
            typeof question.id === "string" &&
            typeof question.question === "string" &&
            typeof question.answer === "string" &&
            Array.isArray(question.options) &&
            question.options.length ===
                WORLD_PASS_CONFIG.QUESTION_SETTINGS.maxOptions &&
            question.options.every(
                option => typeof option === "string" && option.length <= 80
            ) &&
            question.options.includes(question.answer) &&
            question.tier === tier
        );
    });

    if (!valid.length) return 0;

    const serialized = valid.map(question =>
        JSON.stringify(question)
    );

    await redis.rpush(poolKey(tier), ...serialized);

    console.log(
        `[World Pass] Added ${valid.length} ${tier} question(s).`
    );

    return valid.length;
}

async function claimQuestion(tier) {
    if (!isValidTier(tier)) {
        throw new Error("Invalid question tier.");
    }

    const raw = await redis.lpop(poolKey(tier));

    if (!raw) return null;

    const question = parseRedisObject(raw);

    if (
        !question ||
        question.tier !== tier ||
        typeof question.id !== "string" ||
        typeof question.question !== "string" ||
        typeof question.answer !== "string" ||
        !Array.isArray(question.options) ||
        question.options.length !==
            WORLD_PASS_CONFIG.QUESTION_SETTINGS.maxOptions ||
        !question.options.every(
            option => typeof option === "string"
        ) ||
        !question.options.includes(question.answer)
    ) {
        console.error(
            `[World Pass] Invalid question removed from ${tier} pool.`
        );

        return null;
    }

    return question;
}

async function getUsedQuestionIds(tier) {
    if (!isValidTier(tier)) {
        throw new Error("Invalid question tier.");
    }

    const result = await redis.lrange(
        historyKey(tier),
        0,
        -1
    );

    return Array.isArray(result) ? result : [];
}

async function saveUsedQuestionId(tier, questionId) {
    if (!isValidTier(tier)) {
        throw new Error("Invalid question tier.");
    }

    const key = historyKey(tier);
    const limit = WORLD_PASS_CONFIG.POOL_SETTINGS.historyLimit;

    await redis.lrem(key, 0, String(questionId));
    await redis.lpush(key, String(questionId));
    await redis.ltrim(key, 0, limit - 1);

    return true;
}

// ==========================================
// LUA: CREATE CHALLENGE
// ==========================================

const CREATE_ATTEMPT_SCRIPT = `
local inventoryKey = KEYS[1]
local reservedKey = KEYS[2]
local attemptKey = KEYS[3]
local activeKey = KEYS[4]
local globalActiveKey = KEYS[5]

local tier = ARGV[1]
local cost = tonumber(ARGV[2])
local attemptJson = ARGV[3]
local ttl = tonumber(ARGV[4])
local attemptId = ARGV[5]

local owned = tonumber(
    redis.call("HGET", inventoryKey, tier) or "0"
)

local reserved = tonumber(
    redis.call("HGET", reservedKey, tier) or "0"
)

local available = owned - reserved

if available < cost then
    return 0
end

if redis.call("EXISTS", attemptKey) == 1 then
    return -1
end

redis.call("HINCRBY", reservedKey, tier, cost)
redis.call("EXPIRE", reservedKey, ttl)

redis.call("SET", attemptKey, attemptJson, "EX", ttl)

redis.call("SADD", activeKey, attemptId)
redis.call("EXPIRE", activeKey, ttl)

-- Global index is intentionally not given a TTL.
-- The scheduler removes completed and expired attempts.
redis.call("SADD", globalActiveKey, attemptId)

return 1
`;

// ==========================================
// CREATE CHALLENGE
// ==========================================

async function createChallengeAttempt(userId, tier, question) {
    userId = String(userId);

    if (!isValidTier(tier)) {
        return {
            success: false,
            reason: "INVALID_TIER",
        };
    }

    if (!question || question.tier !== tier) {
        return {
            success: false,
            reason: "INVALID_QUESTION",
        };
    }

    const config = WORLD_PASS_CONFIG.CHALLENGES[tier];
    const attemptId = createAttemptId();
    const now = Date.now();

    const attempt = {
        attemptId,
        userId,
        tier,
        questionId: question.id,

        question: question.question,
        options: question.options,

        correctAnswer: question.answer,
        explanation: question.explanation || null,

        passCost: config.passCost,
        reward: config.reward,

        status: "active",
        result: null,

        createdAt: now,
        expiresAt:
            now +
            WORLD_PASS_CONFIG.QUESTION_SETTINGS.expiryMs,

        answeredAt: null,
    };

    try {
        const result = await redis.eval(
            CREATE_ATTEMPT_SCRIPT,
            [
                inventoryKey(userId),
                reservedKey(userId),
                attemptKey(attemptId),
                activeKey(userId),
                GLOBAL_ACTIVE_KEY,
            ],
            [
                tier,
                config.passCost,
                JSON.stringify(attempt),
                ATTEMPT_TTL,
                attemptId,
            ]
        );

        if (Number(result) !== 1) {
            return {
                success: false,
                reason:
                    Number(result) === 0
                        ? "INSUFFICIENT_PASSES"
                        : "ATTEMPT_EXISTS",
            };
        }

        return {
            success: true,
            attempt,
        };
    } catch (error) {
        console.error(
            "[World Pass] Challenge creation failed:",
            error.message
        );

        throw error;
    }
}

// ==========================================
// READ ATTEMPT
// ==========================================

async function getChallengeAttempt(attemptId) {
    try {
        const raw = await redis.get(
            attemptKey(String(attemptId))
        );

        return parseRedisObject(raw);
    } catch (error) {
        console.error(
            "[World Pass] Attempt read failed:",
            error.message
        );

        throw error;
    }
}

async function getActiveAttemptIds(userId) {
    try {
        const ids = await redis.smembers(
            activeKey(String(userId))
        );

        return Array.isArray(ids) ? ids : [];
    } catch (error) {
        console.error(
            "[World Pass] Active attempt read failed:",
            error.message
        );

        throw error;
    }
}

// ==========================================
// GLOBAL ACTIVE ATTEMPTS
// ==========================================

async function getAllActiveAttemptIds() {
    try {
        const ids = await redis.smembers(GLOBAL_ACTIVE_KEY);

        return Array.isArray(ids) ? ids : [];
    } catch (error) {
        console.error(
            "[World Pass] Global active attempt read failed:",
            error.message
        );

        throw error;
    }
}

async function removeGlobalActiveAttemptId(attemptId) {
    try {
        return await redis.srem(
            GLOBAL_ACTIVE_KEY,
            String(attemptId)
        );
    } catch (error) {
        console.error(
            "[World Pass] Global active index cleanup failed:",
            error.message
        );

        throw error;
    }
}

// ==========================================
// LUA: PROCESS ANSWER + CREATE REWARD
// ==========================================

const PROCESS_ANSWER_SCRIPT = `
local attemptKey = KEYS[1]
local inventoryKey = KEYS[2]
local reservedKey = KEYS[3]
local activeKey = KEYS[4]
local rewardKey = KEYS[5]
local pendingRewardsKey = KEYS[6]
local globalActiveKey = KEYS[7]

local attemptId = ARGV[1]
local userId = ARGV[2]
local selectedAnswer = ARGV[3]
local now = tonumber(ARGV[4])
local inventoryTtl = tonumber(ARGV[5])
local rewardTtl = tonumber(ARGV[6])

local raw = redis.call("GET", attemptKey)

if not raw then
    redis.call("SREM", activeKey, attemptId)
    redis.call("SREM", globalActiveKey, attemptId)
    return {"NOT_FOUND"}
end

local attempt = cjson.decode(raw)

if tostring(attempt.userId) ~= userId then
    return {"NOT_OWNER"}
end

if attempt.status ~= "active" then
    redis.call("SREM", activeKey, attemptId)
    redis.call("SREM", globalActiveKey, attemptId)
    return {"ALREADY_PROCESSED", tostring(attempt.status)}
end

local tier = attempt.tier
local cost = tonumber(attempt.passCost)

local reserved = tonumber(
    redis.call("HGET", reservedKey, tier) or "0"
)

if reserved < cost then
    -- The reservation has already disappeared (for example, after
    -- an old Redis TTL). Close the attempt without deducting owned passes.
    attempt.status = "expired"
    attempt.result = "reservation_missing"
    attempt.answeredAt = now

    redis.call(
        "SET",
        attemptKey,
        cjson.encode(attempt),
        "KEEPTTL"
    )

    redis.call("SREM", activeKey, attemptId)
    redis.call("SREM", globalActiveKey, attemptId)

    return {"RESERVATION_MISSING"}
end

if now >= tonumber(attempt.expiresAt) then
    attempt.status = "expired"
    attempt.result = "expired"
    attempt.answeredAt = now

    redis.call("HINCRBY", reservedKey, tier, -cost)
    redis.call("SREM", activeKey, attemptId)
    redis.call("SREM", globalActiveKey, attemptId)

    redis.call(
        "SET",
        attemptKey,
        cjson.encode(attempt),
        "KEEPTTL"
    )

    return {"EXPIRED"}
end

local correct =
    selectedAnswer == tostring(attempt.correctAnswer)

attempt.answeredAt = now

if correct then
    if redis.call("EXISTS", rewardKey) == 1 then
        return {"REWARD_ALREADY_EXISTS"}
    end

    local owned = tonumber(
        redis.call("HGET", inventoryKey, tier) or "0"
    )

    if owned < cost then
        return {"INVENTORY_INCONSISTENT"}
    end

    local reward = {
        attemptId = attemptId,
        userId = userId,
        tier = tier,

        -- The payment worker expects this field.
        reward = tonumber(attempt.reward),

        status = "pending",
        createdAt = now,
        updatedAt = now,
        attempts = 0,
        transactionId = cjson.null
    }

    -- Create reward and queue entry atomically.
    redis.call(
        "SET",
        rewardKey,
        cjson.encode(reward),
        "EX",
        rewardTtl
    )

    redis.call("SADD", pendingRewardsKey, attemptId)
    redis.call("EXPIRE", pendingRewardsKey, rewardTtl)

    -- Deduct passes only after reward creation.
    redis.call("HINCRBY", inventoryKey, tier, -cost)
    redis.call("HINCRBY", reservedKey, tier, -cost)
    redis.call("EXPIRE", inventoryKey, inventoryTtl)

    attempt.status = "reward_pending"
    attempt.result = "correct"

    redis.call(
        "SET",
        attemptKey,
        cjson.encode(attempt),
        "KEEPTTL"
    )

    redis.call("SREM", activeKey, attemptId)
    redis.call("SREM", globalActiveKey, attemptId)

    return {
        "CORRECT",
        tostring(attempt.reward),
        tostring(tier)
    }
end

-- Incorrect: release reservation, retain owned passes.
attempt.status = "incorrect"
attempt.result = "incorrect"

redis.call("HINCRBY", reservedKey, tier, -cost)

redis.call(
    "SET",
    attemptKey,
    cjson.encode(attempt),
    "KEEPTTL"
)

redis.call("SREM", activeKey, attemptId)
redis.call("SREM", globalActiveKey, attemptId)

return {"INCORRECT", tostring(tier)}
`;

// ==========================================
// PROCESS ANSWER
// ==========================================

async function processChallengeAnswer(
    userId,
    attemptId,
    selectedAnswer
) {
    userId = String(userId);
    attemptId = String(attemptId);
    selectedAnswer = String(selectedAnswer);

    try {
        const result = await redis.eval(
            PROCESS_ANSWER_SCRIPT,
            [
                attemptKey(attemptId),
                inventoryKey(userId),
                reservedKey(userId),
                activeKey(userId),
                rewardKey(attemptId),
                pendingRewardsKey(),
                GLOBAL_ACTIVE_KEY,
            ],
            [
                attemptId,
                userId,
                selectedAnswer,
                Date.now(),
                INVENTORY_TTL,
                REWARD_TTL,
            ]
        );

        const status = result?.[0];

        if (status === "CORRECT") {
            return {
                success: true,
                correct: true,
                reward: Number(result[1]),
                tier: result[2],
            };
        }

        if (status === "INCORRECT") {
            return {
                success: true,
                correct: false,
                tier: result[1],
            };
        }

        return {
            success: false,
            reason: status || "UNKNOWN",
        };
    } catch (error) {
        console.error(
            "[World Pass] Answer processing failed:",
            error.message
        );

        throw error;
    }
}

// ==========================================
// LUA: RELEASE EXPIRED ATTEMPT
// ==========================================

const EXPIRE_ATTEMPT_SCRIPT = `
local attemptKey = KEYS[1]
local reservedKey = KEYS[2]
local activeKey = KEYS[3]
local globalActiveKey = KEYS[4]

local attemptId = ARGV[1]
local userId = ARGV[2]
local now = tonumber(ARGV[3])

local raw = redis.call("GET", attemptKey)

if not raw then
    redis.call("SREM", activeKey, attemptId)
    redis.call("SREM", globalActiveKey, attemptId)
    return 0
end

local attempt = cjson.decode(raw)

if tostring(attempt.userId) ~= userId then
    return -1
end

if attempt.status ~= "active" then
    redis.call("SREM", activeKey, attemptId)
    redis.call("SREM", globalActiveKey, attemptId)
    return 0
end

if now < tonumber(attempt.expiresAt) then
    return 2
end

local tier = attempt.tier
local cost = tonumber(attempt.passCost)

local reserved = tonumber(
    redis.call("HGET", reservedKey, tier) or "0"
)

if reserved < cost then
    -- No reservation remains to release; still close and de-index it.
    attempt.status = "expired"
    attempt.result = "reservation_missing"
    attempt.answeredAt = now

    redis.call(
        "SET",
        attemptKey,
        cjson.encode(attempt),
        "KEEPTTL"
    )

    redis.call("SREM", activeKey, attemptId)
    redis.call("SREM", globalActiveKey, attemptId)

    return 1
end

redis.call("HINCRBY", reservedKey, tier, -cost)

attempt.status = "expired"
attempt.result = "expired"
attempt.answeredAt = now

redis.call(
    "SET",
    attemptKey,
    cjson.encode(attempt),
    "KEEPTTL"
)

redis.call("SREM", activeKey, attemptId)
redis.call("SREM", globalActiveKey, attemptId)

return 1
`;

// ==========================================
// EXPIRE ONE ATTEMPT
// ==========================================

async function expireChallengeAttempt(userId, attemptId) {
    userId = String(userId);
    attemptId = String(attemptId);

    try {
        const result = await redis.eval(
            EXPIRE_ATTEMPT_SCRIPT,
            [
                attemptKey(attemptId),
                reservedKey(userId),
                activeKey(userId),
                GLOBAL_ACTIVE_KEY,
            ],
            [
                attemptId,
                userId,
                Date.now(),
            ]
        );

        return Number(result);
    } catch (error) {
        console.error(
            "[World Pass] Attempt expiry failed:",
            error.message
        );

        throw error;
    }
}

// ==========================================
// PENDING REWARDS
// ==========================================

async function getPendingReward(attemptId) {
    try {
        return parseRedisObject(
            await redis.get(rewardKey(String(attemptId)))
        );
    } catch (error) {
        console.error(
            "[World Pass] Reward read failed:",
            error.message
        );

        throw error;
    }
}

async function getPendingRewardIds() {
    try {
        const ids = await redis.smembers(pendingRewardsKey());

        return Array.isArray(ids) ? ids : [];
    } catch (error) {
        console.error(
            "[World Pass] Pending reward list failed:",
            error.message
        );

        throw error;
    }
}

// ==========================================
// LUA: ATOMIC REWARD STATUS UPDATE
// ==========================================

const UPDATE_REWARD_STATUS_SCRIPT = `
local rewardKey = KEYS[1]
local pendingKey = KEYS[2]

local expectedStatus = ARGV[1]
local newStatus = ARGV[2]
local extraJson = ARGV[3]
local now = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local attemptId = ARGV[6]

local raw = redis.call("GET", rewardKey)

if not raw then
    return 0
end

local reward = cjson.decode(raw)

if reward.status ~= expectedStatus then
    return 0
end

local extra = cjson.decode(extraJson)

for key, value in pairs(extra) do
    reward[key] = value
end

reward.status = newStatus
reward.updatedAt = now

redis.call(
    "SET",
    rewardKey,
    cjson.encode(reward),
    "EX",
    ttl
)

if newStatus == "submitted" then
    redis.call("SREM", pendingKey, attemptId)
end

return 1
`;

// ==========================================
// UPDATE REWARD STATUS
// ==========================================

async function updateRewardStatus(
    attemptId,
    expectedStatus,
    newStatus,
    extra = {}
) {
    try {
        const result = await redis.eval(
            UPDATE_REWARD_STATUS_SCRIPT,
            [
                rewardKey(String(attemptId)),
                pendingRewardsKey(),
            ],
            [
                String(expectedStatus),
                String(newStatus),
                JSON.stringify(extra),
                Date.now(),
                REWARD_TTL,
                String(attemptId),
            ]
        );

        return Number(result) === 1;
    } catch (error) {
        console.error(
            "[World Pass] Reward status update failed:",
            error.message
        );

        throw error;
    }
}

// ==========================================
// EXPORTS
// ==========================================

// ==========================================
// ALL PLAYER INVENTORIES
// ==========================================

async function getAllPassInventories() {
    try {
        const pattern = `${PREFIX}inventory:*`;
        const userIds = new Set();

        let cursor = "0";

        do {
            const [nextCursor, keys] = await redis.scan(
                cursor,
                {
                    match: pattern,
                    count: 100,
                }
            );

            cursor = String(nextCursor);

            for (const key of keys || []) {
                const userId = String(key).slice(
                    `${PREFIX}inventory:`.length
                );

                if (userId) userIds.add(userId);
            }
        } while (cursor !== "0");

        const ids = [...userIds];
        const results = [];

        // Process in batches to avoid excessive Redis requests.
        for (let i = 0; i < ids.length; i += 25) {
            const batch = ids.slice(i, i + 25);

            const inventories = await Promise.all(
                batch.map(async (userId) => {
                    const inventory = await getPassInventory(userId);

                    const total = Object.values(inventory).reduce(
                        (sum, item) => sum + item.owned,
                        0
                    );

                    const available = Object.values(inventory).reduce(
                        (sum, item) => sum + item.available,
                        0
                    );

                    const reserved = Object.values(inventory).reduce(
                        (sum, item) => sum + item.reserved,
                        0
                    );

                    return {
                        userId,
                        inventory,
                        total,
                        available,
                        reserved,
                    };
                })
            );

            results.push(...inventories);
        }

        return results;
    } catch (error) {
        console.error(
            "[World Pass] Could not retrieve all inventories:",
            error.message
        );

        throw error;
    }
}

module.exports = {
    PREFIX,

    awardPass,

    getPassInventory,
    getAllPassInventories,
    getQuestionPoolSize,
    addQuestionsToPool,
    claimQuestion,
    getUsedQuestionIds,
    saveUsedQuestionId,

    createChallengeAttempt,
    getChallengeAttempt,
    getActiveAttemptIds,

    getAllActiveAttemptIds,
    removeGlobalActiveAttemptId,

    processChallengeAnswer,
    expireChallengeAttempt,

    getPendingReward,
    getPendingRewardIds,
    updateRewardStatus,
};
