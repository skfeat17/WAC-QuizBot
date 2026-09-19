require("dotenv").config();

const { GoogleGenAI } = require("@google/genai");
const { z } = require("zod");

const {
    addQuestion,
    getQuestion,
} = require("./questionManager");

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
*/

const quizSchema = z.object({
    questions: z.array(
        z.object({
            question: z.string().min(1),

            factKey: z.string().min(1),

            options: z
                .array(z.string().min(1))
                .length(4),

            correctAnswer: z
                .number()
                .int()
                .min(0)
                .max(3),

            explanation: z.string().min(1),
        })
    ),
});


/*
|--------------------------------------------------------------------------
| Generate a batch of questions
|--------------------------------------------------------------------------
|
| Gemini is called ONLY when Redis has no suitable
| unused question.
|
*/

async function generateQuestionBatch(
    region,
    topic,
    difficulty
) {
    console.log(
        `🤖 Generating 20 questions: ${region} / ${topic} / ${difficulty}`
    );

    const prompt = `
Generate exactly 20 unique world-trivia multiple-choice questions.

Region: ${region}
Topic: ${topic}
Difficulty: ${difficulty}

Rules:

- Generate exactly 20 questions.
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
- Make all 20 questions substantially different.
- Avoid uncertain, disputed, or misleading facts.
- Avoid trick questions.
- Avoid questions where multiple options could reasonably be correct.

Return only JSON matching the requested schema.
`;

    try {
        const response = await ai.models.generateContent({
            model: "gemini-3.1-flash-lite",

            contents: prompt,

            config: {
                responseMimeType: "application/json",

                responseSchema: {
                    type: "object",

                    properties: {
                        questions: {
                            type: "array",

                            minItems: 20,
                            maxItems: 20,

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
                                    "question",
                                    "factKey",
                                    "options",
                                    "correctAnswer",
                                    "explanation",
                                ],

                                additionalProperties: false,
                            },
                        },
                    },

                    required: ["questions"],

                    additionalProperties: false,
                },

                /*
                 * 20 questions need more output than
                 * a single-question generation.
                 */
                maxOutputTokens: 5000,
            },
        });

        /*
         * Make sure Gemini actually returned something.
         */
        if (!response.text) {
            throw new Error(
                "Gemini returned an empty response."
            );
        }

        /*
         * Parse JSON.
         */
        let parsed;

        try {
            parsed = JSON.parse(response.text);
        } catch (error) {
            throw new Error(
                "Gemini returned invalid JSON."
            );
        }

        /*
         * Validate Gemini output with Zod.
         */
        const result = quizSchema.parse(parsed);

        /*
         * Prevent duplicates inside this batch.
         */
        const seenQuestions = new Set();
        const seenFacts = new Set();

        let saved = 0;

        for (const question of result.questions) {
            const normalizedQuestion =
                question.question
                    .toLowerCase()
                    .trim()
                    .replace(/\s+/g, " ");

            const normalizedFact =
                question.factKey
                    .toLowerCase()
                    .trim();

            /*
             * Duplicate generated in the same batch.
             */
            if (
                seenQuestions.has(
                    normalizedQuestion
                ) ||
                seenFacts.has(
                    normalizedFact
                )
            ) {
                console.log(
                    `⚠️ Batch duplicate skipped: ${question.factKey}`
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
             * Save to Redis.
             *
             * addQuestion() will also check whether
             * this question/fact already exists in Redis.
             */
            const added = await addQuestion({
                question: question.question,

                factKey: question.factKey,

                options: question.options,

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
            }
        }

        console.log(
            `✅ ${saved} new questions saved to Redis`
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
| 1. Check Redis first.
| 2. If Redis has a question → use it.
| 3. If Redis is empty → generate 20 questions.
| 4. Save them to Redis.
| 5. Take one question from Redis.
|
*/

async function generateQuiz(
    region,
    topic,
    difficulty
) {
    /*
     * FIRST:
     * Always check Redis.
     */

    let question = await getQuestion(
        region,
        topic,
        difficulty
    );

    if (question) {
        console.log(
            "⚡ Quiz loaded from Redis"
        );

        return question;
    }


    /*
     * Redis has nothing suitable.
     */

    console.log(
        "📦 No cached questions found."
    );


    /*
     * NOW use Gemini.
     *
     * Gemini generates a batch of 20,
     * not just one question.
     */

    await generateQuestionBatch(
        region,
        topic,
        difficulty
    );


    /*
     * Try Redis again.
     *
     * One of the newly generated questions
     * should now be available.
     */

    question = await getQuestion(
        region,
        topic,
        difficulty
    );


    /*
     * Safety check.
     */

    if (!question) {
        throw new Error(
            "No usable quiz question was generated."
        );
    }


    /*
     * Return the question to index.js.
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