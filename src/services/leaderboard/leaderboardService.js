const {
    getCachedLeaderboard,
} = require("./leaderboardRedis");

async function getLeaderboardData() {
    const cached = await getCachedLeaderboard();

    return {
        generatedAt: cached.generatedAt,

        sections: [
            {
                key: "today",
                title: "TODAY'S TOP EARNERS",
                entries: cached.today.entries,
                totalRewarded: cached.today.totalRewarded,
            },
            {
                key: "week",
                title: "THIS WEEK'S TOP EARNERS",
                entries: cached.week.entries,
                totalRewarded: cached.week.totalRewarded,
            },
            {
                key: "month",
                title: "THIS MONTH'S TOP EARNERS",
                entries: cached.month.entries,
                totalRewarded: cached.month.totalRewarded,
            },
        ],
    };
}

module.exports = { getLeaderboardData };