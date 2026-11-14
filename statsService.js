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


module.exports = {
    recordParticipation,
    recordMora,
    getMoraLeaderboard,

    getDayParticipants,
    getDayCounts,
    getDayMora,

    getLast24Hours,
    getAvailableDays,
    getDayStats,
    getUserDayCount,
    getAllStats,

    getDateKey,
};