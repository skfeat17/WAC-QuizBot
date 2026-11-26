
// src/services/worldPass/worldPassPool.js

require("dotenv").config();

const initialQuestions = require("./worldPassQuestions.json");

const {
    WORLD_PASS_CONFIG,
} = require("./worldPassConfig");

const {
    getQuestionPoolSize,
    addQuestionsToPool,
} = require("./worldPassRedis");

const {
    restockWorldPassTier,
} = require("./worldPassAI");

// ==========================================
// SETTINGS
// ==========================================

const RESTOCK_CHECK_INTERVAL_MS = 60 * 1000;

// ==========================================
// STATE
// ==========================================

// Prevent duplicate restock jobs for a tier.
const activeRestocks = new Set();

// Prevent multiple initialization calls.
let initializationPromise = null;

// Prevent duplicate interval timers.
let restockInterval = null;

// ==========================================
// VALIDATE INITIAL QUESTIONS
// ==========================================

function getInitialQuestionsForTier(tier) {
    return initialQuestions.filter(question => {
        return (
            question &&
            question.tier === tier &&
            typeof question.id === "string" &&
            typeof question.question === "string" &&
            Array.isArray(question.options) &&
            question.options.length === 4 &&
            typeof question.answer === "string" &&
            question.options.includes(question.answer)
        );
    });
}

// ==========================================
// SEED EMPTY POOLS
// ==========================================

async function seedWorldPassPools() {
    console.log("🌍 World Pass | Checking initial question pools...");

    const results = [];

    for (const tier of Object.keys(WORLD_PASS_CONFIG.CHALLENGES)) {
        try {
            const currentSize = await getQuestionPoolSize(tier);

            if (currentSize > 0) {
                console.log(
                    `📦 World Pass ${tier} | Already has ${currentSize} questions`
                );

                results.push({
                    tier,
                    seeded: 0,
                    existing: currentSize,
                });

                continue;
            }

            const questions = getInitialQuestionsForTier(tier);

            if (!questions.length) {
                console.warn(
                    `⚠️ World Pass ${tier} | No valid initial questions found`
                );

                results.push({
                    tier,
                    seeded: 0,
                    error: "No valid initial questions",
                });

                continue;
            }

            await addQuestionsToPool(tier, questions);

            console.log(
                `✅ World Pass ${tier} | Seeded ${questions.length} initial questions`
            );

            results.push({
                tier,
                seeded: questions.length,
            });

        } catch (error) {
            console.error(
                `❌ World Pass ${tier} | Seeding failed:`,
                error.message
            );

            results.push({
                tier,
                seeded: 0,
                error: error.message,
            });
        }
    }

    return results;
}

// ==========================================
// RESTOCK ONE TIER
// ==========================================

async function checkAndRestockTier(tier) {
    if (!WORLD_PASS_CONFIG.CHALLENGES[tier]) {
        throw new Error(`Invalid World Pass tier: ${tier}`);
    }

    if (activeRestocks.has(tier)) {
        console.log(
            `⏳ World Pass ${tier} | Restock already running`
        );

        return null;
    }

    activeRestocks.add(tier);

    try {
        const settings = WORLD_PASS_CONFIG.POOL_SETTINGS;

        const currentSize = await getQuestionPoolSize(tier);

        if (currentSize >= settings.minimumSize) {
            return {
                tier,
                currentSize,
                restocked: false,
            };
        }

        console.log(
            `⚠️ World Pass ${tier} pool is low | ${currentSize}/${settings.minimumSize}`
        );

        const result = await restockWorldPassTier(tier);

        console.log(
            `✅ World Pass ${tier} | Restock complete | ${result.after} questions`
        );

        return {
            tier,
            currentSize,
            restocked: true,
            ...result,
        };

    } catch (error) {
        console.error(
            `❌ World Pass ${tier} | Restock failed:`,
            error.message
        );

        return {
            tier,
            error: error.message,
        };

    } finally {
        activeRestocks.delete(tier);
    }
}

// ==========================================
// CHECK ALL TIERS
// ==========================================

async function checkAllWorldPassPools() {
    const results = [];

    for (const tier of Object.keys(WORLD_PASS_CONFIG.CHALLENGES)) {
        try {
            const result = await checkAndRestockTier(tier);

            if (result) {
                results.push(result);
            }

        } catch (error) {
            console.error(
                `❌ World Pass pool check failed | ${tier}:`,
                error.message
            );
        }
    }

    return results;
}

// ==========================================
// INITIALIZE POOLS
// ==========================================

async function initializeWorldPassPools() {
    if (initializationPromise) {
        return initializationPromise;
    }

    initializationPromise = (async () => {
        console.log("🌍 Initializing World Pass pools...");

        await seedWorldPassPools();

        console.log("📦 Checking World Pass pool levels...");

        await checkAllWorldPassPools();

        console.log("✅ World Pass pool initialization complete.");

        return true;
    })();

    try {
        return await initializationPromise;
    } catch (error) {
        initializationPromise = null;
        throw error;
    }
}

// ==========================================
// BACKGROUND RESTOCK SCHEDULER
// ==========================================

function startWorldPassPoolManager() {
    if (restockInterval) {
        console.log(
            "⚠️ World Pass pool manager is already running."
        );

        return;
    }

    console.log(
        "⏰ World Pass background pool manager started."
    );

    restockInterval = setInterval(() => {
        checkAllWorldPassPools().catch(error => {
            console.error(
                "❌ World Pass background check failed:",
                error.message
            );
        });
    }, RESTOCK_CHECK_INTERVAL_MS);
}

// ==========================================
// STOP SCHEDULER
// ==========================================

function stopWorldPassPoolManager() {
    if (!restockInterval) {
        return;
    }

    clearInterval(restockInterval);

    restockInterval = null;

    console.log(
        "⏹️ World Pass background pool manager stopped."
    );
}

// ==========================================
// POOL STATUS
// ==========================================

async function getWorldPassPoolStatus() {
    const status = {};

    for (const tier of Object.keys(WORLD_PASS_CONFIG.CHALLENGES)) {
        const size = await getQuestionPoolSize(tier);

        status[tier] = {
            size,
            minimum: WORLD_PASS_CONFIG.POOL_SETTINGS.minimumSize,
            target: WORLD_PASS_CONFIG.POOL_SETTINGS.targetSize,
            low: size < WORLD_PASS_CONFIG.POOL_SETTINGS.minimumSize,
            restocking: activeRestocks.has(tier),
        };
    }

    return status;
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
    initializeWorldPassPools,
    startWorldPassPoolManager,
    stopWorldPassPoolManager,
    checkAllWorldPassPools,
    checkAndRestockTier,
    getWorldPassPoolStatus,
};
