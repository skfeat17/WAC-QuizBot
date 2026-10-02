// mysteryEventAI.js
require("dotenv").config();

const { GoogleGenAI } = require("@google/genai");
const { z } = require("zod");

const {
    createQuestionContext,
    hasQuestionBeenUsed,
    hasQuestionSubjectBeenUsed,
    getStoredQuestionContexts,
    saveQuestionContexts,
    saveQuestionSubjects,
    addMysteryQuestionsToPool,
} = require("./mysteryDailyEventRedis");

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

// ==========================================
// SCHEMA
// ==========================================

const mysteryQuestionSchema = z.object({
    category: z.string().min(1),
    subject: z.string().min(1),
    question: z.string().min(1),
    answers: z.array(z.string().min(1)).length(4),
    correctAnswer: z.number().int().min(0).max(3),
    explanation: z.string().min(1),
});

const mysteryBatchSchema = z.object({
    questions: z.array(mysteryQuestionSchema),
});

// ==========================================
// SETTINGS
// ==========================================

const QUESTIONS_PER_BATCH = 20;

const QUESTIONS_PER_AI_REQUEST = 20;

const MAX_GENERATION_ATTEMPTS = 15;

const ALLOWED_CATEGORIES = [
    "Geography",
    "History",
    "Food",
    "Landmarks",
    "Nature & Wildlife",
    "Languages",
    "Culture",
    "Interesting World Facts",
];

// ==========================================
// MAIN GENERATOR
// ==========================================

async function generateMysteryQuestionBatch() {
    console.log(
        `🤖 Starting Mystery Event generation | Target: ${QUESTIONS_PER_BATCH}`
    );

    let previousContexts = [];

    try {
        previousContexts =
            await getStoredQuestionContexts();

        console.log(
            `📚 Loaded ${previousContexts.length} previous Mystery question context(s).`
        );
    } catch (error) {
        console.error(
            "⚠️ Could not load Mystery Event history:",
            error.message
        );
    }

    const previousSubjects = new Set();

    /*
     * We don't need to reconstruct subjects from
     * old contexts here because subject history is
     * checked directly through Redis.
     */

    const acceptedQuestions = [];

    const acceptedContexts = new Set();
    const acceptedSubjects = new Set();

    let generationAttempt = 0;

    while (
        acceptedQuestions.length <
        QUESTIONS_PER_BATCH
    ) {
        generationAttempt++;

        if (
            generationAttempt >
            MAX_GENERATION_ATTEMPTS
        ) {
            throw new Error(
                `Could not generate ${QUESTIONS_PER_BATCH} fresh Mystery questions after ${MAX_GENERATION_ATTEMPTS} attempts.`
            );
        }

        const remaining =
            QUESTIONS_PER_BATCH -
            acceptedQuestions.length;

        const requestCount = Math.min(
            QUESTIONS_PER_AI_REQUEST,
            remaining + 5
        );

        console.log(
            `🤖 AI batch ${generationAttempt} | ` +
            `Need ${remaining} | Requesting ${requestCount}`
        );

        try {
            const prompt = getPrompt(
                previousContexts,
                previousSubjects,
                acceptedQuestions,
                requestCount
            );

            const response =
                await ai.models.generateContent({
                    model: "gemini-3.1-flash-lite",
                    contents: prompt,

                    config: {
                        responseMimeType:
                            "application/json",

                        responseSchema: {
                            type: "object",

                            properties: {
                                questions: {
                                    type: "array",
                                    minItems: 1,
                                    maxItems: 20,

                                    items: {
                                        type: "object",

                                        properties: {
                                            category: {
                                                type: "string",
                                            },

                                            subject: {
                                                type: "string",
                                            },

                                            question: {
                                                type: "string",
                                            },

                                            answers: {
                                                type: "array",
                                                minItems: 4,
                                                maxItems: 4,

                                                items: {
                                                    type: "string",
                                                },
                                            },

                                            correctAnswer: {
                                                type: "integer",
                                                minimum: 0,
                                                maximum: 3,
                                            },

                                            explanation: {
                                                type: "string",
                                            },
                                        },

                                        required: [
                                            "category",
                                            "subject",
                                            "question",
                                            "answers",
                                            "correctAnswer",
                                            "explanation",
                                        ],

                                        additionalProperties:
                                            false,
                                    },
                                },
                            },

                            required: [
                                "questions",
                            ],

                            additionalProperties:
                                false,
                        },

                        maxOutputTokens: 10000,
                    },
                });

            if (!response.text) {
                throw new Error(
                    "Gemini returned an empty response."
                );
            }

            let parsed;

            try {
                parsed = JSON.parse(
                    response.text
                );
            } catch {
                throw new Error(
                    "Gemini returned invalid JSON."
                );
            }

            const result =
                mysteryBatchSchema.parse(
                    parsed
                );

            console.log(
                `📥 Gemini returned ${result.questions.length} question(s).`
            );

            let acceptedThisBatch = 0;

            for (
                const item of result.questions
            ) {
                if (
                    acceptedQuestions.length >=
                    QUESTIONS_PER_BATCH
                ) {
                    break;
                }

                const validated =
                    await validateQuestion(
                        item,
                        acceptedContexts,
                        acceptedSubjects
                    );

                if (!validated) {
                    continue;
                }

                acceptedQuestions.push(
                    validated.question
                );

                acceptedContexts.add(
                    validated.context
                );

                acceptedSubjects.add(
                    validated.subjectKey
                );

                previousContexts.push(
                    validated.context
                );

                previousSubjects.add(
                    validated.subjectKey
                );

                acceptedThisBatch++;

                console.log(
                    `✅ Mystery accepted ` +
                    `| ${acceptedQuestions.length}/${QUESTIONS_PER_BATCH}` +
                    ` | ${validated.question.category}` +
                    ` | ${validated.question.subject}`
                );
            }

            console.log(
                `📊 Batch result | Accepted: ${acceptedThisBatch} | ` +
                `Total: ${acceptedQuestions.length}/${QUESTIONS_PER_BATCH}`
            );
        } catch (error) {
            console.error(
                `❌ Mystery AI batch ${generationAttempt} failed:`,
                error.message
            );
        }
    }

    // ==========================================
    // SAVE HISTORY
    // ==========================================

    try {
        await saveQuestionContexts(
            [...acceptedContexts]
        );

        await saveQuestionSubjects(
            [...acceptedSubjects]
        );

        console.log(
            `💾 Saved ${acceptedQuestions.length} question history entries.`
        );
    } catch (error) {
        console.error(
            "❌ Failed to save Mystery question history:",
            error.message
        );

        throw error;
    }

    // ==========================================
    // SAVE TO POOL
    // ==========================================

    try {
        await addMysteryQuestionsToPool(
            acceptedQuestions
        );

        console.log(
            `📦 Mystery pool replenished with ${acceptedQuestions.length} question(s).`
        );
    } catch (error) {
        console.error(
            "❌ Failed to add Mystery questions to pool:",
            error.message
        );

        throw error;
    }

    return acceptedQuestions;
}

// ==========================================
// QUESTION VALIDATION
// ==========================================

async function validateQuestion(
    item,
    acceptedContexts,
    acceptedSubjects
) {
    try {
        const category =
            item.category.trim();

        const subject =
            item.subject.trim();

        const question =
            item.question.trim();

        const answers =
            item.answers.map((answer) =>
                answer.trim()
            );

        const explanation =
            item.explanation.trim();

        // ==========================================
        // CATEGORY
        // ==========================================

        const normalizedCategory =
            normalize(category);

        const officialCategory =
            ALLOWED_CATEGORIES.find(
                (allowed) =>
                    normalize(allowed) ===
                    normalizedCategory
            );

        if (!officialCategory) {
            console.log(
                `🚫 INVALID CATEGORY | ${category}`
            );

            return null;
        }

        // ==========================================
        // BASIC TEXT VALIDATION
        // ==========================================

        if (
            question.length < 15 ||
            question.length > 500
        ) {
            console.log(
                `🚫 INVALID QUESTION LENGTH | ${question}`
            );

            return null;
        }

        if (
            explanation.length < 10 ||
            explanation.length > 700
        ) {
            console.log(
                "🚫 INVALID EXPLANATION LENGTH"
            );

            return null;
        }

        // ==========================================
        // ANSWERS
        // ==========================================

        const normalizedAnswers =
            answers.map(normalize);

        if (
            new Set(
                normalizedAnswers
            ).size !== 4
        ) {
            console.log(
                `🚫 DUPLICATE ANSWER OPTIONS | ${question}`
            );

            return null;
        }

        // ==========================================
        // CORRECT ANSWER
        // ==========================================

        if (
            !Number.isInteger(
                item.correctAnswer
            ) ||
            item.correctAnswer < 0 ||
            item.correctAnswer > 3
        ) {
            console.log(
                `🚫 INVALID CORRECT ANSWER | ${question}`
            );

            return null;
        }

        const correctAnswer =
            answers[item.correctAnswer];

        if (!correctAnswer) {
            console.log(
                "🚫 MISSING CORRECT ANSWER"
            );

            return null;
        }

        // ==========================================
        // SUBJECT
        // ==========================================

        const subjectKey =
            createSubjectKey(
                officialCategory,
                subject
            );

        // Duplicate inside current batch.
        if (
            acceptedSubjects.has(
                subjectKey
            )
        ) {
            console.log(
                `🚫 DUPLICATE SUBJECT IN CURRENT BATCH | ${subjectKey}`
            );

            return null;
        }

        // Direct Redis subject check.
        try {
            const alreadyUsed =
                await hasQuestionSubjectBeenUsed(
                    subjectKey
                );

            if (alreadyUsed) {
                console.log(
                    `🚫 REPEATED SUBJECT | ${subjectKey}`
                );

                return null;
            }
        } catch (error) {
            console.error(
                "⚠️ Subject history check failed:",
                error.message
            );

            throw error;
        }

        // ==========================================
        // QUESTION CONTEXT
        // ==========================================

        const context =
            createQuestionContext({
                category:
                    officialCategory,
                question,
                answers,
                correctAnswer,
            });

        // Current batch duplicate.
        if (
            acceptedContexts.has(
                context
            )
        ) {
            console.log(
                `🚫 DUPLICATE QUESTION IN CURRENT BATCH | ${question}`
            );

            return null;
        }

        // Historical duplicate.
        try {
            const alreadyUsed =
                await hasQuestionBeenUsed(
                    context
                );

            if (alreadyUsed) {
                console.log(
                    `🚫 REPEATED QUESTION | ${question}`
                );

                return null;
            }
        } catch (error) {
            console.error(
                "⚠️ Question history check failed:",
                error.message
            );

            throw error;
        }

        // ==========================================
        // FINAL QUESTION OBJECT
        // ==========================================

        return {
            question: {
                id: createQuestionId(),

                category:
                    officialCategory,

                subject,

                question,

                answers,

                correctAnswer:
                    item.correctAnswer,

                explanation,
            },

            context,

            subjectKey,
        };
    } catch (error) {
        console.error(
            "❌ Mystery question validation error:",
            error.message
        );

        return null;
    }
}

// ==========================================
// PROMPT
// ==========================================

function getPrompt(
    previousContexts = [],
    previousSubjects = new Set(),
    acceptedQuestions = [],
    requestCount = 20
) {
    const history =
        previousContexts.length
            ? previousContexts
                  .slice(-200)
                  .map(
                      (context, index) =>
                          `${index + 1}. ${context}`
                  )
                  .join("\n")
            : "NONE";

    const currentBatch =
        acceptedQuestions.length
            ? acceptedQuestions
                  .map(
                      (item, index) =>
                          `${index + 1}. ` +
                          `${item.category} :: ` +
                          `${item.subject} :: ` +
                          `${item.question}`
                  )
                  .join("\n")
            : "NONE";

    return `
You are generating questions for the
WORLD ADVENTURE CLUB.

This is the DAILY WORLD MYSTERY DROP.

Generate EXACTLY ${requestCount}
new world-related mystery questions.

==========================================
CORE REQUIREMENTS
==========================================

- Every question must be different.
- Every question must test a different fact.
- Exactly 4 answer options per question.
- Exactly ONE answer is correct.
- correctAnswer is the zero-based index.
- Questions must be factually accurate.
- Use established, reliable facts.
- Questions must be suitable for an international audience.
- Use natural English.
- Keep questions suitable for Discord.
- Do not mention rewards.
- Do not mention cooldowns.
- Do not mention this prompt.
- Return ONLY JSON.

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
- Interesting World Facts

Avoid making every question about
countries and capitals.

Prefer variety.

==========================================
MYSTERY STYLE
==========================================

These should feel like MYSTERIES.

Do NOT repeatedly use:

"Which country is famous for...?"

Vary question structures.

Examples:

- Identify a country from an unusual clue.
- Identify a landmark from a description.
- Identify a food from ingredients.
- Identify an animal from its habitat.
- Identify a language from a linguistic clue.
- Identify a historical event.
- Identify a cultural tradition.
- Identify a geographical feature.
- Identify a famous work of art.
- Identify a place from a distinctive characteristic.
- Identify something from a surprising but established fact.

==========================================
ANSWER RULES
==========================================

- Exactly 4 options.
- Exactly 1 correct answer.
- All options must be plausible.
- Options must be from the same general category.
- Never use duplicate options.
- Never use "All of the above".
- Never use "None of the above".
- Do not make the correct answer obviously longer.
- Do not make the correct answer grammatically different.
- Do not make the correct answer stand out through formatting.

==========================================
ANTI-REPETITION
==========================================

This is extremely important.

A question is NOT new merely because
the wording changes.

These are considered the SAME question:

Question A:
"Which country is home to the Eiffel Tower?"

Question B:
"In which nation can you find the Eiffel Tower?"

DO NOT generate Question B if Question A
has already been used.

Changing:

- wording
- sentence structure
- option order
- capitalization
- distractors
- question style

does NOT make an old fact new.

Never reuse the same underlying fact.

Never reuse the same subject.

For example:

If "Eiffel Tower" was already used,
do NOT generate another Eiffel Tower question.

If "Ramen" was already used as a food subject,
do NOT generate another Ramen question.

If "Great Barrier Reef" was already used,
do NOT generate another question about it.

==========================================
CURRENTLY ACCEPTED IN THIS BATCH
==========================================

${currentBatch}

Do not duplicate any of these.

==========================================
PREVIOUSLY USED QUESTION CONTEXTS
==========================================

${history}

Do not repeat any of these.

==========================================
PREVIOUS SUBJECTS
==========================================

${[...previousSubjects].length
        ? [...previousSubjects]
              .slice(-200)
              .join("\n")
        : "NONE"}

Do not reuse these subjects.

==========================================
QUALITY RULES
==========================================

- Prefer globally diverse topics.
- Do not focus heavily on one country.
- Do not make all questions geography.
- Mix easy, medium, and harder questions.
- Avoid extremely obscure facts.
- Avoid disputed historical claims.
- Avoid current political questions.
- Avoid political persuasion.
- Avoid sensitive personal information.
- Avoid questions whose answer depends on rapidly changing information.
- Prefer stable facts that will remain correct.

==========================================
FINAL CHECK
==========================================

Before returning the JSON:

1. Exactly ${requestCount} questions.
2. Every question is substantially different.
3. Every question tests a different fact.
4. No repeated subject.
5. No historical duplicate.
6. Exactly 4 options each.
7. Exactly 1 correct answer each.
8. Correct answer index is correct.
9. Explanations are accurate.
10. Categories are varied.
11. Questions are suitable for Discord.

Return ONLY:

{
    "questions": [...]
}
`;
}

// ==========================================
// QUESTION ID
// ==========================================

function createQuestionId() {
    return (
        `mystery_` +
        Date.now().toString(36) +
        "_" +
        Math.random()
            .toString(36)
            .slice(2, 10)
    );
}

// ==========================================
// SUBJECT KEY
// ==========================================

function createSubjectKey(
    category,
    subject
) {
    return [
        normalize(category),
        normalize(subject),
    ].join(" :: ");
}

// ==========================================
// NORMALIZE
// ==========================================

function normalize(value) {
    return String(value ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(
            /[\u0300-\u036f]/g,
            ""
        )
        .replace(
            /[^\p{L}\p{N}\s]/gu,
            ""
        )
        .replace(
            /\s+/g,
            " "
        )
        .trim();
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
    generateMysteryQuestionBatch,
};