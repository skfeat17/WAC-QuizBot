require("dotenv").config();

const { GoogleGenAI } = require("@google/genai");
const { z } = require("zod");

const {
    createQuestionContext,
    hasQuestionBeenUsed,
    saveQuestionContexts,
    getStoredQuestionContexts,
} = require("./dailyQuizRedis");

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

// ==========================================
// SCHEMAS
// ==========================================

const dailyQuizSchema = z.object({
    countries: z.array(
        z.object({
            country: z.string().min(1),
            flag: z.string().min(1),
            prompt: z.string().min(1),
            answers: z.array(
                z.string().min(1)
            ),
            scrambled: z.string().nullable(),
        })
    ).length(5),
});

const answerJudgeSchema = z.object({
    correct: z.boolean(),
    reason: z.string().min(1),
});

// ==========================================
// SETTINGS
// ==========================================

const MAX_GENERATION_ATTEMPTS = 5;

// ==========================================
// GENERATE DAILY QUIZ
// ==========================================

async function generateDailyQuiz(type) {

    console.log(
        `🤖 Generating Daily Quiz: ${type}`
    );

    let previousContexts = [];

    try {
        previousContexts =
            await getStoredQuestionContexts(
                type
            );
    } catch (error) {
        console.error(
            "⚠️ Could not load question history:",
            error.message
        );
    }

    for (
        let attempt = 1;
        attempt <= MAX_GENERATION_ATTEMPTS;
        attempt++
    ) {

        console.log(
            `🤖 Generation attempt ${attempt}/${MAX_GENERATION_ATTEMPTS}`
        );

        try {

            const prompt =
                getPrompt(
                    type,
                    previousContexts
                );

            const response =
                await ai.models.generateContent({

                    model:
                        "gemini-3.1-flash-lite",

                    contents: prompt,

                    config: {
                        responseMimeType:
                            "application/json",

                        responseSchema: {
                            type: "object",

                            properties: {

                                countries: {
                                    type: "array",

                                    minItems: 5,
                                    maxItems: 5,

                                    items: {
                                        type: "object",

                                        properties: {

                                            country: {
                                                type: "string",
                                            },

                                            flag: {
                                                type: "string",
                                            },

                                            prompt: {
                                                type: "string",
                                            },

                                            answers: {
                                                type: "array",

                                                items: {
                                                    type: "string",
                                                },
                                            },

                                            scrambled: {
                                                type: [
                                                    "string",
                                                    "null",
                                                ],
                                            },
                                        },

                                        required: [
                                            "country",
                                            "flag",
                                            "prompt",
                                            "answers",
                                            "scrambled",
                                        ],

                                        additionalProperties:
                                            false,
                                    },
                                },
                            },

                            required: [
                                "countries",
                            ],

                            additionalProperties:
                                false,
                        },

                        maxOutputTokens: 3000,
                    },
                });

            if (!response.text) {
                throw new Error(
                    "Gemini returned an empty response."
                );
            }

            let parsed;

            try {
                parsed =
                    JSON.parse(
                        response.text
                    );
            } catch {
                throw new Error(
                    "Gemini returned invalid JSON."
                );
            }

            const result =
                dailyQuizSchema.parse(
                    parsed
                );

            // ======================================
            // CHECK DUPLICATES
            // ======================================

            const usedCountries =
                new Set();

            const freshQuestions = [];

            for (
                const item of result.countries
            ) {

                const countryKey =
                    normalize(
                        item.country
                    );

                // Same country twice
                if (
                    usedCountries.has(
                        countryKey
                    )
                ) {
                    console.log(
                        `♻️ Duplicate country skipped: ${item.country}`
                    );

                    continue;
                }

                usedCountries.add(
                    countryKey
                );

                const context =
                    createQuestionContext({
                        type,
                        country:
                            item.country,
                        prompt:
                            item.prompt,
                        answers:
                            item.answers,
                        scrambled:
                            item.scrambled,
                    });

                const alreadyUsed =
                    await hasQuestionBeenUsed(
                        type,
                        context
                    );

                if (alreadyUsed) {

                    console.log(
                        `♻️ Old question skipped: ${item.country}`
                    );

                    continue;
                }

                freshQuestions.push({
                    ...item,
                    _questionContext:
                        context,
                });
            }

            // ======================================
            // SUCCESS
            // ======================================

            if (
                freshQuestions.length === 5
            ) {

                await saveQuestionContexts(
                    type,
                    freshQuestions.map(
                        item =>
                            item._questionContext
                    )
                );

                console.log(
                    `✅ 5 fresh questions generated for ${type}`
                );

                return {
                    countries:
                        freshQuestions.map(
                            ({
                                _questionContext,
                                ...country
                            }) =>
                                country
                        ),
                };
            }

            console.log(
                `⚠️ Only ${freshQuestions.length}/5 questions were fresh. Retrying...`
            );

            // Remember this attempt too.
            for (
                const item of result.countries
            ) {

                const context =
                    createQuestionContext({
                        type,
                        country:
                            item.country,
                        prompt:
                            item.prompt,
                        answers:
                            item.answers,
                        scrambled:
                            item.scrambled,
                    });

                if (
                    !previousContexts.includes(
                        context
                    )
                ) {
                    previousContexts.push(
                        context
                    );
                }
            }

        } catch (error) {

            console.error(
                `❌ Daily Quiz attempt ${attempt} failed:`,
                error.message
            );
        }
    }

    throw new Error(
        `Could not generate 5 unique Daily Quiz questions for "${type}" after ${MAX_GENERATION_ATTEMPTS} attempts.`
    );
}

// ==========================================
// AI ANSWER JUDGE
// ==========================================

async function judgeDailyQuizAnswer({
    type,
    country,
    userAnswer,
    acceptedAnswers,
    scrambled,
}) {

    console.log(
        `🤖 Checking Daily Quiz answer: "${userAnswer}"`
    );

    const accepted =
        Array.isArray(acceptedAnswers)
            ? acceptedAnswers
            : [];

    const prompt = `
You are the strict answer judge for a world trivia quiz.

Determine whether the user's answer is factually equivalent
to one of the accepted answers.

QUIZ TYPE:
${type}

COUNTRY:
${country}

ACCEPTED ANSWERS:
${JSON.stringify(accepted)}

SCRAMBLED COUNTRY:
${scrambled || "null"}

USER ANSWER:
${JSON.stringify(userAnswer)}

Rules:

1. Return correct=true ONLY if the user's answer is genuinely
   correct for the exact question.

2. Minor capitalization differences are acceptable.

3. Minor spelling differences are acceptable when they clearly
   refer to the same answer.

4. Common English names are acceptable.

5. Synonyms are acceptable only when they genuinely refer to
   the same thing.

6. Do NOT accept an answer merely because it is related to
   the correct answer.

7. Do NOT invent an alternative answer.

8. For currency:
   Accept common names of the same currency.

9. For capital:
   Accept common alternate spellings/names of the same capital.

10. For food:
    Accept only a food represented in the accepted answers.
    Do not invent another food.

11. For unscramble:
    The answer must identify the exact country represented
    by the scrambled letters.

12. Do not be overly strict about capitalization or punctuation.

13. Do not be overly generous.

14. The accepted answers are the source of truth.

Return ONLY JSON.
`;

    try {

        const response =
            await ai.models.generateContent({

                model:
                    "gemini-3.1-flash-lite",

                contents: prompt,

                config: {
                    responseMimeType:
                        "application/json",

                    responseSchema: {
                        type: "object",

                        properties: {

                            correct: {
                                type: "boolean",
                            },

                            reason: {
                                type: "string",
                            },
                        },

                        required: [
                            "correct",
                            "reason",
                        ],

                        additionalProperties:
                            false,
                    },

                    maxOutputTokens: 300,
                },
            });

        if (!response.text) {
            throw new Error(
                "Empty AI judge response."
            );
        }

        const parsed =
            JSON.parse(
                response.text
            );

        const result =
            answerJudgeSchema.parse(
                parsed
            );

        console.log(
            `🤖 Answer result: ${
                result.correct
                    ? "CORRECT"
                    : "WRONG"
            }`
        );

        return result;

    } catch (error) {

        console.error(
            "❌ AI answer judge failed:",
            error.message
        );

        throw error;
    }
}

// ==========================================
// PROMPTS
// ==========================================

function getPrompt(
    type,
    previousContexts = []
) {

    const history =
        previousContexts.length > 0
            ? previousContexts
                .slice(-100)
                .map(
                    (context, index) =>
                        `${index + 1}. ${context}`
                )
                .join("\n")
            : "NONE";

    const antiRepeatRules = `
IMPORTANT ANTI-REPEAT RULES:

- Generate exactly 5 questions.
- All 5 countries must be different.
- Never reuse a previous question.
- Never reuse the same country + answer combination
  for this quiz type.
- A country MAY appear again if the actual question
  is genuinely different.
- Changing only wording does NOT make a question new.
- Do not reuse an old food + country combination.
- Do not reuse an old currency + country combination.
- Do not reuse an old capital + country combination.
- Do not reuse an old unscramble arrangement.
- Every question must be genuinely fresh.

PREVIOUSLY USED QUESTION CONTEXTS:
${history}
`;

    if (type === "currency") {

        return `
Generate exactly 5 different sovereign countries.

Quiz type: CURRENCY.

${antiRepeatRules}

For each country:

- Give the country name.
- Give its flag emoji.
- The player must identify its currency.
- "answers" must contain the official currency name
  and reasonable common names.
- Do not use currency symbols alone.
- Do not use currency codes alone.
- "scrambled" must be null.

Choose countries from different regions when practical.

Return only JSON.
`;
    }

    if (type === "capital") {

        return `
Generate exactly 5 different sovereign countries.

Quiz type: CAPITAL.

${antiRepeatRules}

For each country:

- Give the country name.
- Give its flag emoji.
- The player must identify its capital.
- "answers" must contain the correct capital.
- Include legitimate alternate spellings only when necessary.
- Avoid ambiguous or disputed capital situations.
- "scrambled" must be null.

Choose countries from different regions when practical.

Return only JSON.
`;
    }

    if (type === "food") {

        return `
Generate exactly 5 different sovereign countries.

Quiz type: FOOD.

${antiRepeatRules}

For each country:

- Give the country name.
- Give its flag emoji.
- The player must name ONE famous or traditional food.
- "answers" must contain 3 to 5 genuinely valid foods
  strongly associated with that country.
- Do not use generic foods.
- Do not use foods merely because they happen to be eaten there.
- Every accepted food must have a strong cultural association
  with the country.
- "scrambled" must be null.

Choose countries from different regions when practical.

Return only JSON.
`;
    }

    if (type === "unscramble") {

        return `
Generate exactly 5 different sovereign countries.

Quiz type: UNSCRAMBLE.

${antiRepeatRules}

For each country:

- Country name must contain at least 5 letters.
- Create a scrambled version containing exactly the same letters.
- Do not add letters.
- Do not remove letters.
- Do not duplicate letters.
- The scrambled string must not reveal the country.
- "answers" must contain the exact country name.
- "scrambled" must contain the scrambled letters.
- Avoid extremely difficult or obscure country names.

Choose countries from different regions when practical.

Return only JSON.
`;
    }

    throw new Error(
        `Unsupported Daily Quiz type: ${type}`
    );
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
    generateDailyQuiz,
    judgeDailyQuizAnswer,
};