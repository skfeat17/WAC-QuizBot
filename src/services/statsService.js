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


const DAY_TTL_SECONDS =
    400 * 24 * 60 * 60;


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



    //Get YYYY-MM-DD for India (IST).

function getDateKey(timestamp = Date.now()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date(timestamp));
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

    Mystery:
    Call when user successfully claims/reveals a mystery.

    Chest:
    Call when user successfully opens/claims a chest.
*/
async function recordParticipation(
    event,
    userId,
    timestamp = Date.now()
) {
    validateEvent(event);

    if (!userId) {
        throw new Error(
            "userId is required"
        );
    }

    const dateKey =
        getDateKey(timestamp);

    const keys =
        getDayKeys(event, dateKey);

    const daysKey =
        getDaysKey(event);

    /*
        Unique activity ID.

        Format:
        timestamp:userId:random
    */
    const activityId =
        `${timestamp}:${userId}:${Math.random()
            .toString(36)
            .slice(2, 8)}`;

    await Promise.all([
        redis.sadd(
            keys.participants,
            userId
        ),

        redis.hincrby(
            keys.counts,
            userId,
            1
        ),

        redis.zadd(
            keys.activity,
            {
                score: timestamp,
                member: activityId,
            }
        ),

        redis.sadd(
            daysKey,
            dateKey
        ),

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
    Record Mora awarded/spent for one user
    on a specific participation.

    This is stored separately from participation
    counts so the stats page can show:

    🎁 Mora Awarded: 125
*/
async function recordMora(
    event,
    userId,
    amount,
    timestamp = Date.now()
) {
    validateEvent(event);

    if (!userId) {
        throw new Error(
            "userId is required"
        );
    }

    const numericAmount =
        Number(amount);

    if (
        !Number.isFinite(numericAmount) ||
        numericAmount <= 0
    ) {
        throw new Error(
            "Invalid Mora amount"
        );
    }

    const dateKey =
        getDateKey(timestamp);

    const keys =
        getDayKeys(event, dateKey);

    const daysKey =
        getDaysKey(event);

    await Promise.all([
        redis.hincrby(
            keys.mora,
            userId,
            numericAmount
        ),

        redis.sadd(
            daysKey,
            dateKey
        ),

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
    const keys =
        getDayKeys(event, dateKey);

    return await redis.smembers(
        keys.participants
    );
}


/*
    Get participation counts
    for every user on a day.
*/
async function getDayCounts(
    event,
    dateKey
) {
    const keys =
        getDayKeys(event, dateKey);

    const data =
        await redis.hgetall(
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
        .sort(
            (a, b) =>
                b.count - a.count
        );
}


/*
    Get Mora totals for every user
    on a specific day.
*/
async function getDayMora(
    event,
    dateKey
) {
    const keys =
        getDayKeys(event, dateKey);

    const data =
        await redis.hgetall(
            keys.mora
        );

    if (!data) {
        return {
            total: 0,
            users: [],
        };
    }


    const users =
        Object.entries(data)
            .map(([userId, amount]) => ({
                userId,
                amount:
                    Number(amount) || 0,
            }))
            .filter(
                entry =>
                    entry.amount > 0
            )
            .sort(
                (a, b) =>
                    b.amount - a.amount
            );


    return {
        total:
            users.reduce(
                (sum, entry) =>
                    sum + entry.amount,
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
        now -
        (24 * 60 * 60 * 1000);


    const days =
        await getAvailableDays(event);


    const users = new Set();

    let totalParticipations = 0;


    for (const dateKey of days) {
        const keys =
            getDayKeys(
                event,
                dateKey
            );


        const activityIds =
            await redis.zrange(
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


        totalParticipations +=
            activityIds.length;


        for (const activityId of activityIds) {
            const parts =
                String(activityId)
                    .split(":");


            if (parts.length >= 2) {
                users.add(
                    parts[1]
                );
            }
        }
    }


    return {
        participants:
            users.size,

        totalParticipations,
    };
}


/*
    Get every stored day.

    Newest first.
*/
async function getAvailableDays(
    event
) {
    const daysKey =
        getDaysKey(event);

    const days =
        await redis.smembers(
            daysKey
        );


    return (days || [])
        .sort()
        .reverse();
}


/*
    Get complete stats for
    one specific day.
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
        getDayParticipants(
            event,
            dateKey
        ),

        getDayCounts(
            event,
            dateKey
        ),

        getDayMora(
            event,
            dateKey
        ),
    ]);


    return {
        event,
        dateKey,

        participants:
            participants.length,

        totalParticipations:
            counts.reduce(
                (total, entry) =>
                    total + entry.count,
                0
            ),

        totalMora:
            mora.total,

        users: counts,

        moraUsers:
            mora.users,
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
    const keys =
        getDayKeys(
            event,
            dateKey
        );


    const count =
        await redis.hget(
            keys.counts,
            userId
        );


    return Number(count) || 0;
}


/*
    Get all stored statistics.
*/
async function getAllStats(
    event
) {
    const days =
        await getAvailableDays(event);


    const stats = [];


    for (const dateKey of days) {
        stats.push(
            await getDayStats(
                event,
                dateKey
            )
        );
    }


    return stats;
}


module.exports = {
    recordParticipation,
    recordMora,

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
