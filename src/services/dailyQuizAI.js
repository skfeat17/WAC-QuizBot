// dailyQuizAI.js
require("dotenv").config();

const { GoogleGenAI } = require("@google/genai");
const { z } = require("zod");

const {
    createQuestionContext,
    hasQuestionBeenUsed,
    hasQuestionSubjectBeenUsed,
    getStoredQuestionContexts,
} = require("./dailyQuizRedis");

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

// ==========================================
// SCHEMA
// ==========================================

const dailyEventSchema = z.object({
    countries: z.array(
        z.object({
            country: z.string().min(1),
            flag: z.string().min(1),
            prompt: z.string().min(1),
            answers: z.array(z.string().min(1)).length(4),
            correctAnswer: z.number().int().min(0).max(3),
        })
    ).length(10),
});

// ==========================================
// SETTINGS
// ==========================================

const MAX_GENERATION_ATTEMPTS = 8;

const SUBJECT_HISTORY_TYPES = new Set([
    "food",
    "monument",
    "famousPerson",
]);

// ==========================================
// MAIN GENERATOR
// ==========================================

async function generateDailyQuiz(type) {
    console.log(`🤖 Generating Daily Event: ${type}`);

    let previousContexts = [];

    try {
        previousContexts = await getStoredQuestionContexts(type);
    } catch (error) {
        console.error(
            "⚠️ Could not load Daily Event history:",
            error.message
        );
    }

    // Subjects already used for this event type.
    // Example:
    // food :: japan :: ramen
    // monument :: france :: eiffel tower
    // famousPerson :: germany :: albert einstein
    const previousSubjects = new Set();

    if (SUBJECT_HISTORY_TYPES.has(type)) {
        for (const context of previousContexts) {
            const subject = extractSubjectFromContext(context);

            if (subject) {
                previousSubjects.add(subject);
            }
        }
    }

    for (
        let attempt = 1;
        attempt <= MAX_GENERATION_ATTEMPTS;
        attempt++
    ) {
        try {
            const prompt = getPrompt(
                type,
                previousContexts,
                previousSubjects
            );

            const response = await ai.models.generateContent({
                model: "gemini-3.1-flash-lite",
                contents: prompt,

                config: {
                    responseMimeType: "application/json",

                    responseSchema: {
                        type: "object",

                        properties: {
                            countries: {
                                type: "array",
                                minItems: 10,
                                maxItems: 10,

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
                                    },

                                    required: [
                                        "country",
                                        "flag",
                                        "prompt",
                                        "answers",
                                        "correctAnswer",
                                    ],

                                    additionalProperties: false,
                                },
                            },
                        },

                        required: ["countries"],
                        additionalProperties: false,
                    },

                    maxOutputTokens: 7000,
                },
            });

            if (!response.text) {
                throw new Error("Gemini returned an empty response.");
            }

            let parsed;

            try {
                parsed = JSON.parse(response.text);
            } catch {
                throw new Error("Gemini returned invalid JSON.");
            }

            const result = dailyEventSchema.parse(parsed);

            const usedCountries = new Set();
            const batchSubjects = new Set();
            const freshQuestions = [];

            for (const item of result.countries) {
                const country = item.country.trim();
                const countryKey = normalize(country);

                // ==========================================
                // DUPLICATE COUNTRY
                // ==========================================

                if (usedCountries.has(countryKey)) {
                    console.log(
                        `⚠️ Duplicate country rejected: ${country}`
                    );
                    continue;
                }

                // ==========================================
                // ANSWERS
                // ==========================================

                const answers = item.answers.map(answer =>
                    answer.trim()
                );

                const normalizedAnswers = answers.map(normalize);

                if (
                    new Set(normalizedAnswers).size !== 4
                ) {
                    console.log(
                        `⚠️ Duplicate answer options rejected: ${country}`
                    );
                    continue;
                }

                if (
                    !Number.isInteger(item.correctAnswer) ||
                    item.correctAnswer < 0 ||
                    item.correctAnswer > 3
                ) {
                    continue;
                }

                const correctAnswer =
                    answers[item.correctAnswer];

                if (!correctAnswer) {
                    continue;
                }

                const correctAnswerKey =
                    normalize(correctAnswer);

                // ==========================================
                // SUBJECT DUPLICATE CHECK
                // ==========================================

                if (
                    SUBJECT_HISTORY_TYPES.has(type)
                ) {
                    const subjectKey =
                        createSubjectKey(
                            type,
                            country,
                            correctAnswer
                        );

                    // Already answered in an older event.
                    if (
                        previousSubjects.has(subjectKey)
                    ) {
                        console.log(
                            `🚫 REPEATED SUBJECT REJECTED | ` +
                            `${type} | ${country} | ${correctAnswer}`
                        );

                        continue;
                    }

                    // Already generated for another country
                    // entry in THIS batch.
                    if (
                        batchSubjects.has(subjectKey)
                    ) {
                        console.log(
                            `🚫 DUPLICATE SUBJECT IN BATCH | ` +
                            `${type} | ${country} | ${correctAnswer}`
                        );

                        continue;
                    }

                    // Also directly ask Redis.
                    try {
                        const alreadyUsed =
                            await hasQuestionSubjectBeenUsed(
                                type,
                                subjectKey
                            );

                        if (alreadyUsed) {
                            console.log(
                                `🚫 REDIS SUBJECT DUPLICATE | ` +
                                `${type} | ${country} | ${correctAnswer}`
                            );

                            continue;
                        }
                    } catch (error) {
                        console.error(
                            "⚠️ Subject history check failed:",
                            error.message
                        );

                        throw error;
                    }

                    batchSubjects.add(subjectKey);
                }

                // ==========================================
                // FULL QUESTION CONTEXT
                // ==========================================

                const context =
                    createQuestionContext({
                        type,
                        country,
                        prompt: item.prompt,
                        answers,
                        scrambled: correctAnswer,
                    });

                // ==========================================
                // EXACT QUESTION DUPLICATE
                // ==========================================

                if (
                    await hasQuestionBeenUsed(
                        type,
                        context
                    )
                ) {
                    console.log(
                        `🚫 REPEATED QUESTION REJECTED | ` +
                        `${type} | ${country}`
                    );

                    continue;
                }

                // ==========================================
                // ACCEPT QUESTION
                // ==========================================

                usedCountries.add(countryKey);

                freshQuestions.push({
                    country,
                    flag: item.flag.trim(),
                    prompt: item.prompt.trim(),
                    answers,
                    correctAnswer: item.correctAnswer,

                    // Internal metadata.
                    // Removed before returning.
                    _questionContext: context,
                    _subjectKey:
                        SUBJECT_HISTORY_TYPES.has(type)
                            ? createSubjectKey(
                                  type,
                                  country,
                                  correctAnswer
                              )
                            : null,
                    _correctAnswerText:
                        correctAnswer,
                    _correctAnswerKey:
                        correctAnswerKey,
                });
            }

            // ==========================================
            // SUCCESS
            // ==========================================

            if (freshQuestions.length === 10) {
                console.log(
                    `✅ 10 fresh ${type} Daily Event questions generated.`
                );

                return {
                    countries: freshQuestions.map(
                        ({
                            _questionContext,
                            _subjectKey,
                            _correctAnswerText,
                            _correctAnswerKey,
                            ...country
                        }) => country
                    ),
                };
            }

            console.log(
                `⚠️ Only ${freshQuestions.length}/10 fresh questions. Retrying...`
            );

            // Add rejected/generated contexts to the prompt
            // for the next generation attempt.
            for (const item of result.countries) {
                const answers = item.answers.map(answer =>
                    answer.trim()
                );

                const context =
                    createQuestionContext({
                        type,
                        country: item.country,
                        prompt: item.prompt,
                        answers,
                        scrambled:
                            answers[item.correctAnswer] ||
                            String(item.correctAnswer),
                    });

                if (
                    !previousContexts.includes(context)
                ) {
                    previousContexts.push(context);
                }

                if (
                    SUBJECT_HISTORY_TYPES.has(type) &&
                    answers[item.correctAnswer]
                ) {
                    previousSubjects.add(
                        createSubjectKey(
                            type,
                            item.country,
                            answers[item.correctAnswer]
                        )
                    );
                }
            }
        } catch (error) {
            console.error(
                `❌ Daily Event generation attempt ${attempt} failed:`,
                error.message
            );
        }
    }

    throw new Error(
        `Could not generate 10 unique Daily Event questions for "${type}" after ${MAX_GENERATION_ATTEMPTS} attempts.`
    );
}

// ==========================================
// SUBJECT KEY
// ==========================================

function createSubjectKey(
    type,
    country,
    subject
) {
    return [
        normalize(type),
        normalize(country),
        normalize(subject),
    ].join(" :: ");
}

// ==========================================
// EXTRACT SUBJECT FROM OLD HISTORY
// ==========================================
//
// Supports contexts created with:
// scrambled = correct answer
//
// Older contexts that stored the correct-answer INDEX
// cannot reliably reveal the subject. New answered
// questions will use the correct answer instead.
//

function extractSubjectFromContext(context) {
    if (!context) return null;

    const parts = String(context).split(" :: ");

    if (parts.length < 5) {
        return null;
    }

    const type = parts[0];
    const country = parts[1];
    const scrambled = parts[4];

    if (
        !SUBJECT_HISTORY_TYPES.has(type) ||
        !country ||
        !scrambled
    ) {
        return null;
    }

    // New format stores the actual correct answer.
    // Old format stores 0/1/2/3, which we deliberately
    // ignore because it is not enough to identify the subject.
    if (/^[0-3]$/.test(scrambled)) {
        return null;
    }

    return createSubjectKey(
        type,
        country,
        scrambled
    );
}

// ==========================================
// PROMPT
// ==========================================

function getPrompt(
    type,
    previousContexts = [],
    previousSubjects = new Set()
) {
    const history = previousContexts.length
        ? previousContexts
              .slice(-150)
              .map(
                  (context, i) =>
                      `${i + 1}. ${context}`
              )
              .join("\n")
        : "NONE";

    const subjectHistory =
        previousSubjects.size
            ? [...previousSubjects]
                  .slice(-150)
                  .map(
                      (subject, i) =>
                          `${i + 1}. ${subject}`
                  )
                  .join("\n")
            : "NONE";

    const rules = `
Generate exactly 10 different sovereign countries.

IMPORTANT:

- Every country must be different.
- Every country gets exactly 4 MCQ options.
- Exactly ONE option must be correct.
- correctAnswer is the zero-based index of the correct option.
- Options must be plausible but unambiguous.
- Never put the correct answer in multiple forms.
- Use accurate, well-established facts.
- Keep prompts short and suitable for Discord.
- ALL prompts and answer options must be in English.
- Use standard English country names and standard English names for capitals, monuments, foods, people, and dates.
- Do NOT use non-English scripts or untranslated local-language answer options.
- Return ONLY JSON.

CRITICAL ANTI-REPETITION RULE:

A question is NOT considered new merely because its wording
or answer choices are different.

If the SAME COUNTRY + SAME CORRECT SUBJECT has already
been used, DO NOT generate it again.

Changing:
- wording
- sentence structure
- question style
- distractors
- option order
- capitalization

does NOT make an old question new.

For FOOD:
- Never reuse the same food/dish for the same country.
- Choose a genuinely different food when that country appears again.

For MONUMENT:
- Never reuse the same monument/landmark for the same country.
- Choose a genuinely different landmark when that country appears again.

For FAMOUS PERSON:
- Never reuse the same person for the same country.
- Choose a genuinely different person when that country appears again.

PREVIOUSLY USED QUESTION CONTEXTS:

${history}

PREVIOUSLY USED SUBJECTS:

${subjectHistory}
`;

    const typeRules = {
        capital: `
EVENT TYPE: GUESS THE CAPITAL

For each country, ask for its capital city.

The four options must be capital cities and only one belongs
to the selected country.
`,

        food: `
EVENT TYPE: GUESS THE FAMOUS FOOD

For each country, choose ONE specific food or dish strongly
associated with that country.

CRITICAL:
- Do NOT repeatedly ask the same famous-food question.
- Do NOT reuse the same correct food for the same country.
- A different wording about the same food is still a duplicate.
- Prefer different dishes when a country appears again.

Vary the question style where possible:
- identify a dish from ingredients
- identify a dish from preparation
- identify a regional specialty
- identify a traditional dessert
- identify a traditional drink
- identify a dish from a distinctive description
- identify a food associated with a traditional occasion

The four answers must be food or drink names.
Exactly one must be correct.
`,

        monument: `
EVENT TYPE: GUESS THE FAMOUS BUILDING / MONUMENT

For each country, choose ONE specific famous landmark,
monument, building, temple, palace, archaeological site,
or other major constructed landmark.

CRITICAL:
- Do NOT repeatedly use the same landmark for the same country.
- A different wording about the same landmark is still a duplicate.
- Prefer a genuinely different landmark when a country appears again.

Vary the question style where possible:
- identify a landmark from its description
- identify it from architectural characteristics
- identify it from historical significance
- identify it from its location
- identify it from a distinctive feature

The four answers must be landmark names.
Exactly one must be correct.
`,

        famousPerson: `
EVENT TYPE: GUESS THE FAMOUS PERSON

For each country, choose ONE internationally or nationally
notable person strongly associated with that country.

The person may be known for:
- science
- literature
- music
- film
- sports
- exploration
- art
- invention
- history
- other major cultural or historical contributions

CRITICAL:
- Do NOT reuse the same person for the same country.
- A different wording about the same person is still a duplicate.
- Do NOT repeatedly use the same biography or achievement.
- Prefer a genuinely different notable person when a country appears again.

The question should contain enough established factual information
to identify the person without directly naming them.

Exactly one answer must be correct.
`,

        independence: `
EVENT TYPE: GUESS THE INDEPENDENCE DAY

For each country, ask for its nationally recognized
independence day/date.

The four answers must be dates such as "15 August".

Avoid disputed or ambiguous independence dates.
`,
    };

    if (!typeRules[type]) {
        throw new Error(
            `Unsupported Daily Event type: ${type}`
        );
    }

    return `${rules}
${typeRules[type]}

Choose countries from different regions when practical.
`;
}

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
// EXPORT
// ==========================================

module.exports = {
    generateDailyQuiz,
};