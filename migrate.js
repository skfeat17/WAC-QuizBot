
require("dotenv").config();

const { Redis } = require("@upstash/redis");

// ==========================================
// DATABASE CONFIGURATION
// ==========================================

const sourceRedis = new Redis({
    url: process.env.SOURCE_UPSTASH_REDIS_REST_URL,
    token: process.env.SOURCE_UPSTASH_REDIS_REST_TOKEN,
});

const destinationRedis = new Redis({
    url: process.env.DESTINATION_UPSTASH_REDIS_REST_URL,
    token: process.env.DESTINATION_UPSTASH_REDIS_REST_TOKEN,
});

// ==========================================
// SETTINGS
// ==========================================

const SOURCE_KEY = "wac:mysteryevent:pool";
const DESTINATION_KEY = "wac:mysteryevent:pool";

const BATCH_SIZE = 100;

// ==========================================
// VALIDATE ENVIRONMENT
// ==========================================

function validateEnvironment() {
    const required = [
        "SOURCE_UPSTASH_REDIS_REST_URL",
        "SOURCE_UPSTASH_REDIS_REST_TOKEN",
        "DESTINATION_UPSTASH_REDIS_REST_URL",
        "DESTINATION_UPSTASH_REDIS_REST_TOKEN",
    ];

    for (const key of required) {
        if (!process.env[key]) {
            throw new Error(`Missing environment variable: ${key}`);
        }
    }
}

// ==========================================
// NORMALIZE REDIS VALUES
// ==========================================

function normalizeQuestion(question) {
    return typeof question === "string"
        ? question
        : JSON.stringify(question);
}

// ==========================================
// MIGRATION
// ==========================================

async function migrateQuestionPool() {
    console.log("================================");
    console.log(" MYSTERY QUESTION POOL MIGRATION");
    console.log("================================");

    validateEnvironment();

    // 1. Read source pool
    console.log("\n📥 Reading source question pool...");

    const sourceQuestions = await sourceRedis.lrange(
        SOURCE_KEY,
        0,
        -1
    );

    if (!Array.isArray(sourceQuestions) || sourceQuestions.length === 0) {
        console.log("ℹ️ Source question pool is empty.");
        return;
    }

    const questions = sourceQuestions.map(normalizeQuestion);

    console.log(`📦 Found ${questions.length} questions.`);

    // 2. Check destination pool
    const existingCount = Number(
        await destinationRedis.llen(DESTINATION_KEY)
    );

    if (existingCount > 0) {
        throw new Error(
            `Destination already contains ${existingCount} questions. ` +
            "Migration cancelled to prevent duplicates."
        );
    }

    // 3. Copy questions in batches
    console.log("\n📤 Transferring questions...");

    let transferred = 0;

    for (let i = 0; i < questions.length; i += BATCH_SIZE) {
        const batch = questions.slice(
            i,
            i + BATCH_SIZE
        );

        await destinationRedis.rpush(
            DESTINATION_KEY,
            ...batch
        );

        transferred += batch.length;

        console.log(
            `✅ Transferred ${transferred}/${questions.length}`
        );
    }

    // 4. Verify destination
    console.log("\n🔍 Verifying destination...");

    const destinationQuestions = await destinationRedis.lrange(
        DESTINATION_KEY,
        0,
        -1
    );

    const copiedQuestions = destinationQuestions.map(normalizeQuestion);

    const isValid =
        copiedQuestions.length === questions.length &&
        copiedQuestions.every(
            (question, index) => question === questions[index]
        );

    if (!isValid) {
        throw new Error(
            `Verification failed! Source: ${questions.length}, ` +
            `Destination: ${copiedQuestions.length}`
        );
    }

    // 5. Success
    console.log("\n================================");
    console.log("       MIGRATION SUCCESS");
    console.log("================================");

    console.log(`📦 Total questions: ${questions.length}`);
    console.log(`✅ Transferred: ${transferred}`);
    console.log("🔍 Verification: Passed");
    console.log("🔒 Source database: Untouched");
    console.log("================================");
}

// ==========================================
// RUN
// ==========================================

migrateQuestionPool().catch((error) => {
    console.error("\n❌ MIGRATION FAILED:");
    console.error(error);
    process.exitCode = 1;
});
