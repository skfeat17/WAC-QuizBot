
// src/services/worldPass/worldPassReward.js

const {
    WORLD_PASS_CONFIG,
} = require("./worldPassConfig");

const {
    getPendingRewardIds,
    getPendingReward,
    updateRewardStatus,
} = require("./worldPassRedis");

const {
    getWorldPassRewardTransaction,
    getPaymentTransaction,
    linkWorldPassReward,
} = require("../paymentRedis");

const {
    createPaymentTransaction,
} = require("../paymentService");

// ==========================================
// SETTINGS
// ==========================================

const RETRY_DELAY = WORLD_PASS_CONFIG.PAYMENT.retryDelayMs;
const MAX_RETRIES = WORLD_PASS_CONFIG.PAYMENT.maxRetryAttempts;

// A processing reward older than this is considered abandoned.
const PROCESSING_TIMEOUT = 2 * 60 * 1000;

let workerInterval = null;
let workerRunning = false;

// ==========================================
// HELPERS
// ==========================================

function getEventName(tier) {
    const config = WORLD_PASS_CONFIG.CHALLENGES[tier];

    return config
        ? `World Pass Challenge - ${config.name}`
        : "World Pass Challenge";
}

async function getWinnerDetails(client, userId) {
    try {
        const user = await client.users.fetch(userId);

        return {
            displayName: user.globalName || user.username,
            username: user.username,
        };
    } catch {
        return {
            displayName: userId,
            username: userId,
        };
    }
}

// ==========================================
// SUBMIT PAYMENT
// ==========================================

async function submitWorldPassPayment(client, reward) {
    const attemptId = reward.attemptId;

    // Recover an already-created payment transaction.
    const existingTransactionId =
        await getWorldPassRewardTransaction(attemptId);

    if (existingTransactionId) {
        let existingTransaction =
            await getPaymentTransaction(existingTransactionId);

        if (!existingTransaction) {
            throw new Error(
                `Mapped payment transaction ${existingTransactionId} was not found.`
            );
        }

        // Retry staff DMs for older transactions that were linked
        // before notification delivery was verified.
        if (
            !Array.isArray(existingTransaction.staffMessages) ||
            existingTransaction.staffMessages.length === 0
        ) {
            const winner = await getWinnerDetails(
                client,
                reward.userId
            );

            existingTransaction = await createPaymentTransaction({
                client,
                transactionId: existingTransactionId,
                winnerId: reward.userId,
                displayName: winner.displayName,
                username: winner.username,
                eventName: getEventName(reward.tier),
                eventType: "world_pass",
                reward: reward.reward,
                sourceChannelId: null,
                sourceMessageId: null,
            });
        }

        if (
            !Array.isArray(existingTransaction.staffMessages) ||
            existingTransaction.staffMessages.length === 0
        ) {
            throw new Error(
                "Payment transaction exists, but no staff notification was delivered."
            );
        }

        const updated = await updateRewardStatus(
            attemptId,
            "processing",
            "submitted",
            {
                transactionId: existingTransactionId,
                submittedAt: Date.now(),
            }
        );

        if (!updated) {
            throw new Error(
                "Could not mark the recovered reward as submitted."
            );
        }

        console.log(
            `[World Pass] Recovered payment: ${attemptId}`
        );

        return true;
    }

    const winner = await getWinnerDetails(
        client,
        reward.userId
    );

    const transaction = await createPaymentTransaction({
        client,
        transactionId: `WP-${attemptId}`,
        winnerId: reward.userId,
        displayName: winner.displayName,
        username: winner.username,
        eventName: getEventName(reward.tier),
        eventType: "world_pass",
        reward: reward.reward,
        sourceChannelId: null,
        sourceMessageId: null,
    });

    if (!transaction?.transactionId) {
        throw new Error(
            "Payment service did not return a transaction ID."
        );
    }

    // The payment record may be saved even when every staff DM fails.
    // Do not mark the World Pass reward as submitted until at least one
    // staff member has actually received the payment request.
    if (
        !Array.isArray(transaction.staffMessages) ||
        transaction.staffMessages.length === 0
    ) {
        throw new Error(
            "Payment transaction exists, but no staff notification was delivered."
        );
    }

    // Link the World Pass reward to its payment transaction.
    const linked = await linkWorldPassReward(
        attemptId,
        transaction.transactionId
    );

    let finalTransactionId = transaction.transactionId;

    if (!linked) {
        // Another worker may already have linked this reward.
        const existingId =
            await getWorldPassRewardTransaction(attemptId);

        if (existingId) {
            finalTransactionId = existingId;
        } else {
            throw new Error(
                "Could not link the payment transaction."
            );
        }
    }

    const updated = await updateRewardStatus(
        attemptId,
        "processing",
        "submitted",
        {
            transactionId: finalTransactionId,
            submittedAt: Date.now(),
        }
    );

    if (!updated) {
        throw new Error(
            "Could not mark the reward as submitted."
        );
    }

    console.log(
        `[World Pass] Payment submitted: ${attemptId} -> ${finalTransactionId}`
    );

    return true;
}

// ==========================================
// PROCESS ONE REWARD
// ==========================================

async function processOneReward(client, attemptId) {
    let reward = await getPendingReward(attemptId);

    if (!reward) {
        return;
    }

    // Ignore rewards already completed or permanently failed.
    if (
        reward.status === "submitted" ||
        reward.status === "failed"
    ) {
        return;
    }

    // Recover abandoned processing jobs.
    if (reward.status === "processing") {
        const processingAt = reward.processingAt || 0;

        if (Date.now() - processingAt < PROCESSING_TIMEOUT) {
            return;
        }

        const existingTransactionId =
            await getWorldPassRewardTransaction(attemptId);

        if (existingTransactionId) {
            await updateRewardStatus(
                attemptId,
                "processing",
                "submitted",
                {
                    transactionId: existingTransactionId,
                    submittedAt: Date.now(),
                }
            );

            return;
        }

        await updateRewardStatus(
            attemptId,
            "processing",
            "pending",
            {
                processingAt: null,
                lastRecoveryAt: Date.now(),
            }
        );

        return;
    }

    // Atomically claim the pending reward.
    const claimed = await updateRewardStatus(
        attemptId,
        "pending",
        "processing",
        {
            processingAt: Date.now(),
        }
    );

    if (!claimed) {
        return;
    }

    reward = {
        ...reward,
        status: "processing",
        processingAt: Date.now(),
    };

    try {
        await submitWorldPassPayment(client, reward);
    } catch (error) {
        console.error(
            `[World Pass] Reward processing failed (${attemptId}):`,
            error.message
        );

        const attempts = (reward.attempts || 0) + 1;

        const permanentlyFailed = attempts >= MAX_RETRIES;

        await updateRewardStatus(
            attemptId,
            "processing",
            permanentlyFailed ? "failed" : "pending",
            {
                attempts,
                lastError: error.message,
                lastAttemptAt: Date.now(),
                processingAt: null,
            }
        );

        if (permanentlyFailed) {
            console.error(
                `[World Pass] Reward permanently failed: ${attemptId}`
            );
        }
    }
}

// ==========================================
// PROCESS PENDING REWARDS
// ==========================================

async function processPendingWorldPassRewards(client) {
    if (workerRunning || !client) {
        return;
    }

    workerRunning = true;

    try {
        const pendingIds = await getPendingRewardIds();

        if (!Array.isArray(pendingIds) || !pendingIds.length) {
            return;
        }

        for (const attemptId of pendingIds) {
            try {
                await processOneReward(client, attemptId);
            } catch (error) {
                console.error(
                    `[World Pass] Could not process ${attemptId}:`,
                    error.message
                );
            }
        }
    } catch (error) {
        console.error(
            "[World Pass] Reward worker failed:",
            error.message
        );
    } finally {
        workerRunning = false;
    }
}

// ==========================================
// START WORKER
// ==========================================

function startWorldPassRewardWorker(client) {
    if (workerInterval) {
        return;
    }

    console.log("[World Pass] Reward worker started.");

    // Process existing rewards immediately.
    processPendingWorldPassRewards(client);

    workerInterval = setInterval(() => {
        processPendingWorldPassRewards(client);
    }, RETRY_DELAY);
}

// ==========================================
// STOP WORKER
// ==========================================

function stopWorldPassRewardWorker() {
    if (workerInterval) {
        clearInterval(workerInterval);
        workerInterval = null;
    }

    console.log("[World Pass] Reward worker stopped.");
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
    startWorldPassRewardWorker,
    stopWorldPassRewardWorker,
    processPendingWorldPassRewards,
};
