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

module.exports = {
    TRANSACTION_TTL_SECONDS,
    savePaymentTransaction,
    getPaymentTransaction,
    updatePaymentTransaction,
    deletePaymentTransaction,
};
