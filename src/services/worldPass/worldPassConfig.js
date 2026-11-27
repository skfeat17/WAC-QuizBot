
// src/services/worldPass/worldPassConfig.js

// ==========================================
// WORLD PASS CONFIGURATION
// ==========================================

const WORLD_PASS_CONFIG = {
    // --------------------------------------
    // PASS DROP RATES
    // Awarded only after a CORRECT
    // Daily World Mystery Event answer.
    // Total must equal exactly 100.
    // --------------------------------------

    DROP_RATES: {
        explorer: 65,
        voyager: 20,
        pathfinder: 10,
        discoverer: 4,
        celestial: 1,
    },

    // --------------------------------------
    // CHALLENGE TIERS
    // Edit costs and rewards here.
    // --------------------------------------

    CHALLENGES: {
        explorer: {
            name: "Explorer",
            emoji: "🥉",
            passCost: 10,
            reward: 50,
            difficulty: "easy",
        },

        voyager: {
            name: "Voyager",
            emoji: "🥈",
            passCost: 10,
            reward: 100,
            difficulty: "easy-medium",
        },

        pathfinder: {
            name: "Pathfinder",
            emoji: "🥇",
            passCost: 10,
            reward: 150,
            difficulty: "medium-hard",
        },

        discoverer: {
            name: "Discoverer",
            emoji: "💎",
            passCost: 10,
            reward: 300,
            difficulty: "hard",
        },

        celestial: {
            name: "Celestial",
            emoji: "🌌",
            passCost: 10,
            reward: 500,
            difficulty: "very-hard",
        },
    },

    // --------------------------------------
    // QUESTION SETTINGS
    // --------------------------------------

    QUESTION_SETTINGS: {
        // Each question expires independently.
        expiryMs: 10 * 60 * 1000,

        // Multiple active questions per player.
        allowMultipleActive: true,

        // Incorrect answers release the reservation.
        // Players can immediately start another challenge.
        retryImmediately: true,

        maxOptions: 4,
    },

    // --------------------------------------
    // QUESTION POOL SETTINGS
    // --------------------------------------

    POOL_SETTINGS: {
        minimumSize: 5,
        targetSize: 100,

        // Restock each tier independently.
        backgroundRestock: true,

        // Prevent recently used questions from
        // being immediately added back.
        historyLimit: 500,
    },

    // --------------------------------------
    // REDIS SETTINGS
    // --------------------------------------

    REDIS: {
        prefix: "wac:worldpass:",
        inventoryTtlSeconds: 365 * 24 * 60 * 60,
        attemptTtlSeconds: 24 * 60 * 60,
        rewardTtlSeconds: 30 * 24 * 60 * 60,
    },

    // --------------------------------------
    // PAYMENT SETTINGS
    // --------------------------------------

    PAYMENT: {
        // Pending rewards can be retried.
        maxRetryAttempts: 10,
        retryDelayMs: 30 * 1000,
    },
};

// ==========================================
// VALIDATION
// ==========================================

function validateWorldPassConfig() {
    const tiers = Object.keys(
        WORLD_PASS_CONFIG.CHALLENGES
    );

    const dropRateTiers = Object.keys(
        WORLD_PASS_CONFIG.DROP_RATES
    );

    if (
        tiers.length !== dropRateTiers.length ||
        tiers.some((tier) => !dropRateTiers.includes(tier))
    ) {
        throw new Error(
            "[World Pass] Drop-rate tiers do not match challenge tiers."
        );
    }

    const totalDropRate = Object.values(
        WORLD_PASS_CONFIG.DROP_RATES
    ).reduce((sum, rate) => {
        if (
            !Number.isFinite(rate) ||
            rate < 0 ||
            rate > 100
        ) {
            throw new Error(
                "[World Pass] Invalid pass drop rate."
            );
        }

        return sum + rate;
    }, 0);

    if (Math.abs(totalDropRate - 100) > 0.000001) {
        throw new Error(
            `[World Pass] Drop rates must total 100%. Current total: ${totalDropRate}%.`
        );
    }

    for (const [tier, config] of Object.entries(
        WORLD_PASS_CONFIG.CHALLENGES
    )) {
        if (
            !Number.isInteger(config.passCost) ||
            config.passCost <= 0
        ) {
            throw new Error(
                `[World Pass] Invalid pass cost for ${tier}.`
            );
        }

        if (
            !Number.isInteger(config.reward) ||
            config.reward <= 0
        ) {
            throw new Error(
                `[World Pass] Invalid Mora reward for ${tier}.`
            );
        }

        if (
            typeof config.name !== "string" ||
            !config.name.trim()
        ) {
            throw new Error(
                `[World Pass] Missing name for ${tier}.`
            );
        }
    }

    if (
        WORLD_PASS_CONFIG.QUESTION_SETTINGS.expiryMs <= 0 ||
        WORLD_PASS_CONFIG.POOL_SETTINGS.minimumSize <= 0 ||
        WORLD_PASS_CONFIG.POOL_SETTINGS.targetSize <
            WORLD_PASS_CONFIG.POOL_SETTINGS.minimumSize
    ) {
        throw new Error(
            "[World Pass] Invalid question or pool settings."
        );
    }

    return true;
}

// ==========================================
// PASS TIER ROLL
// ==========================================

function generateRandomPassTier() {
    const roll = Math.random() * 100;
    let cumulative = 0;

    for (const [tier, chance] of Object.entries(
        WORLD_PASS_CONFIG.DROP_RATES
    )) {
        cumulative += chance;

        if (roll < cumulative) {
            return tier;
        }
    }

    // Floating-point safety fallback.
    return "celestial";
}

// ==========================================
// EXPORTS
// ==========================================

validateWorldPassConfig();

module.exports = {
    WORLD_PASS_CONFIG,
    validateWorldPassConfig,
    generateRandomPassTier,
};
