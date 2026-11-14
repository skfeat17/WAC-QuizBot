require("dotenv").config();

const { Redis } = require("@upstash/redis");

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const VALID_EVENTS = new Set([
    "mystery",
    "chest",
]);

const DAY_TTL_SECONDS = 400 * 24 * 60 * 60;

// Mora leaderboard ledger
const MORA_LEDGER_KEY =
    "wac:leaderboard:v1:mora:activity";

const MORA_LEDGER_DATA_KEY =
    "wac:leaderboard:v1:mora:entries";


/*
    Validate event type.
*/
function validateEvent(event) {
    if (!VALID_EVENTS.has(event)) {
        throw new Error(
            `Invalid event type: ${event}`
        );
    }
}


/*
    Get YYYY-MM-DD for a timestamp.
*/
function getDateKey(timestamp = Date.now()) {
    return new Date(timestamp)
        .toISOString()
        .slice(0, 10);
}


/*
    Redis keys for a specific day.
*/
function getDayKeys(event, dateKey) {
    validateEvent(event);

    return {
        participants:
            `wac:stats:${event}:day:${dateKey}:participants`,

        counts:
            `wac:stats:${event}:day:${dateKey}:counts`,

        activity:
            `wac:stats:${event}:day:${dateKey}:activity`,

        mora:
            `wac:stats:${event}:day:${dateKey}:mora`,
    };
}


/*
    Redis key containing all available days.
*/
function getDaysKey(event) {
    validateEvent(event);

    return `wac:stats:${event}:days`;
}


/*
    Record one participation.
*/
async function recordParticipation(
    event,
    userId,
    timestamp = Date.now()
) {
    validateEvent(event);

    if (!userId) {
        throw new Error("userId is required");
    }

    const dateKey = getDateKey(timestamp);
    const keys = getDayKeys(event, dateKey);
    const daysKey = getDaysKey(event);

    const activityId =
        `${timestamp}:${userId}:${Math.random()
            .toString(36)
            .slice(2, 8)}`;

    await Promise.all([
        redis.sadd(keys.participants, userId),

        redis.hincrby(
            keys.counts,
            userId,
            1
        ),

        redis.zadd(keys.activity, {
            score: timestamp,
            member: activityId,
        }),

        redis.sadd(daysKey, dateKey),

        redis.expire(
            keys.participants,
            DAY_TTL_SECONDS
        ),

        redis.expire(
            keys.counts,
            DAY_TTL_SECONDS
        ),

        redis.expire(
            keys.activity,
            DAY_TTL_SECONDS
        ),

        redis.expire(
            daysKey,
            DAY_TTL_SECONDS
        ),
    ]);

    return {
        event,
        userId,
        dateKey,
        timestamp,
    };
}


/*
    Record Mora awarded to a user.

    Also records the exact timestamp
    for the Mora leaderboard.
*/
async function recordMora(
    event,
    userId,
    amount,
    timestamp = Date.now()
) {
    validateEvent(event);

    if (!userId) {
        throw new Error("userId is required");
    }

    const numericAmount = Number(amount);

    if (
        !Number.isFinite(numericAmount) ||
        numericAmount <= 0
    ) {
        throw new Error("Invalid Mora amount");
    }

    const dateKey = getDateKey(timestamp);
    const keys = getDayKeys(event, dateKey);
    const daysKey = getDaysKey(event);

    const ledgerId =
        `${timestamp}:${userId}:${Math.random()
            .toString(36)
            .slice(2, 10)}`;

    await Promise.all([
        // Existing daily Mora statistics
        redis.hincrby(
            keys.mora,
            userId,
            numericAmount
        ),

        // Timestamp-level leaderboard entry
        redis.zadd(MORA_LEDGER_KEY, {
            score: timestamp,
            member: ledgerId,
        }),

        redis.hset(MORA_LEDGER_DATA_KEY, {
            [ledgerId]: JSON.stringify({
                userId,
                amount: numericAmount,
                event,
                timestamp,
            }),
        }),

        redis.expire(
            MORA_LEDGER_KEY,
            DAY_TTL_SECONDS
        ),

        redis.expire(
            MORA_LEDGER_DATA_KEY,
            DAY_TTL_SECONDS
        ),

        redis.sadd(daysKey, dateKey),

        redis.expire(
            keys.mora,
            DAY_TTL_SECONDS
        ),

        redis.expire(
            daysKey,
            DAY_TTL_SECONDS
        ),

    ]);
    // Update fast leaderboard cache
    await updateLeaderboardCache(
        userId,
        numericAmount,
        timestamp
    );
    return {
        event,
        userId,
        amount: numericAmount,
        dateKey,
        timestamp,
    };
}


/*
    Get unique participants for a day.
*/
async function getDayParticipants(
    event,
    dateKey
) {
    const keys = getDayKeys(event, dateKey);

    return await redis.smembers(
        keys.participants
    );
}


/*
    Get participation counts for every user.
*/
async function getDayCounts(
    event,
    dateKey
) {
    const keys = getDayKeys(event, dateKey);

    const data = await redis.hgetall(
        keys.counts
    );

    if (!data) {
        return [];
    }

    return Object.entries(data)
        .map(([userId, count]) => ({
            userId,
            count: Number(count) || 0,
        }))
        .sort((a, b) => b.count - a.count);
}


/*
    Get Mora totals for every user on a day.
*/
async function getDayMora(
    event,
    dateKey
) {
    const keys = getDayKeys(event, dateKey);

    const data = await redis.hgetall(
        keys.mora
    );

    if (!data) {
        return {
            total: 0,
            users: [],
        };
    }

    const users = Object.entries(data)
        .map(([userId, amount]) => ({
            userId,
            amount: Number(amount) || 0,
        }))
        .filter(entry => entry.amount > 0)
        .sort((a, b) => b.amount - a.amount);

    return {
        total: users.reduce(
            (sum, entry) => sum + entry.amount,
            0
        ),

        users,
    };
}


/*
    Get participation activity
    from the last 24 hours.
*/
async function getLast24Hours(
    event,
    now = Date.now()
) {
    validateEvent(event);

    const minTimestamp =
        now - (24 * 60 * 60 * 1000);

    const days = await getAvailableDays(event);

    const users = new Set();
    let totalParticipations = 0;

    for (const dateKey of days) {
        const keys = getDayKeys(event, dateKey);

        const activityIds = await redis.zrange(
            keys.activity,
            minTimestamp,
            now,
            {
                byScore: true,
            }
        );

        if (!activityIds?.length) {
            continue;
        }

        totalParticipations += activityIds.length;

        for (const activityId of activityIds) {
            const parts = String(activityId).split(":");

            if (parts.length >= 2) {
                users.add(parts[1]);
            }
        }
    }

    return {
        participants: users.size,
        totalParticipations,
    };
}


/*
    Get every stored day.
    Newest first.
*/
async function getAvailableDays(event) {
    const daysKey = getDaysKey(event);

    const days = await redis.smembers(daysKey);

    return (days || [])
        .sort()
        .reverse();
}


/*
    Get complete stats for one specific day.
*/
async function getDayStats(
    event,
    dateKey
) {
    validateEvent(event);

    const [
        participants,
        counts,
        mora,
    ] = await Promise.all([
        getDayParticipants(event, dateKey),
        getDayCounts(event, dateKey),
        getDayMora(event, dateKey),
    ]);

    return {
        event,
        dateKey,

        participants: participants.length,

        totalParticipations: counts.reduce(
            (total, entry) => total + entry.count,
            0
        ),

        totalMora: mora.total,

        users: counts,
        moraUsers: mora.users,
    };
}


/*
    Get one user's participation
    count for a specific day.
*/
async function getUserDayCount(
    event,
    dateKey,
    userId
) {
    const keys = getDayKeys(event, dateKey);

    const count = await redis.hget(
        keys.counts,
        userId
    );

    return Number(count) || 0;
}


/*
    Get all stored statistics.
*/
async function getAllStats(event) {
    const days = await getAvailableDays(event);

    const stats = [];

    for (const dateKey of days) {
        stats.push(
            await getDayStats(event, dateKey)
        );
    }

    return stats;
}


/*
    Get Mora earned by each user
    within an exact timestamp range.

    Returns the top 10 users.
*/
async function getMoraLeaderboard(
    startTimestamp,
    endTimestamp
) {
    const ids = await redis.zrange(
        MORA_LEDGER_KEY,
        startTimestamp,
        endTimestamp,
        {
            byScore: true,
        }
    );

    if (!ids?.length) {
        return [];
    }

    const entries = await Promise.all(
        ids.map(async (id) => {
            const raw = await redis.hget(
                MORA_LEDGER_DATA_KEY,
                id
            );

            if (!raw) {
                return null;
            }

            try {
                return typeof raw === "string"
                    ? JSON.parse(raw)
                    : raw;
            } catch {
                return null;
            }
        })
    );

    const totals = new Map();

    for (const entry of entries) {
        if (!entry?.userId) {
            continue;
        }

        totals.set(
            entry.userId,
            (totals.get(entry.userId) || 0) +
            (Number(entry.amount) || 0)
        );
    }

    return [...totals.entries()]
        .map(([userId, amount]) => ({
            userId,
            amount,
        }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 10);
}

async function getTotalMoraRewarded(startTimestamp, endTimestamp) {
    const ledgerIds = await redis.zrange(
        MORA_LEDGER_KEY,
        startTimestamp,
        endTimestamp,
        { byScore: true }
    );

    if (!ledgerIds.length) return 0;

    let total = 0;

    for (const ledgerId of ledgerIds) {
        const raw = await redis.hget(
            MORA_LEDGER_DATA_KEY,
            ledgerId
        );

        if (!raw) continue;

        const entry = typeof raw === "string"
            ? JSON.parse(raw)
            : raw;

        const amount = Number(entry.amount || 0);

        if (Number.isFinite(amount)) {
            total += amount;
        }
    }

    return total;
}
// ==========================================
// FAST LEADERBOARD CACHE
// ==========================================

const LEADERBOARD_CACHE_PREFIX =
    "wac:leaderboard:cache";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function getLeaderboardCachePeriods(timestamp = Date.now()) {
    const date = new Date(timestamp + IST_OFFSET_MS);

    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    const weekday = date.getUTCDay();

    const today = [
        year,
        String(month + 1).padStart(2, "0"),
        String(day).padStart(2, "0"),
    ].join("-");

    const daysSinceMonday = (weekday + 6) % 7;

    const monday = new Date(
        Date.UTC(year, month, day - daysSinceMonday)
    );

    const week = `${monday.getUTCFullYear()}-W${String(
        Math.ceil(
            (
                Date.UTC(
                    monday.getUTCFullYear(),
                    monday.getUTCMonth(),
                    monday.getUTCDate()
                ) -
                Date.UTC(monday.getUTCFullYear(), 0, 1)
            ) / DAY_MS + 1
        )
    ).padStart(2, "0")
        }`;

    const monthly = `${year}-${String(month + 1).padStart(2, "0")}`;

    return { today, week, month: monthly };
}

function getLeaderboardCacheKeys(timestamp = Date.now()) {
    const periods = getLeaderboardCachePeriods(timestamp);

    return {
        today: {
            users: `${LEADERBOARD_CACHE_PREFIX}:today:${periods.today}`,
            total: `${LEADERBOARD_CACHE_PREFIX}:total:today:${periods.today}`,
        },

        week: {
            users: `${LEADERBOARD_CACHE_PREFIX}:week:${periods.week}`,
            total: `${LEADERBOARD_CACHE_PREFIX}:total:week:${periods.week}`,
        },

        month: {
            users: `${LEADERBOARD_CACHE_PREFIX}:month:${periods.month}`,
            total: `${LEADERBOARD_CACHE_PREFIX}:total:month:${periods.month}`,
        },
    };
}

// ==========================================
// UPDATE CACHE WHEN MORA IS REWARDED
// ==========================================

async function updateLeaderboardCache(userId, amount, timestamp = Date.now()) {
    const keys = getLeaderboardCacheKeys(timestamp);

    const pipeline = redis.pipeline();

    for (const period of Object.values(keys)) {
        pipeline.zincrby(period.users, amount, String(userId));
        pipeline.incrby(period.total, amount);
        pipeline.expire(period.users, 400 * 24 * 60 * 60);
        pipeline.expire(period.total, 400 * 24 * 60 * 60);
    }

    await pipeline.exec();
}

// ==========================================
// GET CACHED LEADERBOARD
// ==========================================

async function getCachedLeaderboard() {
    const keys = getLeaderboardCacheKeys();

    const pipeline = redis.pipeline();

    for (const period of Object.values(keys)) {
        pipeline.zrange(
            period.users,
            0,
            9,
            { rev: true, withScores: true }
        );

        pipeline.get(period.total);
    }

    const results = await pipeline.exec();

    function parseEntries(raw) {
        if (!raw) return [];

        const entries = [];

        // Upstash may return member/score pairs.
        for (let i = 0; i < raw.length; i++) {
            const item = raw[i];

            if (Array.isArray(item)) {
                entries.push({
                    userId: String(item[0]),
                    amount: Number(item[1]),
                });
                continue;
            }

            if (i + 1 < raw.length) {
                entries.push({
                    userId: String(item),
                    amount: Number(raw[++i]),
                });
            }
        }

        return entries;
    }

    return {
        today: {
            entries: parseEntries(results[0]),
            totalRewarded: Number(results[1] || 0),
        },

        week: {
            entries: parseEntries(results[2]),
            totalRewarded: Number(results[3] || 0),
        },

        month: {
            entries: parseEntries(results[4]),
            totalRewarded: Number(results[5] || 0),
        },

        generatedAt: Date.now(),
    };
}
async function rebuildLeaderboardCache() {
    console.log("[LEADERBOARD] Starting cache rebuild...");

    const ledgerIds = await redis.zrange(
        MORA_LEDGER_KEY,
        0,
        -1
    );

    if (!ledgerIds.length) {
        console.log("[LEADERBOARD] No ledger entries found.");
        return;
    }

    const pipeline = redis.pipeline();

    for (const id of ledgerIds) {
        pipeline.hget(MORA_LEDGER_DATA_KEY, id);
    }

    const records = await pipeline.exec();

    const periods = {
        today: new Map(),
        week: new Map(),
        month: new Map(),
    };

    const totals = {
        today: 0,
        week: 0,
        month: 0,
    };

    const now = Date.now();
    const currentKeys = getLeaderboardCacheKeys(now);

    for (const raw of records) {
        if (!raw) continue;

        let entry;

        try {
            entry = typeof raw === "string"
                ? JSON.parse(raw)
                : raw;
        } catch {
            continue;
        }

        if (!entry?.userId || !entry.amount || !entry.timestamp) {
            continue;
        }

        const amount = Number(entry.amount);
        const timestamp = Number(entry.timestamp);

        if (
            !Number.isFinite(amount) ||
            amount <= 0 ||
            !Number.isFinite(timestamp)
        ) {
            continue;
        }

        const entryKeys = getLeaderboardCacheKeys(timestamp);

        for (const period of ["today", "week", "month"]) {
            if (
                entryKeys[period].users !==
                currentKeys[period].users
            ) {
                continue;
            }

            const userId = String(entry.userId);

            periods[period].set(
                userId,
                (periods[period].get(userId) || 0) + amount
            );

            totals[period] += amount;
        }
    }

    // Rebuild current-period cache keys.
    const writePipeline = redis.pipeline();

    for (const period of ["today", "week", "month"]) {
        const keys = currentKeys[period];

        writePipeline.del(keys.users);
        writePipeline.del(keys.total);

        for (const [userId, amount] of periods[period]) {
            writePipeline.zadd(keys.users, {
                score: amount,
                member: userId,
            });
        }

        writePipeline.set(keys.total, totals[period]);

        writePipeline.expire(keys.users, TTL);
        writePipeline.expire(keys.total, TTL);
    }

    await writePipeline.exec();

    console.log("[LEADERBOARD] Cache rebuild completed!");

    console.log({
        ledgerEntries: ledgerIds.length,
        today: {
            users: periods.today.size,
            totalRewarded: totals.today,
        },
        week: {
            users: periods.week.size,
            totalRewarded: totals.week,
        },
        month: {
            users: periods.month.size,
            totalRewarded: totals.month,
        },
    });
}
// const TTL = 400 * 24 * 60 * 60; // 400 days
// rebuildLeaderboardCache()
//     .catch(console.error);
module.exports = {
    recordParticipation,
    recordMora,
    getMoraLeaderboard,
    getTotalMoraRewarded,
    getDayParticipants,
    getDayCounts,
    getDayMora,
    updateLeaderboardCache,
    getCachedLeaderboard,
    getLast24Hours,
    getAvailableDays,
    getDayStats,
    getUserDayCount,
    getAllStats,

    getDateKey,
};