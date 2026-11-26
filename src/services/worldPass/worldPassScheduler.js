
// src/services/worldPass/worldPassScheduler.js

const {
    getAllActiveAttemptIds,
    getChallengeAttempt,
    expireChallengeAttempt,
    removeGlobalActiveAttemptId,
} = require("./worldPassRedis");

const {
    incrementWorldPassStat,
} = require("./worldPassControlRedis");

let schedulerInterval = null;
let schedulerRunning = false;

const CHECK_INTERVAL = 15 * 1000;

// ==========================================
// EXPIRE ACTIVE ATTEMPTS
// ==========================================

async function expireWorldPassAttempts() {
    if (schedulerRunning) return;

    schedulerRunning = true;

    try {
        const attemptIds = await getAllActiveAttemptIds();

        if (!attemptIds.length) return;

        const now = Date.now();

        for (const attemptId of attemptIds) {
            try {
                const attempt = await getChallengeAttempt(attemptId);

                // Remove stale IDs from the global index.
                if (!attempt) {
                    await removeGlobalActiveAttemptId(attemptId);
                    continue;
                }

                // Remove attempts that are no longer active.
                if (attempt.status !== "active") {
                    await removeGlobalActiveAttemptId(attemptId);
                    continue;
                }

                // Not expired yet.
                if (now < Number(attempt.expiresAt)) {
                    continue;
                }

                const result = await expireChallengeAttempt(
                    attempt.userId,
                    attemptId
                );

                if (result === 1) {
                    await incrementWorldPassStat("expired").catch(error => {
                        console.error(
                            "[World Pass] Could not record expiry statistic:",
                            error.message
                        );
                    });

                    console.log(
                        `[World Pass] Challenge expired | ${attemptId} | User: ${attempt.userId}`
                    );
                } else if (result === 0) {
                    await removeGlobalActiveAttemptId(attemptId);
                }

            } catch (error) {
                console.error(
                    `[World Pass] Expiry failed for ${attemptId}:`,
                    error.message
                );
            }
        }

    } catch (error) {
        console.error(
            "[World Pass] Scheduler failed:",
            error.message
        );
    } finally {
        schedulerRunning = false;
    }
}

// ==========================================
// START SCHEDULER
// ==========================================

function startWorldPassScheduler() {
    if (schedulerInterval) return;

    console.log("[World Pass] Expiry scheduler started.");

    // Recover expired attempts after a restart.
    expireWorldPassAttempts();

    schedulerInterval = setInterval(
        expireWorldPassAttempts,
        CHECK_INTERVAL
    );
}

// ==========================================
// STOP SCHEDULER
// ==========================================

function stopWorldPassScheduler() {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
    }

    console.log("[World Pass] Expiry scheduler stopped.");
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
    startWorldPassScheduler,
    stopWorldPassScheduler,
    expireWorldPassAttempts,
};
