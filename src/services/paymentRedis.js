
require("dotenv").config();

const { Redis } = require("@upstash/redis");

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PREFIX = "wac:payment:";
const TRANSACTION_TTL_SECONDS = 30 * 24 * 60 * 60;

function transactionKey(transactionId) {
    return `${PREFIX}transaction:${transactionId}`;
}

function rewardMappingKey(rewardId) {
    return `${PREFIX}worldpass:${rewardId}`;
}

async function savePaymentTransaction(transaction) {
    await redis.set(transactionKey(transaction.transactionId), transaction, {
        ex: TRANSACTION_TTL_SECONDS,
    });

    return true;
}

async function getPaymentTransaction(transactionId) {
    return await redis.get(transactionKey(transactionId));
}

async function updatePaymentTransaction(transactionId, updates) {
    const transaction = await getPaymentTransaction(transactionId);

    if (!transaction) return null;

    const updated = {
        ...transaction,
        ...updates,
        updatedAt: Date.now(),
    };

    await savePaymentTransaction(updated);

    return updated;
}

async function deletePaymentTransaction(transactionId) {
    await redis.del(transactionKey(transactionId));
    return true;
}

/*
|--------------------------------------------------------------------------
| World Pass Reward Mapping
|--------------------------------------------------------------------------
*/

// Atomically associate one World Pass reward with one transaction ID.
// NX prevents a retry from replacing an existing mapping.

async function linkWorldPassReward(rewardId, transactionId) {
    if (!rewardId || !transactionId) {
        throw new Error("Reward ID and transaction ID are required.");
    }

    const result = await redis.set(
        rewardMappingKey(rewardId),
        transactionId,
        {
            ex: TRANSACTION_TTL_SECONDS,
            nx: true,
        }
    );

    return result === "OK";
}

async function getWorldPassRewardTransaction(rewardId) {
    if (!rewardId) return null;

    return await redis.get(rewardMappingKey(rewardId));
}

module.exports = {
    TRANSACTION_TTL_SECONDS,
    savePaymentTransaction,
    getPaymentTransaction,
    updatePaymentTransaction,
    deletePaymentTransaction,
    linkWorldPassReward,
    getWorldPassRewardTransaction,
};
