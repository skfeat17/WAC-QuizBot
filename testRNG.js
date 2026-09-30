require("dotenv").config();

const { Redis } = require("@upstash/redis");

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function clearStats() {
    const keys = await redis.keys("wac:stats:*");

    console.log(`Found ${keys.length} stats keys.`);

    if (!keys.length) {
        console.log("Nothing to delete.");
        return;
    }

    for (const key of keys) {
        await redis.del(key);
        console.log(`Deleted: ${key}`);
    }

    console.log("✅ All WAC stats have been wiped.");
}

clearStats().catch(console.error);