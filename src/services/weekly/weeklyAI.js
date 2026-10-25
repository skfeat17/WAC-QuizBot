// weeklyAI.js
// Generates fresh, very easy world-trivia questions for the shared WAC Weekly Quiz pool.
// Uses Redis history, duplicate checks, retries, and Gemini model fallback.

require('dotenv').config();

const { GoogleGenAI } = require('@google/genai');
const R = require('./weeklyRedis');
const { hashQuestion, hashSubject } = require('./weeklyUtils');

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

const PRIMARY_MODEL =
    process.env.WEEKLY_GEMINI_MODEL || 'gemini-3.1-flash-lite';

const FALLBACK_MODEL =
    process.env.WEEKLY_GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite';

const DEFAULT_POOL_SIZE = 20;
const MAX_GENERATION_ATTEMPTS = 12;
const QUESTIONS_PER_AI_REQUEST = 20;

const CATEGORIES = [
    'Countries and Capitals',
    'Flags and Symbols',
    'World Geography',
    'Famous Landmarks',
    'Food Around the World',
    'Culture and Traditions',
    'Languages',
    'Nature and Wildlife',
    'History',
    'Oceans, Rivers and Mountains',
    'World Sports',
    'Famous Cities',
    'Space and Astronomy',
    'World Inventions',
    'Art and Music',
];

// Detect temporary Gemini errors that may be worth retrying with the fallback model.
function isTemporaryAIError(error) {
    const message = String(
        error?.status || error?.code || error?.message || ''
    ).toLowerCase();

    return [
        '429', '500', '502', '503', '504', 'quota', 'overloaded',
        'unavailable', 'rate limit', 'resource exhausted', 'timeout',
        'timed out', 'too many requests',
    ].some((part) => message.includes(part));
}

// Request a batch from Gemini, falling back only when the primary model has a
// temporary availability or quota-related failure.
async function requestQuestionBatch(count, history) {
    const prompt = `
You create VERY EASY world trivia for an international community.

Generate exactly ${count} multiple-choice questions.

WORLD TOPIC RULES:
- Questions can be about ANY recognizable world-related topic.
- A question should feel clearly connected to the world, countries, places,
  people, cultures, nature, history, or how our planet works.
- Do NOT require every question to name a country.
- A question may be about a country, city, capital, flag, landmark, food,
  language, festival, tradition, famous historical person, invention,
  animal, habitat, continent, ocean, river, mountain, desert, island, world sport, music, or another broadly recognizable
  world topic.
- Keep every question VERY EASY and beginner-friendly.
- Prefer common facts that a casual international audience may recognize.
- Avoid obscure facts, niche details, tricky wording, and specialist knowledge.
- Use stable, verifiable facts; avoid current affairs and disputed claims.
- Keep questions short, direct, and natural: ideally 8–15 words, maximum 120 characters.
- Keep EVERY answer option concise: ideally 1–4 words, maximum 35 characters.
- Never use long descriptive sentences as answer options. Prefer a short name, place, object, or phrase.
- Keep explanations to one short sentence, maximum 160 characters.
- Spread questions across different regions and subject areas.
- Each question must test a distinct underlying fact, not merely rephrase
  another question.
- Provide exactly four distinct options and exactly one correct answer.
- correctAnswer is the zero-based index (0-3) of the correct option.
- Keep options plausible and similar in length and grammar.
- Each option must be 35 characters or fewer; use short labels rather than explanations.
- Never use "all of the above" or "none of the above".
- Include a short, accurate explanation, category, and specific subject.
- The category must be one of these:
  ${CATEGORIES.join(', ')}
- Return only JSON matching the provided schema.

Previously used questions and subjects — avoid repeating these facts:
${history.slice(-250).join('\n') || 'None provided'}

Before returning the JSON, check that each question is easy, factually accurate,
clearly world-related, and not a rewording of a previously used fact.
`;

    const config = {
        responseMimeType: 'application/json',
        responseSchema: {
            type: 'OBJECT',
            properties: {
                questions: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            question: { type: 'STRING' },
                            options: {
                                type: 'ARRAY',
                                items: { type: 'STRING' },
                            },
                            correctAnswer: { type: 'INTEGER' },
                            explanation: { type: 'STRING' },
                            category: { type: 'STRING' },
                            subject: { type: 'STRING' },
                        },
                        required: [
                            'question', 'options', 'correctAnswer',
                            'explanation', 'category', 'subject',
                        ],
                    },
                },
            },
            required: ['questions'],
        },
        maxOutputTokens: 10000,
    };

    try {
        const response = await ai.models.generateContent({
            model: PRIMARY_MODEL,
            contents: prompt,
            config,
        });

        return JSON.parse(response.text || '{}').questions || [];
    } catch (error) {
        if (!isTemporaryAIError(error)) throw error;

        console.warn(
            `[weekly] ${PRIMARY_MODEL} temporarily unavailable; trying ${FALLBACK_MODEL}.`
        );

        const response = await ai.models.generateContent({
            model: FALLBACK_MODEL,
            contents: prompt,
            config,
        });

        return JSON.parse(response.text || '{}').questions || [];
    }
}

// Normalize option text so duplicates are detected despite differences in
// capitalization, punctuation, or extra whitespace.
function normalizeForMatching(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

// Validate and normalize one generated question before it enters the pool.
function validateQuestion(raw) {
    if (
        !raw ||
        typeof raw.question !== 'string' ||
        typeof raw.subject !== 'string'
    ) {
        return null;
    }

    const question = raw.question.trim();
    const subject = raw.subject.trim();
    const options = Array.isArray(raw.options)
        ? raw.options.map((option) => String(option).trim())
        : [];

    // Reject verbose questions so lengthy generated text never reaches the quiz UI.
    if (question.length < 10 || question.length > 120 || subject.length < 2) {
        return null;
    }

    // Reject overly long options instead of truncating them on Discord buttons.
    if (
        options.length !== 4 ||
        options.some((option) => !option || option.length > 35)
    ) return null;

    if (new Set(options.map((option) => normalizeForMatching(option))).size !== 4) {
        return null;
    }

    if (
        !Number.isInteger(raw.correctAnswer) ||
        raw.correctAnswer < 0 ||
        raw.correctAnswer > 3
    ) {
        return null;
    }

    if (!CATEGORIES.includes(raw.category)) return null;

    if (
        typeof raw.explanation !== 'string' ||
        raw.explanation.trim().length < 8 ||
        raw.explanation.trim().length > 160
    ) {
        return null;
    }

    const questionHash = hashQuestion(question);
    const subjectHash = hashSubject(subject);

    return {
        id: questionHash,
        question,
        options,
        correctAnswer: raw.correctAnswer,
        explanation: raw.explanation.trim(),
        category: raw.category,
        subject,
        questionHash,
        subjectHash,
    };
}

// Generate a fresh pool, retrying when Gemini returns invalid or repeated items.
// The existing Redis helpers preserve duplicate history across competitions.
async function buildWeeklyPool(poolSize = DEFAULT_POOL_SIZE) {
    if (!process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is not configured.');
    }

    const accepted = [];
    const questionHashes = new Set();
    const subjectHashes = new Set();

    const [previousSubjects, previousQuestions] = await Promise.all([
        R.getUsedSubjectNames(),
        R.getUsedQuestionTexts(),
    ]);

    const history = [
        ...(previousSubjects || [])
            .slice(-250)
            .map((subject) => `Previously used subject: ${subject}`),
        ...(previousQuestions || [])
            .slice(-250)
            .map((question) => `Previously used question: ${question}`),
    ];

    for (
        let attempt = 1;
        attempt <= MAX_GENERATION_ATTEMPTS && accepted.length < poolSize;
        attempt++
    ) {
        const remaining = poolSize - accepted.length;
        const requestCount = Math.min(QUESTIONS_PER_AI_REQUEST, remaining + 5);
        const generated = await requestQuestionBatch(requestCount, history);

        for (const raw of generated) {
            if (accepted.length >= poolSize) break;

            const question = validateQuestion(raw);
            if (!question) continue;

            if (
                questionHashes.has(question.questionHash) ||
                subjectHashes.has(question.subjectHash)
            ) {
                continue;
            }

            const [questionUsed, subjectUsed] = await Promise.all([
                R.hasQuestionBeenUsed(question.questionHash),
                R.hasSubjectBeenUsed(question.subjectHash),
            ]);

            if (questionUsed || subjectUsed) continue;

            questionHashes.add(question.questionHash);
            subjectHashes.add(question.subjectHash);

            history.push(
                `${question.category} | ${question.subject} | ${question.question}`
            );

            accepted.push(question);
        }

        console.log(
            `[weekly] Generation attempt ${attempt}: ` +
            `${accepted.length}/${poolSize} unique world questions accepted.`
        );
    }

    if (accepted.length !== poolSize) {
        throw new Error(
            `Only ${accepted.length}/${poolSize} fresh world questions could be generated. ` +
            'Please try again shortly.'
        );
    }

    await R.markQuestionsAndSubjectsUsed(accepted);
    return accepted;
}

module.exports = {
    buildWeeklyPool,
    TARGET: DEFAULT_POOL_SIZE,
};
