
// src/services/worldPass/worldPassService.js

const { WORLD_PASS_CONFIG } = require("./worldPassConfig");

const {
    getPassInventory,
    claimQuestion,
    addQuestionsToPool,
    createChallengeAttempt,
    getChallengeAttempt,
    processChallengeAnswer,
    expireChallengeAttempt,
} = require("./worldPassRedis");

const {
    incrementWorldPassStat,
} = require("./worldPassControlRedis");

// ==========================================
// HELPERS
// ==========================================

function getTierConfig(tier) {
    return WORLD_PASS_CONFIG.CHALLENGES[tier] || null;
}

function getPublicQuestion(attempt) {
    if (!attempt) return null;

    return {
        attemptId: attempt.attemptId,
        tier: attempt.tier,
        question: attempt.question,
        options: attempt.options,
        expiresAt: attempt.expiresAt,
    };
}

// ==========================================
// START CHALLENGE
// ==========================================

async function startWorldPassChallenge(userId, tier) {
    userId = String(userId);

    if (!userId) {
        throw new Error("A valid user ID is required.");
    }

    const config = getTierConfig(tier);

    if (!config) {
        return {
            success: false,
            code: "INVALID_TIER",
        };
    }

    const inventory = await getPassInventory(userId);
    const tierInventory = inventory[tier];

    if (!tierInventory || tierInventory.available < config.passCost) {
        return {
            success: false,
            code: "NOT_ENOUGH_PASSES",
            required: config.passCost,
            available: tierInventory?.available || 0,
        };
    }

    const question = await claimQuestion(tier);

    if (!question) {
        return {
            success: false,
            code: "QUESTION_POOL_EMPTY",
        };
    }

    let result;

    try {
        result = await createChallengeAttempt(
            userId,
            tier,
            question
        );
    } catch (error) {
        await addQuestionsToPool(tier, [question]).catch(
            requeueError => {
                console.error(
                    "[World Pass] Question recovery failed:",
                    requeueError.message
                );
            }
        );

        throw error;
    }

    if (!result?.success || !result.attempt) {
        // Return the claimed question if no attempt was created.
        await addQuestionsToPool(tier, [question]);

        return {
            success: false,
            code:
                result?.reason === "INSUFFICIENT_PASSES"
                    ? "NOT_ENOUGH_PASSES"
                    : "ENTRY_CREATION_FAILED",
        };
    }

    return {
        success: true,
        attempt: getPublicQuestion(result.attempt),
        passCost: config.passCost,
        reward: config.reward,
    };
}

// ==========================================
// SUBMIT ANSWER
// ==========================================

async function answerWorldPassChallenge(
    userId,
    attemptId,
    selectedAnswer
) {
    userId = String(userId);
    attemptId = String(attemptId);

    if (
        !userId ||
        !attemptId ||
        typeof selectedAnswer !== "string"
    ) {
        throw new Error("Invalid challenge answer details.");
    }

    const attempt = await getChallengeAttempt(attemptId);

    if (!attempt) {
        return {
            success: false,
            code: "ATTEMPT_NOT_FOUND",
        };
    }

    if (attempt.userId !== userId) {
        return {
            success: false,
            code: "NOT_YOUR_ATTEMPT",
        };
    }

    if (attempt.status !== "active") {
        return {
            success: false,
            code: "ATTEMPT_ALREADY_FINISHED",
        };
    }

    if (Date.now() >= attempt.expiresAt) {
        const expired = await expireChallengeAttempt(userId, attemptId);

        if (expired === 1) {
            await incrementWorldPassStat("expired").catch(error => {
                console.error(
                    "[World Pass] Could not record expiry statistic:",
                    error.message
                );
            });
        }

        return {
            success: false,
            code: "ATTEMPT_EXPIRED",
        };
    }

    if (!attempt.options?.includes(selectedAnswer)) {
        return {
            success: false,
            code: "INVALID_ANSWER",
        };
    }

    const result = await processChallengeAnswer(
        userId,
        attemptId,
        selectedAnswer
    );

    if (!result?.success) {
        return {
            success: false,
            code: result?.reason || "ANSWER_PROCESSING_FAILED",
        };
    }

    if (result.correct) {
        return {
            success: true,
            correct: true,
            tier: attempt.tier,
            reward: result.reward,
            explanation: attempt.explanation || null,
            message: "Correct answer! Your Mora reward is being processed.",
        };
    }

    return {
        success: true,
        correct: false,
        tier: attempt.tier,
        explanation: attempt.explanation || null,
        message: "Incorrect answer. Your passes have been returned. You can try again.",
    };
}

// ==========================================
// EXPIRE CHALLENGE
// ==========================================

async function expireWorldPassChallenge(userId, attemptId) {
    if (!userId || !attemptId) {
        throw new Error("User ID and attempt ID are required.");
    }

    return expireChallengeAttempt(
        String(userId),
        String(attemptId)
    );
}

// ==========================================
// GET PLAYER INVENTORY
// ==========================================

async function getWorldPassPlayerInventory(userId) {
    return getPassInventory(String(userId));
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
    startWorldPassChallenge,
    answerWorldPassChallenge,
    expireWorldPassChallenge,
    getWorldPassPlayerInventory,
};
