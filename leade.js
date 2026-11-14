require("dotenv").config();

const {
    getMoraLeaderboard,
} = require("./statsService");

const { Redis } = require("@upstash/redis");

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function test() {
    const ZSET = "wac:leaderboard:v1:mora:activity";
    const HASH = "wac:leaderboard:v1:mora:entries";

    console.log("\n========== LEADERBOARD DEBUG ==========\n");

    // 1. Check stored records
    const zcard = await redis.zcard(ZSET);
    const hlen = await redis.hlen(HASH);

    console.log("Sorted Set:", zcard);
    console.log("Hash:", hlen);

    // 2. Inspect latest timestamps
    const latest = await redis.zrange(
        ZSET,
        0,
        -1,
        { rev: true, withScores: true }
    );

    console.log("\nLatest Redis entries:");
    console.dir(latest.slice(0, 5), { depth: null });

    // 3. Retrieve leaderboard for last 30 days
    const start = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const results = await getMoraLeaderboard(
        start,
        Date.now()
    );

    console.log("\nLeaderboard results:");
    console.table(results);

    // 4. Check individual records
    const ids = await redis.zrange(ZSET, 0, 4);

    console.log("\nIndividual records:");

    for (const id of ids) {
        console.log("ID:", id);
        console.log("Data:", await redis.hget(HASH, id));
    }

    console.log("\n=======================================");
}

test().catch(console.error);