
// src/services/worldPass/worldPassAI.js

require("dotenv").config();

const crypto = require("node:crypto");

const { GoogleGenAI } = require("@google/genai");
const { z } = require("zod");

const {
    WORLD_PASS_CONFIG,
} = require("./worldPassConfig");

const {
    getQuestionPoolSize,
    getUsedQuestionIds,
    saveUsedQuestionId,
    addQuestionsToPool,
} = require("./worldPassRedis");

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

// ==========================================
// AI MODELS
// ==========================================

const PRIMARY_MODEL = "gemini-3.1-flash-lite";
const FALLBACK_MODEL = "gemini-3.5-flash-lite";

// ==========================================
// GENERATION SETTINGS
// ==========================================

const QUESTIONS_PER_AI_REQUEST = 20;
const MAX_GENERATION_ATTEMPTS = 10;

// ==========================================
// QUESTION SCHEMA
// ==========================================

const worldPassQuestionSchema = z.object({
    category: z.string().min(1),
    subject: z.string().min(1),
    question: z.string().min(1),
    options: z.array(z.string().min(1)).length(4),
    answer: z.string().min(1),
    explanation: z.string().min(1),
});

const worldPassBatchSchema = z.object({
    questions: z.array(worldPassQuestionSchema),
});

// ==========================================
// CATEGORIES
// ==========================================

const ALLOWED_CATEGORIES = [
    "Geography",
    "History",
    "Food",
    "Landmarks",
    "Nature & Wildlife",
    "Languages",
    "Culture",
    "World Sports",
];

// ==========================================
// TIER DIFFICULTY
// ==========================================

const TIER_DIFFICULTY = {
    explorer: {
        label: "EASY",
        description: `
Very easy questions.
Use famous landmarks, popular foods,
well-known countries, basic geography,
famous animals and recognizable traditions.
A general audience should know most answers.
`,
    },

    voyager: {
        label: "EASY TO MEDIUM",
        description: `
Easy to moderately challenging questions.
Use recognizable historical events,
regional foods, famous cultural traditions,
important cities and geographical features.
Avoid obscure facts.
`,
    },

    pathfinder: {
        label: "MEDIUM",
        description: `
Moderately challenging questions.
Test meaningful knowledge of world geography,
history, culture, nature, languages and landmarks.
Avoid facts that require specialist knowledge.
`,
    },

    discoverer: {
        label: "HARD",
        description: `
Challenging questions for knowledgeable players.
Use less obvious historical facts,
regional cultural knowledge, geographical details,
and important world heritage locations.
Avoid ambiguous or disputed facts.
`,
    },

    celestial: {
        label: "VERY HARD",
        description: `
Very challenging questions.
Test detailed knowledge of world history,
geography, civilizations, cultural heritage,
languages, nature and international traditions.
Questions should require genuine knowledge,
not guesswork or misleading wording.
Use reliable, established facts only.
`,
    },
};

// ==========================================
// NORMALIZE
// ==========================================

function normalize(value) {
    return String(value ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
}

// ==========================================
// QUESTION ID
// ==========================================

function createQuestionId(tier, subject) {
    const normalizedSubject = normalize(subject);

    const hash = crypto
        .createHash("sha256")
        .update(`${tier}::${normalizedSubject}`)
        .digest("hex")
        .slice(0, 24);

    return `worldpass_${tier}_${hash}`;
}

// ==========================================
// AI ERROR DETECTION
// ==========================================

function isModelBusyError(error) {
    const message = String(
        error?.message ||
        error?.status ||
        error?.code ||
        error?.response?.data ||
        ""
    ).toLowerCase();

    const status = Number(
        error?.status ||
        error?.code ||
        error?.response?.status
    );

    return (
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        message.includes("429") ||
        message.includes("rate limit") ||
        message.includes("quota") ||
        message.includes("resource exhausted") ||
        message.includes("overloaded") ||
        message.includes("unavailable") ||
        message.includes("timeout") ||
        message.includes("timed out") ||
        message.includes("too many requests")
    );
}

// ==========================================
// GEMINI RESPONSE SCHEMA
// ==========================================

const geminiResponseSchema = {
    type: "OBJECT",

    properties: {
        questions: {
            type: "ARRAY",

            items: {
                type: "OBJECT",

                properties: {
                    category: {
                        type: "STRING",
                    },

                    subject: {
                        type: "STRING",
                    },

                    question: {
                        type: "STRING",
                    },

                    options: {
                        type: "ARRAY",
                        items: {
                            type: "STRING",
                        },
                    },

                    answer: {
                        type: "STRING",
                    },

                    explanation: {
                        type: "STRING",
                    },
                },

                required: [
                    "category",
                    "subject",
                    "question",
                    "options",
                    "answer",
                    "explanation",
                ],

                propertyOrdering: [
                    "category",
                    "subject",
                    "question",
                    "options",
                    "answer",
                    "explanation",
                ],
            },
        },
    },

    required: ["questions"],

    propertyOrdering: ["questions"],
};

// ==========================================
// TWO-MODEL GENERATOR
// ==========================================

async function generateWithFallback(prompt) {
    // ==========================================
    // PRIMARY MODEL
    // ==========================================

    try {
        console.log(
            `🤖 World Pass AI | Trying ${PRIMARY_MODEL}`
        );

        const response = await ai.models.generateContent({
            model: PRIMARY_MODEL,

            contents: prompt,

            config: {
                responseMimeType: "application/json",
                responseSchema: geminiResponseSchema,
                maxOutputTokens: 10000,
            },
        });

        if (!response?.text) {
            throw new Error(
                `${PRIMARY_MODEL} returned an empty response.`
            );
        }

        console.log(
            `✅ World Pass AI | ${PRIMARY_MODEL} responded`
        );

        return response;

    } catch (error) {
        console.warn(
            `⚠️ World Pass AI | ${PRIMARY_MODEL} failed:`,
            error.message
        );

        if (!isModelBusyError(error)) {
            throw error;
        }
    }

    // ==========================================
    // FALLBACK MODEL
    // ==========================================

    console.warn(
        `🔄 World Pass AI | Switching to ${FALLBACK_MODEL}`
    );

    const response = await ai.models.generateContent({
        model: FALLBACK_MODEL,

        contents: prompt,

        config: {
            responseMimeType: "application/json",
            responseSchema: geminiResponseSchema,
            maxOutputTokens: 10000,
        },
    });

    if (!response?.text) {
        throw new Error(
            `${FALLBACK_MODEL} returned an empty response.`
        );
    }

    console.log(
        `✅ World Pass AI | ${FALLBACK_MODEL} responded`
    );

    return response;
}

// ==========================================
// QUESTION VALIDATION
// ==========================================

function validateQuestion(item, tier, currentSubjects, usedIds) {
    try {
        const category = item.category.trim();
        const subject = item.subject.trim();
        const question = item.question.trim();

        const options = item.options.map(
            option => option.trim()
        );

        const answer = item.answer.trim();
        const explanation = item.explanation.trim();

        // ==========================================
        // CATEGORY
        // ==========================================

        const officialCategory = ALLOWED_CATEGORIES.find(
            allowed => normalize(allowed) === normalize(category)
        );

        if (!officialCategory) {
            return reject("INVALID CATEGORY", question);
        }

        // ==========================================
        // TEXT LENGTH
        // ==========================================

        if (
            subject.length < 2 ||
            subject.length > 100 ||
            question.length < 15 ||
            question.length > 500 ||
            explanation.length < 10 ||
            explanation.length > 700
        ) {
            return reject("INVALID TEXT LENGTH", question);
        }

        // ==========================================
        // OPTIONS
        // ==========================================

        if (options.length !== 4) {
            return reject("INVALID OPTION COUNT", question);
        }

        const normalizedOptions = options.map(normalize);

        if (
            normalizedOptions.some(option => !option) ||
            options.some(option => option.length > 80) ||
            new Set(normalizedOptions).size !== 4
        ) {
            return reject("DUPLICATE OR EMPTY OPTIONS", question);
        }

        // ==========================================
        // CORRECT ANSWER
        // ==========================================

        const correctAnswer = options.find(
            option => normalize(option) === normalize(answer)
        );

        if (!correctAnswer) {
            return reject("ANSWER NOT IN OPTIONS", question);
        }

        // ==========================================
        // SUBJECT DUPLICATES
        // ==========================================

        const subjectKey = normalize(subject);

        if (currentSubjects.has(subjectKey)) {
            return reject("DUPLICATE SUBJECT IN BATCH", subject);
        }

        // ==========================================
        // STABLE QUESTION ID
        // ==========================================

        const id = createQuestionId(tier, subject);

        if (usedIds.has(id)) {
            return reject("PREVIOUSLY USED SUBJECT", subject);
        }

        // ==========================================
        // FINAL QUESTION
        // ==========================================

        return {
            id,
            tier,
            category: officialCategory,
            subject,
            question,
            options,
            answer: correctAnswer,
            explanation,
        };

    } catch (error) {
        console.error(
            "❌ World Pass validation error:",
            error.message
        );

        return null;
    }
}

function reject(reason, value) {
    console.log(
        `🚫 World Pass rejected | ${reason} | ${value}`
    );

    return null;
}

// ==========================================
// PROMPT
// ==========================================

function getPrompt(tier, requestCount, previousSubjects = []) {
    const difficulty = TIER_DIFFICULTY[tier];

    return `
You are generating questions for the
WORLD ADVENTURE CLUB.

This is the WORLD PASS CHALLENGE.

Generate EXACTLY ${requestCount} questions.

==========================================
CHALLENGE TIER
==========================================

Tier: ${tier.toUpperCase()}

Difficulty: ${difficulty.label}

${difficulty.description}

IMPORTANT:
Every question must match this tier's difficulty.
Do not generate easy questions for higher tiers.
Do not generate specialist-level questions for Explorer.

==========================================
QUESTION REQUIREMENTS
==========================================

- Generate original world-related trivia.
- Every question must test a distinct fact.
- Use established, reliable facts.
- Use natural English.
- Questions must be suitable for Discord.
- Exactly four answer options.
- Exactly one correct answer.
- The answer must exactly match one option.
- All four options must be plausible.
- Never use "All of the above".
- Never use "None of the above".
- Never make the correct answer obvious through wording.
- Avoid ambiguous questions.
- Avoid disputed historical claims.
- Avoid rapidly changing information.
- Avoid current political questions.
- Do not mention rewards, passes, or cooldowns.
- Return ONLY valid JSON.

==========================================
CATEGORIES
==========================================

Use a mixture of:

- Geography
- History
- Food
- Landmarks
- Nature & Wildlife
- Languages
- Culture
- World Sports

Do not make every question about capitals.
Do not make every question about countries.
Use a good variety of world topics.

==========================================
ANTI-REPETITION
==========================================

Every question must test a different subject.

Changing the wording of an old question
does NOT make it a new question.

Do not repeat any of these subjects:

${previousSubjects.length
    ? previousSubjects.map((subject, index) =>
        `${index + 1}. ${subject}`
    ).join("\n")
    : "NONE"
}

Also avoid generating multiple questions
about the same landmark, dish, historical event,
animal, person, geographical feature or tradition.

==========================================
ANSWER QUALITY
==========================================

- All options must belong to the same general category.
- Avoid joke answers.
- Avoid obviously incorrect options.
- Avoid duplicate options.
- Keep option lengths reasonably balanced.
- Do not reveal the answer in the explanation's wording
  before the player has answered.
- Explanations must be factually accurate.
- Explanations should briefly teach something useful.

==========================================
FINAL CHECK
==========================================

Before returning:

1. Exactly ${requestCount} questions.
2. Every question matches ${tier.toUpperCase()} difficulty.
3. No repeated subjects.
4. No duplicate questions.
5. Exactly four options per question.
6. Exactly one correct answer.
7. Answer matches one option exactly.
8. Explanations are accurate.
9. Questions are clear and unambiguous.
10. Topics are varied.

Return this JSON structure:

{
    "questions": [
        {
            "category": "Geography",
            "subject": "Example subject",
            "question": "Example question?",
            "options": [
                "Option A",
                "Option B",
                "Option C",
                "Option D"
            ],
            "answer": "Option B",
            "explanation": "A short factual explanation."
        }
    ]
}
`;
}

// ==========================================
// GENERATE QUESTIONS FOR ONE TIER
// ==========================================

async function generateWorldPassQuestionBatch(tier, requestedCount = 20) {
    if (!WORLD_PASS_CONFIG.CHALLENGES[tier]) {
        throw new Error(`Invalid World Pass tier: ${tier}`);
    }

    if (
        !Number.isInteger(requestedCount) ||
        requestedCount < 1 ||
        requestedCount > 20
    ) {
        throw new Error("requestedCount must be between 1 and 20.");
    }

    console.log(
        `🤖 World Pass generation started | Tier: ${tier} | Target: ${requestedCount}`
    );

    const acceptedQuestions = [];
    const acceptedSubjects = new Set();

    const usedIds = new Set(
        await getUsedQuestionIds(tier)
    );

    let attempts = 0;

    while (acceptedQuestions.length < requestedCount) {
        attempts++;

        if (attempts > MAX_GENERATION_ATTEMPTS) {
            throw new Error(
                `World Pass ${tier}: generation stopped after ${MAX_GENERATION_ATTEMPTS} attempts. ` +
                `${acceptedQuestions.length}/${requestedCount} questions saved.`
            );
        }

        const remaining = requestedCount - acceptedQuestions.length;

        const requestCount = Math.min(
            QUESTIONS_PER_AI_REQUEST,
            remaining
        );

        console.log(
            `🤖 World Pass AI batch ${attempts} | ` +
            `Tier: ${tier} | Need: ${remaining} | Requesting: ${requestCount}`
        );

        try {
            const prompt = getPrompt(
                tier,
                requestCount,
                [...acceptedSubjects]
            );

            const response = await generateWithFallback(prompt);

            let parsed;

            try {
                parsed = JSON.parse(response.text);
            } catch {
                throw new Error("Gemini returned invalid JSON.");
            }

            const result = worldPassBatchSchema.parse(parsed);

            console.log(
                `📥 World Pass AI returned ${result.questions.length} question(s).`
            );

            const batchQuestions = [];

            for (const item of result.questions) {
                if (acceptedQuestions.length >= requestedCount) {
                    break;
                }

                const question = validateQuestion(
                    item,
                    tier,
                    acceptedSubjects,
                    usedIds
                );

                if (!question) {
                    continue;
                }

                batchQuestions.push(question);
                acceptedSubjects.add(normalize(question.subject));
                usedIds.add(question.id);
            }

            if (batchQuestions.length) {
                try {
                    await addQuestionsToPool(tier, batchQuestions);

                    for (const question of batchQuestions) {
                        await saveUsedQuestionId(tier, question.id);
                        acceptedQuestions.push(question);
                    }

                    console.log(
                        `💾 World Pass saved | Tier: ${tier} | ` +
                        `${acceptedQuestions.length}/${requestedCount}`
                    );

                } catch (saveError) {
                    console.error(
                        `❌ World Pass save failed | ${tier}:`,
                        saveError.message
                    );

                    throw saveError;
                }
            }

            console.log(
                `📊 World Pass batch complete | ` +
                `Accepted: ${batchQuestions.length} | ` +
                `Total: ${acceptedQuestions.length}/${requestedCount}`
            );

        } catch (error) {
            console.error(
                `❌ World Pass AI batch ${attempts} failed | ${tier}:`,
                error.message
            );
        }
    }

    console.log(
        `🎉 World Pass generation completed | ${tier} | ` +
        `${acceptedQuestions.length} questions saved.`
    );

    return acceptedQuestions;
}

// ==========================================
// RESTOCK ONE TIER
// ==========================================

async function restockWorldPassTier(tier) {
    if (!WORLD_PASS_CONFIG.CHALLENGES[tier]) {
        throw new Error(`Invalid World Pass tier: ${tier}`);
    }

    const settings = WORLD_PASS_CONFIG.POOL_SETTINGS;

    const currentSize = await getQuestionPoolSize(tier);

    if (currentSize >= settings.targetSize) {
        console.log(
            `📦 World Pass ${tier} pool already healthy | ${currentSize}`
        );

        return {
            tier,
            before: currentSize,
            generated: 0,
            after: currentSize,
        };
    }

    const needed = settings.targetSize - currentSize;

    console.log(
        `📦 World Pass restock | ${tier} | ` +
        `Current: ${currentSize} | Target: ${settings.targetSize}`
    );

    let generated = 0;

    while (generated < needed) {
        const remaining = needed - generated;

        const batchSize = Math.min(
            QUESTIONS_PER_AI_REQUEST,
            remaining
        );

        const questions = await generateWorldPassQuestionBatch(
            tier,
            batchSize
        );

        generated += questions.length;
    }

    const after = await getQuestionPoolSize(tier);

    return {
        tier,
        before: currentSize,
        generated,
        after,
    };
}

// ==========================================
// RESTOCK ALL TIERS
// ==========================================

async function restockAllWorldPassTiers() {
    const results = [];

    for (const tier of Object.keys(WORLD_PASS_CONFIG.CHALLENGES)) {
        try {
            const result = await restockWorldPassTier(tier);
            results.push(result);

        } catch (error) {
            console.error(
                `❌ World Pass restock failed | ${tier}:`,
                error.message
            );

            results.push({
                tier,
                error: error.message,
            });
        }
    }

    return results;
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
    generateWorldPassQuestionBatch,
    restockWorldPassTier,
    restockAllWorldPassTiers,
};
