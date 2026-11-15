const {
    getCachedLeaderboard,
} = require("./leaderboardRedis");

const {
    getLeaderboardParticipationSummary,
} = require("../statsService");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function getIstParts(timestamp) {
    const date = new Date(timestamp + IST_OFFSET_MS);

    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth(),
        day: date.getUTCDate(),
        weekday: date.getUTCDay(),
    };
}

function istMidnightUtcMs(year, month, day) {
    return Date.UTC(year, month, day) - IST_OFFSET_MS;
}

function getPeriods(now = Date.now()) {
    const p = getIstParts(now);

    const todayStart = istMidnightUtcMs(
        p.year,
        p.month,
        p.day
    );

    const daysSinceMonday = (p.weekday + 6) % 7;

    const weekStart =
        todayStart - daysSinceMonday * DAY_MS;

    const monthStart = istMidnightUtcMs(
        p.year,
        p.month,
        1
    );

    return {
        today: {
            start: todayStart,
            end: todayStart + DAY_MS,
        },

        week: {
            start: weekStart,
            end: weekStart + 7 * DAY_MS,
        },

        month: {
            start: monthStart,
            end: istMidnightUtcMs(
                p.year,
                p.month + 1,
                1
            ),
        },
    };
}

async function getLeaderboardData() {
    const now = Date.now();

    const [cached, periods] = await Promise.all([
        getCachedLeaderboard(),
        Promise.resolve(getPeriods(now)),
    ]);

    const [todayStats, weekStats, monthStats] =
        await Promise.all([
            getLeaderboardParticipationSummary(
                periods.today.start,
                periods.today.end
            ),

            getLeaderboardParticipationSummary(
                periods.week.start,
                periods.week.end
            ),

            getLeaderboardParticipationSummary(
                periods.month.start,
                periods.month.end
            ),
        ]);

    return {
        generatedAt: now,

        sections: [
            {
                key: "today",
                title: "TODAY'S TOP EARNERS",
                entries: cached.today.entries,
                totalRewarded: cached.today.totalRewarded,
                ...todayStats,
            },

            {
                key: "week",
                title: "THIS WEEK'S TOP EARNERS",
                entries: cached.week.entries,
                totalRewarded: cached.week.totalRewarded,
                ...weekStats,
            },

            {
                key: "month",
                title: "THIS MONTH'S TOP EARNERS",
                entries: cached.month.entries,
                totalRewarded: cached.month.totalRewarded,
                ...monthStats,
            },
        ],
    };
}

module.exports = {
    getLeaderboardData,
};