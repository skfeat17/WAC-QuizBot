require("dotenv").config();

const { Redis } = require("@upstash/redis");

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ==========================================
// REDIS KEYS
// ==========================================

const PAYMENT_PREFIX = "wac:payment:transaction:";

const LEADERBOARD_ZSET =
    "wac:leaderboard:v1:mora:activity";

const LEADERBOARD_HASH =
    "wac:leaderboard:v1:mora:entries";

const MYSTERY_DAYS_KEY =
    "wac:stats:mystery:days";

const MIGRATED_KEY =
    "wac:stats:mystery:migration:payment-transactions";

// ==========================================
// SETTINGS
// ==========================================

const SCAN_COUNT = 100;

const TTL = 400 * 24 * 60 * 60;

// November 1, 2026, 00:00 IST
const START_TIMESTAMP = Date.parse(
    "2026-11-01T00:00:00+05:30"
);

// Capture current time when script starts
const END_TIMESTAMP = Date.now();

// ==========================================
// HELPERS
// ==========================================

function parseTransaction(raw) {
    if (!raw) return null;

    if (typeof raw === "string") {
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    return raw;
}

function toTimestamp(value) {
    if (value === null || value === undefined) {
        return null;
    }

    if (value instanceof Date) {
        const timestamp = value.getTime();
        return Number.isFinite(timestamp) ? timestamp : null;
    }

    if (
        typeof value === "number" ||
        /^\d+(\.\d+)?$/.test(String(value).trim())
    ) {
        const numeric = Number(value);

        if (!Number.isFinite(numeric)) {
            return null;
        }

        // Unix seconds -> milliseconds
        return numeric < 100000000000
            ? numeric * 1000
            : numeric;
    }

    const parsed = Date.parse(String(value));

    return Number.isFinite(parsed) ? parsed : null;
}

// Use paidAt first, then createdAt as fallback.
function getTransactionTimestamp(transaction) {
    const paidAt = toTimestamp(transaction.paidAt);

    if (paidAt !== null) {
        return {
            timestamp: paidAt,
            source: "paidAt",
        };
    }

    const createdAt = toTimestamp(transaction.createdAt);

    if (createdAt !== null) {
        return {
            timestamp: createdAt,
            source: "createdAt",
        };
    }

    return {
        timestamp: null,
        source: null,
    };
}

// Match the existing Stats Service convention (UTC).
function getDateKey(timestamp) {
    return new Date(timestamp)
        .toISOString()
        .slice(0, 10);
}

function isMysteryEvent(transaction) {
    const values = [
        transaction.eventType,
        transaction.eventName,
        transaction.event,
    ];

    return values.some(value =>
        String(value || "")
            .trim()
            .toLowerCase()
            .includes("mystery")
    );
}

function isPaid(transaction) {
    return String(transaction.status || "")
        .trim()
        .toLowerCase() === "paid";
}

function isWithinDateRange(timestamp) {
    return (
        timestamp >= START_TIMESTAMP &&
        timestamp <= END_TIMESTAMP
    );
}

function formatIST(timestamp) {
    if (!timestamp) return "Invalid date";

    return new Date(timestamp).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "medium",
    });
}

// ==========================================
// MIGRATION STATISTICS
// ==========================================

const stats = {
    scanned: 0,
    matched: 0,

    dailyMigrated: 0,
    leaderboardMigrated: 0,

    alreadyMigrated: 0,

    skippedNotMystery: 0,
    skippedUnpaid: 0,
    skippedOutOfRange: 0,
    skippedInvalid: 0,

    errors: 0,
};

// ==========================================
// PROCESS ONE TRANSACTION
// ==========================================

async function processTransaction(key) {
    try {
        const raw = await redis.get(key);
        const transaction = parseTransaction(raw);

        if (
            !transaction ||
            !transaction.transactionId ||
            !transaction.winnerId
        ) {
            stats.skippedInvalid++;
            return;
        }

        // Mystery Event only
        if (!isMysteryEvent(transaction)) {
            stats.skippedNotMystery++;
            return;
        }

        // Paid transactions only
        if (!isPaid(transaction)) {
            stats.skippedUnpaid++;
            return;
        }

        // Get payment date
        const {
            timestamp,
            source: timestampSource,
        } = getTransactionTimestamp(transaction);

        const amount = Number(transaction.reward);

        if (
            timestamp === null ||
            !Number.isFinite(amount) ||
            amount <= 0
        ) {
            console.log("\nINVALID TRANSACTION:", {
                transactionId: transaction.transactionId,
                createdAt: transaction.createdAt,
                paidAt: transaction.paidAt,
                reward: transaction.reward,
            });

            stats.skippedInvalid++;
            return;
        }

        // November 1 through script start time
        if (!isWithinDateRange(timestamp)) {
            console.log("\n⚠️ OUTSIDE DATE RANGE:", {
                transactionId: transaction.transactionId,

                timestampSource,

                createdAt: transaction.createdAt,
                paidAt: transaction.paidAt,

                selectedTimestamp: timestamp,
                selectedDateIST: formatIST(timestamp),

                startDateIST: formatIST(START_TIMESTAMP),
                endDateIST: formatIST(END_TIMESTAMP),

                beforeStart: timestamp < START_TIMESTAMP,
                afterEnd: timestamp > END_TIMESTAMP,
            });

            stats.skippedOutOfRange++;
            return;
        }

        stats.matched++;

        const transactionId = String(
            transaction.transactionId
        );

        const userId = String(
            transaction.winnerId
        );

        const dateKey = getDateKey(timestamp);

        const ledgerId = `payment:${transactionId}`;

        const dailyMoraKey =
            `wac:stats:mystery:day:${dateKey}:mora`;

        // ==================================
        // 1. MIGRATE DAILY STATS
        // ==================================

        const alreadyMigrated = await redis.sismember(
            MIGRATED_KEY,
            transactionId
        );

        if (!alreadyMigrated) {
            await redis.hincrby(
                dailyMoraKey,
                userId,
                amount
            );

            await redis.sadd(
                MYSTERY_DAYS_KEY,
                dateKey
            );

            await redis.expire(
                dailyMoraKey,
                TTL
            );

            await redis.expire(
                MYSTERY_DAYS_KEY,
                TTL
            );

            await redis.sadd(
                MIGRATED_KEY,
                transactionId
            );

            await redis.expire(
                MIGRATED_KEY,
                TTL
            );

            stats.dailyMigrated++;
        } else {
            stats.alreadyMigrated++;
        }

        // ==================================
        // 2. MIGRATE GLOBAL LEADERBOARD
        // ==================================

        const entry = {
            userId,
            amount,
            event: "mystery",
            timestamp,
            source: "payment_transaction",
            transactionId,
        };

        const ledgerExists = await redis.hexists(
            LEADERBOARD_HASH,
            ledgerId
        );

        if (!ledgerExists) {
            await redis.hset(
                LEADERBOARD_HASH,
                {
                    [ledgerId]: JSON.stringify(entry),
                }
            );

            stats.leaderboardMigrated++;
        }

        // Always ensure the ZSET entry exists.
        // This also repairs missing ZSET entries.
        await redis.zadd(
            LEADERBOARD_ZSET,
            {
                score: timestamp,
                member: ledgerId,
            }
        );

        await redis.expire(
            LEADERBOARD_HASH,
            TTL
        );

        await redis.expire(
            LEADERBOARD_ZSET,
            TTL
        );

        console.log(
            `✅ ${transactionId} | ` +
            `${transaction.username || userId} | ` +
            `${amount} Mora | ` +
            `${formatIST(timestamp)} (${timestampSource})`
        );

    } catch (error) {
        stats.errors++;

        console.error(
            `❌ Transaction error (${key}):`,
            error.message || error
        );
    }
}

// ==========================================
// SCAN ALL TRANSACTIONS
// ==========================================

async function migrateAllTransactions() {
    if (
        !process.env.UPSTASH_REDIS_REST_URL ||
        !process.env.UPSTASH_REDIS_REST_TOKEN
    ) {
        throw new Error("Missing Upstash Redis credentials in .env");
    }

    console.log("\n==========================================");
    console.log("       MYSTERY EVENT DATA MIGRATION");
    console.log("==========================================");

    console.log("Start:", formatIST(START_TIMESTAMP));
    console.log("End:", formatIST(END_TIMESTAMP));

    let cursor = "0";
    let batchNumber = 0;

    do {
        const result = await redis.scan(cursor, {
            match: `${PAYMENT_PREFIX}*`,
            count: SCAN_COUNT,
        });

        cursor = String(result[0]);
        const keys = result[1] || [];

        batchNumber++;

        console.log(
            `\n[BATCH ${batchNumber}] ` +
            `Retrieved: ${keys.length} | ` +
            `Next cursor: ${cursor}`
        );

        for (const key of keys) {
            stats.scanned++;
            await processTransaction(key);
        }

        console.log(
            `[BATCH ${batchNumber}] ` +
            `Scanned: ${stats.scanned} | ` +
            `Daily migrated: ${stats.dailyMigrated} | ` +
            `Leaderboard migrated: ${stats.leaderboardMigrated}`
        );

    } while (cursor !== "0");

    console.log("\n==========================================");
    console.log("           MIGRATION COMPLETED");
    console.log("==========================================");

    console.log(`Total scanned:              ${stats.scanned}`);
    console.log(`Matching Mystery Events:    ${stats.matched}`);

    console.log("\nDAILY STATS:");
    console.log(`Migrated:                   ${stats.dailyMigrated}`);
    console.log(`Already migrated:           ${stats.alreadyMigrated}`);

    console.log("\nLEADERBOARD:");
    console.log(`New entries:                ${stats.leaderboardMigrated}`);

    console.log("\nSKIPPED:");
    console.log(`Not Mystery Event:          ${stats.skippedNotMystery}`);
    console.log(`Unpaid:                     ${stats.skippedUnpaid}`);
    console.log(`Outside date range:         ${stats.skippedOutOfRange}`);
    console.log(`Invalid:                    ${stats.skippedInvalid}`);
    console.log(`Errors:                     ${stats.errors}`);

    console.log("\n==========================================");
}

// ==========================================
// RUN
// ==========================================

migrateAllTransactions().catch(error => {
    console.error("\n🚨 MIGRATION FAILED:", error);

    process.exitCode = 1;
});