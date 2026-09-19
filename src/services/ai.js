require("dotenv").config();

const { GoogleGenAI } = require("@google/genai");
const { z } = require("zod");

const {
    addQuestion,
    getQuestion,
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
| Quiz validation schema
|--------------------------------------------------------------------------
|
| Gemini generates the data.
| Zod is responsible for enforcing our application rules.
|
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


const quizSchema = z.object({

    questions: z
        .array(questionSchema)
        .length(BATCH_SIZE),
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
| Validate a question
|--------------------------------------------------------------------------
*/

function validateQuestion(question) {

    if (!question.question.trim()) {
        throw new Error(
            "Question text cannot be empty."
        );
    }

    if (!question.factKey.trim()) {
        throw new Error(
            "factKey cannot be empty."
        );
    }

    if (question.options.length !== 4) {
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

    /*
     * Make sure the four options are actually different.
     */
    const normalizedOptions =
        question.options.map(normalizeText);

    const uniqueOptions =
        new Set(normalizedOptions);

    if (
        uniqueOptions.size !== 4
    ) {
        throw new Error(
            `Duplicate options found in "${question.question}".`
        );
    }

    /*
     * Keep explanations reasonably short.
     */
    if (
        question.explanation.length > 500
    ) {
        throw new Error(
            `Explanation is too long for "${question.question}".`
        );
    }
}


/*
|--------------------------------------------------------------------------
| Generate a batch of questions
|--------------------------------------------------------------------------
|
| Gemini is called ONLY when Redis has no suitable question.
|
*/

async function generateQuestionBatch(
    region,
    topic,
    difficulty
) {

    console.log(
        `🤖 Generating ${BATCH_SIZE} questions: ${region} / ${topic} / ${difficulty}`
    );


    /*
    |--------------------------------------------------------------------------
    | Prompt
    |--------------------------------------------------------------------------
    */

    const prompt = `
Generate exactly ${BATCH_SIZE} unique world-trivia multiple-choice questions.

Region: ${region}
Topic: ${topic}
Difficulty: ${difficulty}

RULES:

- Generate exactly ${BATCH_SIZE} questions.
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
- Stay strictly within the requested region.
- Each factKey must identify the unique underlying fact.
- factKey must use lowercase_snake_case.
- All ${BATCH_SIZE} questions must be substantially different.
- Avoid uncertain, disputed, or misleading facts.
- Avoid trick questions.
- Avoid questions where multiple options could reasonably be correct.
- Do not reuse the same wording across questions.
- Do not create multiple questions whose answers are based on the same fact.
- Make the questions varied within the requested topic.
- Do not add numbering such as "1.", "2.", etc. to the question text.

IMPORTANT:

Return exactly ${BATCH_SIZE} questions.

Return ONLY the JSON object matching the provided schema.
`;


    try {

        /*
        |--------------------------------------------------------------------------
        | Gemini request
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

                    /*
                     * Keep the Gemini schema simple.
                     *
                     * We enforce the exact 50-question
                     * requirement using Zod below.
                     */
                    responseSchema: {

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
                    },

                    maxOutputTokens:
                        MAX_OUTPUT_TOKENS,
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
        | Validate entire batch with Zod
        |--------------------------------------------------------------------------
        |
        | This guarantees exactly 50 questions.
        |
        */

        const result =
            quizSchema.safeParse(
                parsed
            );


        if (!result.success) {

            console.error(
                "❌ Gemini question validation failed:"
            );

            console.error(
                result.error.issues
            );

            throw new Error(
                `Gemini did not return exactly ${BATCH_SIZE} valid questions.`
            );
        }


        const questions =
            result.data.questions;


        /*
        |--------------------------------------------------------------------------
        | Validate individual questions
        |--------------------------------------------------------------------------
        */

        for (
            const question
            of questions
        ) {

            validateQuestion(
                question
            );
        }


        /*
        |--------------------------------------------------------------------------
        | Detect duplicates inside this batch
        |--------------------------------------------------------------------------
        */

        const seenQuestions =
            new Set();

        const seenFacts =
            new Set();

        const uniqueQuestions =
            [];


        for (
            const question
            of questions
        ) {

            const normalizedQuestion =
                normalizeText(
                    question.question
                );

            const normalizedFact =
                normalizeFactKey(
                    question.factKey
                );


            /*
             * Duplicate question
             */
            if (
                seenQuestions.has(
                    normalizedQuestion
                )
            ) {

                console.warn(
                    `⚠️ Duplicate question detected: ${question.question}`
                );

                continue;
            }


            /*
             * Duplicate underlying fact
             */
            if (
                seenFacts.has(
                    normalizedFact
                )
            ) {

                console.warn(
                    `⚠️ Duplicate fact detected: ${question.factKey}`
                );

                continue;
            }


            seenQuestions.add(
                normalizedQuestion
            );

            seenFacts.add(
                normalizedFact
            );

            uniqueQuestions.push(
                question
            );
        }


        /*
        |--------------------------------------------------------------------------
        | We don't want to save a broken batch.
        |--------------------------------------------------------------------------
        |
        | If Gemini technically returned 50 but our duplicate
        | protection reduces it below 50, reject the batch.
        |
        */

        if (
            uniqueQuestions.length !==
            BATCH_SIZE
        ) {

            throw new Error(
                `Gemini generated ${BATCH_SIZE} questions, but only ${uniqueQuestions.length} were unique. Batch rejected.`
            );
        }


        /*
        |--------------------------------------------------------------------------
        | Save questions to Redis
        |--------------------------------------------------------------------------
        */

        let saved = 0;


        for (
            const question
            of uniqueQuestions
        ) {

            try {

                const added =
                    await addQuestion({

                        question:
                            question.question,

                        factKey:
                            question.factKey,

                        options:
                            question.options,

                        correctAnswer:
                            question.correctAnswer,

                        explanation:
                            question.explanation,

                        region,

                        topic,

                        difficulty,
                    });


                if (added) {

                    saved++;

                } else {

                    console.log(
                        `⚠️ Question already exists: ${question.factKey}`
                    );
                }

            } catch (error) {

                console.error(
                    `❌ Failed to save question "${question.factKey}":`,
                    error.message
                );

                /*
                 * Don't necessarily destroy the whole batch
                 * because one Redis write failed.
                 */
            }
        }


        console.log(
            `✅ ${saved}/${BATCH_SIZE} new questions saved to Redis`
        );


        return saved;


    } catch (error) {

        console.error(
            "❌ Question batch generation failed:",
            error.message
        );

        throw error;
    }
}


/*
|--------------------------------------------------------------------------
| Get a quiz question
|--------------------------------------------------------------------------
|
| 1. Check Redis.
| 2. If a suitable question exists → use it.
| 3. If Redis has nothing suitable → generate 50.
| 4. Save them to Redis.
| 5. Retrieve a question.
|
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
    | Redis miss
    |--------------------------------------------------------------------------
    */

    console.log(
        "📦 No cached questions found."
    );


    /*
    |--------------------------------------------------------------------------
    | Generate 50 questions
    |--------------------------------------------------------------------------
    */

    await generateQuestionBatch(
        region,
        topic,
        difficulty
    );


    /*
    |--------------------------------------------------------------------------
    | Try Redis again
    |--------------------------------------------------------------------------
    */

    try {

        question =
            await getQuestion(
                region,
                topic,
                difficulty
            );

    } catch (error) {

        console.error(
            "❌ Failed to retrieve generated question:",
            error.message
        );

        throw error;
    }


    /*
    |--------------------------------------------------------------------------
    | Safety check
    |--------------------------------------------------------------------------
    */

    if (!question) {

        throw new Error(
            "No usable quiz question was available after generating a new batch."
        );
    }


    /*
    |--------------------------------------------------------------------------
    | Return question
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