// src/services/ai.js

require("dotenv").config();

const { GoogleGenAI } = require("@google/genai");
const { z } = require("zod");

const {
    addQuestion,
    getQuestion,
    getPoolSize,
    startBackgroundRefill,
    TOPICS,
    DIFFICULTIES,
} = require("./questionManager");


/*
|--------------------------------------------------------------------------
| Settings
|--------------------------------------------------------------------------
*/

const BATCH_SIZE = 50;
const MAX_OUTPUT_TOKENS = 12000;


/*
|--------------------------------------------------------------------------
| Gemini
|--------------------------------------------------------------------------
*/

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});


/*
|--------------------------------------------------------------------------
| Question schema
|--------------------------------------------------------------------------
*/

const questionSchema = z.object({

    question: z
        .string()
        .min(1),

    factKey: z
        .string()
        .min(1),

    options: z
        .array(
            z.string().min(1)
        )
        .length(4),

    correctAnswer: z
        .number()
        .int()
        .min(0)
        .max(3),

    explanation: z
        .string()
        .min(1),
});


/*
|--------------------------------------------------------------------------
| Normalize text
|--------------------------------------------------------------------------
*/

function normalizeText(value) {

    return String(value)
        .toLowerCase()
        .trim()
        .replace(/\s+/g, " ");
}


/*
|--------------------------------------------------------------------------
| Normalize fact key
|--------------------------------------------------------------------------
*/

function normalizeFactKey(value) {

    return String(value)
        .toLowerCase()
        .trim()
        .replace(/\s+/g, "_");
}


/*
|--------------------------------------------------------------------------
| Validate question
|--------------------------------------------------------------------------
*/

function validateQuestion(question) {

    if (
        !question ||
        !question.question ||
        !question.question.trim()
    ) {
        throw new Error(
            "Question text cannot be empty."
        );
    }

    if (
        !question.factKey ||
        !question.factKey.trim()
    ) {
        throw new Error(
            "factKey cannot be empty."
        );
    }

    if (
        !Array.isArray(question.options) ||
        question.options.length !== 4
    ) {
        throw new Error(
            `Question "${question.question}" does not have exactly 4 options.`
        );
    }

    if (
        question.correctAnswer < 0 ||
        question.correctAnswer > 3
    ) {
        throw new Error(
            `Invalid correctAnswer for "${question.question}".`
        );
    }

    const normalizedOptions =
        question.options.map(
            normalizeText
        );

    const uniqueOptions =
        new Set(normalizedOptions);

    if (
        uniqueOptions.size !== 4
    ) {
        throw new Error(
            `Duplicate options found in "${question.question}".`
        );
    }

    if (
        !question.explanation ||
        question.explanation.length > 500
    ) {
        throw new Error(
            `Explanation is invalid for "${question.question}".`
        );
    }
}


/*
|--------------------------------------------------------------------------
| Gemini response schema
|--------------------------------------------------------------------------
*/

function createResponseSchema(target) {

    return {
        type: "object",

        properties: {

            questions: {

                type: "array",

                items: {

                    type: "object",

                    properties: {

                        question: {
                            type: "string",
                        },

                        factKey: {
                            type: "string",
                        },

                        options: {

                            type: "array",

                            items: {
                                type: "string",
                            },
                        },

                        correctAnswer: {
                            type: "integer",
                        },

                        explanation: {
                            type: "string",
                        },
                    },

                    required: [
                        "question",
                        "factKey",
                        "options",
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
    };
}


/*
|--------------------------------------------------------------------------
| Generate questions from Gemini
|--------------------------------------------------------------------------
|
| target = 1
|     → used when Redis is empty
|     → get ONE question as quickly as possible
|
| target = 50
|     → used for background refill
|
|--------------------------------------------------------------------------
*/

async function generateQuestionBatch(
    region,
    topic,
    difficulty,
    options = {}
) {

    const target =
        options.target || BATCH_SIZE;


    console.log(
        `🤖 Generating ${target} questions: ${region} / ${topic} / ${difficulty}`
    );


    /*
    |--------------------------------------------------------------------------
    | Prompt
    |--------------------------------------------------------------------------
    */

    const prompt = `
Generate exactly ${target} unique world-trivia multiple-choice question${target === 1 ? "" : "s"}.

Region: ${region}
Topic: ${topic}
Difficulty: ${difficulty}

RULES:

- Generate exactly ${target} question${target === 1 ? "" : "s"}.
- Every question must have exactly 4 plausible options.
- Exactly 1 option must be correct.
- correctAnswer must be the zero-based index of the correct option.
- Questions must be objectively verifiable.
- Do not generate political or controversial questions.
- Do not repeat the same fact.
- Do not repeat questions.
- Do not create multiple questions about the same underlying fact.
- Keep questions concise and clear.
- Explanation must be 25 words or fewer.
- Explanation must be 500 characters or fewer.
- Stay strictly within the requested region.
- Stay strictly within the requested topic.
- Stay strictly within the requested difficulty.
- Each factKey must identify the unique underlying fact.
- factKey must use lowercase_snake_case.
- Avoid uncertain, disputed, or misleading facts.
- Avoid trick questions.
- Avoid questions where multiple options could reasonably be correct.
- Do not reuse the same wording across questions.
- Do not add numbering such as "1.", "2.", etc. to the question text.

Return ONLY the JSON object matching the provided schema.
`;


    try {

        /*
        |--------------------------------------------------------------------------
        | Gemini
        |--------------------------------------------------------------------------
        */

        const response =
            await ai.models.generateContent({

                model:
                    "gemini-3.1-flash-lite",

                contents:
                    prompt,

                config: {

                    responseMimeType:
                        "application/json",

                    responseSchema:
                        createResponseSchema(
                            target
                        ),

                    maxOutputTokens:
                        target === 1
                            ? 1500
                            : MAX_OUTPUT_TOKENS,
                },
            });


        /*
        |--------------------------------------------------------------------------
        | Check response
        |--------------------------------------------------------------------------
        */

        if (
            !response ||
            !response.text
        ) {

            throw new Error(
                "Gemini returned an empty response."
            );
        }


        /*
        |--------------------------------------------------------------------------
        | Parse JSON
        |--------------------------------------------------------------------------
        */

        let parsed;

        try {

            parsed =
                JSON.parse(
                    response.text
                );

        } catch (error) {

            console.error(
                "❌ Gemini raw response:",
                response.text
            );

            throw new Error(
                "Gemini returned invalid JSON."
            );
        }


        /*
        |--------------------------------------------------------------------------
        | Check questions array
        |--------------------------------------------------------------------------
        */

        if (
            !parsed ||
            !Array.isArray(parsed.questions)
        ) {

            throw new Error(
                "Gemini response does not contain a valid questions array."
            );
        }


        /*
        |--------------------------------------------------------------------------
        | Process individually
        |--------------------------------------------------------------------------
        */

        const seenQuestions =
            new Set();

        const seenFacts =
            new Set();

        let saved = 0;


        for (
            const question
            of parsed.questions
        ) {

            /*
            |--------------------------------------------------------------------------
            | Stop after requested amount
            |--------------------------------------------------------------------------
            */

            if (
                saved >= target
            ) {
                break;
            }


            /*
            |--------------------------------------------------------------------------
            | Zod validation
            |--------------------------------------------------------------------------
            */

            const result =
                questionSchema.safeParse(
                    question
                );

            if (
                !result.success
            ) {

                console.warn(
                    "⚠️ Invalid generated question skipped:",
                    result.error.issues
                );

                continue;
            }


            const validQuestion =
                result.data;


            /*
            |--------------------------------------------------------------------------
            | Application validation
            |--------------------------------------------------------------------------
            */

            try {

                validateQuestion(
                    validQuestion
                );

            } catch (error) {

                console.warn(
                    `⚠️ Invalid generated question skipped: ${error.message}`
                );

                continue;
            }


            /*
            |--------------------------------------------------------------------------
            | Duplicate protection inside this generation
            |--------------------------------------------------------------------------
            */

            const normalizedQuestion =
                normalizeText(
                    validQuestion.question
                );

            const normalizedFact =
                normalizeFactKey(
                    validQuestion.factKey
                );


            if (
                seenQuestions.has(
                    normalizedQuestion
                )
            ) {

                console.warn(
                    `⚠️ Duplicate question skipped: ${validQuestion.question}`
                );

                continue;
            }


            if (
                seenFacts.has(
                    normalizedFact
                )
            ) {

                console.warn(
                    `⚠️ Duplicate fact skipped: ${validQuestion.factKey}`
                );

                continue;
            }


            seenQuestions.add(
                normalizedQuestion
            );

            seenFacts.add(
                normalizedFact
            );


            /*
            |--------------------------------------------------------------------------
            | Save immediately
            |--------------------------------------------------------------------------
            */

            const added =
                await addQuestion({

                    question:
                        validQuestion.question,

                    factKey:
                        validQuestion.factKey,

                    options:
                        validQuestion.options,

                    correctAnswer:
                        validQuestion.correctAnswer,

                    explanation:
                        validQuestion.explanation,

                    region,

                    topic,

                    difficulty,
                });


            if (!added) {
                continue;
            }


            saved++;


            /*
            |--------------------------------------------------------------------------
            | Immediately notify caller
            |--------------------------------------------------------------------------
            */

            if (
                typeof options.onQuestion ===
                "function"
            ) {

                try {

                    await options.onQuestion(
                        validQuestion
                    );

                } catch (error) {

                    console.error(
                        "⚠️ onQuestion callback failed:",
                        error.message
                    );
                }
            }
        }


        console.log(
            `✅ ${saved}/${target} new questions saved to Redis`
        );


        return saved;

    } catch (error) {

        console.error(
            "❌ Question generation failed:",
            error.message
        );

        /*
        |--------------------------------------------------------------------------
        | IMPORTANT
        |--------------------------------------------------------------------------
        |
        | Anything already saved stays in Redis.
        |
        |--------------------------------------------------------------------------
        */

        throw error;
    }
}


/*
|--------------------------------------------------------------------------
| Pick a concrete pool for mixed requests
|--------------------------------------------------------------------------
*/

function resolveGenerationPool(
    topic,
    difficulty
) {

    const selectedTopic =
        topic === "mixed"
            ? TOPICS[
                Math.floor(
                    Math.random() *
                    TOPICS.length
                )
            ]
            : topic;

    const selectedDifficulty =
        difficulty === "mixed"
            ? DIFFICULTIES[
                Math.floor(
                    Math.random() *
                    DIFFICULTIES.length
                )
            ]
            : difficulty;

    return {
        topic:
            selectedTopic,

        difficulty:
            selectedDifficulty,
    };
}


/*
|--------------------------------------------------------------------------
| Generate quiz
|--------------------------------------------------------------------------
|
| NORMAL CASE:
|
| Redis > 0
|     ↓
| Return immediately
|
|
| EMPTY CASE:
|
| Redis = 0
|     ↓
| Generate exactly ONE question
|     ↓
| Save it
|     ↓
| Return it immediately
|     ↓
| Start background generation of 50
|
|--------------------------------------------------------------------------
*/

async function generateQuiz(
    region,
    topic,
    difficulty
) {

    /*
    |--------------------------------------------------------------------------
    | FIRST: Redis
    |--------------------------------------------------------------------------
    */

    let question;

    try {

        question =
            await getQuestion(
                region,
                topic,
                difficulty
            );

    } catch (error) {

        console.error(
            "❌ Failed to read question from Redis:",
            error.message
        );

        throw error;
    }


    /*
    |--------------------------------------------------------------------------
    | Redis hit
    |--------------------------------------------------------------------------
    */

    if (question) {

        console.log(
            "⚡ Quiz loaded from Redis"
        );

        return question;
    }


    /*
    |--------------------------------------------------------------------------
    | Redis empty
    |--------------------------------------------------------------------------
    */

    console.log(
        "📦 Redis pool empty. Generating first question..."
    );


    /*
    |--------------------------------------------------------------------------
    | Resolve concrete pool
    |--------------------------------------------------------------------------
    */

    const generationPool =
        resolveGenerationPool(
            topic,
            difficulty
        );


    /*
    |--------------------------------------------------------------------------
    | Generate ONE question first
    |--------------------------------------------------------------------------
    |
    | This is the important part.
    |
    | We do NOT wait for 50 questions.
    |
    |--------------------------------------------------------------------------
    */

    let firstQuestion =
        null;

    await generateQuestionBatch(
        region,
        generationPool.topic,
        generationPool.difficulty,
        {
            target: 1,

            onQuestion:
                async generatedQuestion => {

                    firstQuestion =
                        generatedQuestion;
                },
        }
    );


    /*
    |--------------------------------------------------------------------------
    | First question failed
    |--------------------------------------------------------------------------
    */

    if (!firstQuestion) {

        throw new Error(
            "Gemini did not generate a usable first question."
        );
    }


    /*
    |--------------------------------------------------------------------------
    | Get the generated question from Redis
    |--------------------------------------------------------------------------
    |
    | It was added to the concrete generation pool.
    |
    |--------------------------------------------------------------------------
    */

    question =
        await getQuestion(
            region,
            generationPool.topic,
            generationPool.difficulty
        );


    if (!question) {

        throw new Error(
            "Generated question was saved but could not be retrieved from Redis."
        );
    }


    /*
    |--------------------------------------------------------------------------
    | Start background generation
    |--------------------------------------------------------------------------
    |
    | IMPORTANT:
    |
    | Do NOT await this.
    |
    | The quiz is already ready.
    |
    |--------------------------------------------------------------------------
    */

    void startBackgroundRefill(
        region,
        generationPool.topic,
        generationPool.difficulty
    );


    console.log(
        "⚡ First generated question ready. Background generation continues."
    );


    /*
    |--------------------------------------------------------------------------
    | Return immediately
    |--------------------------------------------------------------------------
    */

    return question;
}


/*
|--------------------------------------------------------------------------
| Exports
|--------------------------------------------------------------------------
*/

module.exports = {
    generateQuiz,
    generateQuestionBatch,
};