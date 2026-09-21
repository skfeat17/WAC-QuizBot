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

const dailyEventSchema = z.object({
    countries: z.array(
        z.object({
            country: z.string().min(1),
            flag: z.string().min(1),
            prompt: z.string().min(1),
            answers: z.array(z.string().min(1)).length(4),
            correctAnswer: z.number().int().min(0).max(3),
        })
    ).length(5),
});

const MAX_GENERATION_ATTEMPTS = 5;

async function generateDailyQuiz(type) {
    console.log(`🤖 Generating Daily Event: ${type}`);

    let previousContexts = [];
    try {
        previousContexts = await getStoredQuestionContexts(type);
    } catch (error) {
        console.error("⚠️ Could not load Daily Event history:", error.message);
    }

    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
        try {
            const prompt = getPrompt(type, previousContexts);

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
                                minItems: 5,
                                maxItems: 5,
                                items: {
                                    type: "object",
                                    properties: {
                                        country: { type: "string" },
                                        flag: { type: "string" },
                                        prompt: { type: "string" },
                                        answers: {
                                            type: "array",
                                            minItems: 4,
                                            maxItems: 4,
                                            items: { type: "string" },
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
                    maxOutputTokens: 4000,
                },
            });

            if (!response.text) throw new Error("Gemini returned an empty response.");

            let parsed;
            try {
                parsed = JSON.parse(response.text);
            } catch {
                throw new Error("Gemini returned invalid JSON.");
            }

            const result = dailyEventSchema.parse(parsed);
            const usedCountries = new Set();
            const freshQuestions = [];

            for (const item of result.countries) {
                const countryKey = normalize(item.country);
                const answers = item.answers.map(a => a.trim());
                const normalizedAnswers = answers.map(normalize);

                if (usedCountries.has(countryKey)) continue;
                if (new Set(normalizedAnswers).size !== 4) continue;
                if (normalizedAnswers[item.correctAnswer] === "") continue;

                usedCountries.add(countryKey);

                const context = createQuestionContext({
                    type,
                    country: item.country,
                    prompt: item.prompt,
                    answers,
                    scrambled: String(item.correctAnswer),
                });

                if (await hasQuestionBeenUsed(type, context)) continue;

                freshQuestions.push({
                    country: item.country.trim(),
                    flag: item.flag.trim(),
                    prompt: item.prompt.trim(),
                    answers,
                    correctAnswer: item.correctAnswer,
                    _questionContext: context,
                });
            }

            if (freshQuestions.length === 5) {
                await saveQuestionContexts(
                    type,
                    freshQuestions.map(item => item._questionContext)
                );

                console.log(`✅ 5 fresh ${type} Daily Event questions generated.`);

                return {
                    countries: freshQuestions.map(({ _questionContext, ...country }) => country),
                };
            }

            console.log(`⚠️ Only ${freshQuestions.length}/5 fresh questions. Retrying...`);

            for (const item of result.countries) {
                const context = createQuestionContext({
                    type,
                    country: item.country,
                    prompt: item.prompt,
                    answers: item.answers,
                    scrambled: String(item.correctAnswer),
                });
                if (!previousContexts.includes(context)) previousContexts.push(context);
            }
        } catch (error) {
            console.error(`❌ Daily Event generation attempt ${attempt} failed:`, error.message);
        }
    }

    throw new Error(
        `Could not generate 5 unique Daily Event questions for "${type}" after ${MAX_GENERATION_ATTEMPTS} attempts.`
    );
}

function getPrompt(type, previousContexts = []) {
    const history = previousContexts.length
        ? previousContexts.slice(-100).map((context, i) => `${i + 1}. ${context}`).join("\n")
        : "NONE";

    const rules = `
Generate exactly 5 different sovereign countries.

IMPORTANT:
- Every country must be different.
- Every country gets exactly 4 MCQ options.
- Exactly ONE option must be correct.
- correctAnswer is the zero-based index of the correct option.
- Options must be plausible but unambiguous.
- Never put the correct answer in multiple forms.
- Never repeat a previous question context.
- A country may return in a future event only with a genuinely different question where applicable.
- Use accurate, well-established facts.
- Keep prompts short and suitable for Discord.
- ALL prompts, answer options, and generated explanatory text must be in English.
- Use standard English country names and standard English names for capitals, monuments, foods, people, and dates.
- Do NOT use non-English scripts or untranslated local-language answer options.
- Proper names that are normally written the same way internationally are allowed.
- Return ONLY JSON.

PREVIOUSLY USED QUESTION CONTEXTS:
${history}
`;

    const typeRules = {
        capital: `
EVENT TYPE: GUESS THE CAPITAL
For each country, ask for its capital city.
The four options must be capital cities and only one belongs to the selected country.
`,
        food: `
EVENT TYPE: GUESS THE FAMOUS FOOD
For each country, ask which food is strongly associated with that country.
The four answers must be food names. Avoid generic foods.
Only one option should be the strongest established association.
`,
        monument: `
EVENT TYPE: GUESS THE FAMOUS BUILDING / MONUMENT
For each country, ask which famous building or monument is associated with that country.
The four answers must be landmark names. Only one should belong to the selected country.
`,
        president: `
EVENT TYPE: GUESS THE PRESIDENT
For each country, ask for the current head of state/president where the country has a presidential head of state.
Use the currently serving person as of generation time.
The four answers must be person names. Avoid countries where the wording would be constitutionally ambiguous.
`,
        independence: `
EVENT TYPE: GUESS THE INDEPENDENCE DAY
For each country, ask for its nationally recognized independence day/date.
The four answers must be dates such as "15 August". Avoid disputed or ambiguous independence dates.
`,
    };

    if (!typeRules[type]) throw new Error(`Unsupported Daily Event type: ${type}`);

    return `${rules}\n${typeRules[type]}\nChoose countries from different regions when practical.`;
}

function normalize(value) {
    return String(value ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
}

module.exports = {
    generateDailyQuiz,
};
