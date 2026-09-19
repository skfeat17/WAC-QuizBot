const { Redis } = require("@upstash/redis");
const crypto = require("crypto");

/*
|--------------------------------------------------------------------------
| Redis
|--------------------------------------------------------------------------
*/

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});


/*
|--------------------------------------------------------------------------
| Redis key prefixes
|--------------------------------------------------------------------------
*/

const POOL_PREFIX = "wac:pool:";
const QUESTION_PREFIX = "wac:question:";
const FACT_PREFIX = "wac:fact:";


/*
|--------------------------------------------------------------------------
| Available quiz categories
|--------------------------------------------------------------------------
*/

const TOPICS = [
    "geography",
    "food",
    "history",
    "culture",
    "language",
    "nature",
    "landmarks",
];

const DIFFICULTIES = [
    "easy",
    "medium",
    "hard",
];


/*
|--------------------------------------------------------------------------
| Create Redis pool key
|--------------------------------------------------------------------------
*/

function poolKey(
    region,
    topic,
    difficulty
) {
    return `${POOL_PREFIX}${region}:${topic}:${difficulty}`;
}


/*
|--------------------------------------------------------------------------
| Create unique question ID
|--------------------------------------------------------------------------
*/

function questionId(question) {
    return crypto
        .createHash("sha256")
        .update(
            question
                .toLowerCase()
                .trim()
        )
        .digest("hex")
        .slice(0, 16);
}


/*
|--------------------------------------------------------------------------
| Create normalized fact ID
|--------------------------------------------------------------------------
*/

function factId(factKey) {
    return factKey
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9_]/g, "_");
}


/*
|--------------------------------------------------------------------------
| Save question
|--------------------------------------------------------------------------
|
| Returns:
| true  → newly saved
| false → already exists
|
|--------------------------------------------------------------------------
*/

async function addQuestion({
    question,
    factKey,
    options,
    correctAnswer,
    explanation,
    region,
    topic,
    difficulty,
}) {
    const qId = questionId(question);
    const fId = factId(factKey);

    const questionKey =
        `${QUESTION_PREFIX}${qId}`;

    const factKeyName =
        `${FACT_PREFIX}${fId}`;

    /*
     * Check whether this exact question
     * already exists.
     */

    const questionExists =
        await redis.exists(questionKey);

    if (questionExists) {
        console.log(
            `⚠️ Question already exists: ${question}`
        );

        return false;
    }


    /*
     * Check whether the underlying fact
     * already exists.
     */

    const factExists =
        await redis.exists(factKeyName);

    if (factExists) {
        console.log(
            `⚠️ Fact already exists: ${factKey}`
        );

        return false;
    }


    /*
     * Store complete question.
     */

    const data = {
        question,
        factKey,
        options,
        correctAnswer,
        explanation,
        region,
        topic,
        difficulty,
    };

    await redis.set(
        questionKey,
        data
    );


    /*
     * Map fact → question.
     */

    await redis.set(
        factKeyName,
        qId
    );


    /*
     * Add question ID to the correct
     * Redis pool.
     */

    await redis.rpush(
        poolKey(
            region,
            topic,
            difficulty
        ),
        qId
    );

    return true;
}


/*
|--------------------------------------------------------------------------
| Get one question from a specific pool
|--------------------------------------------------------------------------
*/

async function getFromPool(
    region,
    topic,
    difficulty
) {
    const key = poolKey(
        region,
        topic,
        difficulty
    );

    /*
     * Remove the question from the unused pool.
     *
     * This means once a question is used,
     * it won't be selected again.
     */

    const qId = await redis.lpop(key);

    if (!qId) {
        return null;
    }


    /*
     * Retrieve complete question.
     */

    const question =
        await redis.get(
            `${QUESTION_PREFIX}${qId}`
        );


    /*
     * Safety check in case the question
     * was somehow deleted from Redis.
     */

    if (!question) {
        console.log(
            `⚠️ Missing question data for ID: ${qId}`
        );

        return getFromPool(
            region,
            topic,
            difficulty
        );
    }

    return question;
}


/*
|--------------------------------------------------------------------------
| Get question
|--------------------------------------------------------------------------
|
| Specific request:
|
|   geography + easy
|       ↓
|   geography/easy pool
|
| Mixed request:
|
|   mixed + mixed
|       ↓
|   search multiple real pools
|
|--------------------------------------------------------------------------
*/

async function getQuestion(
    region,
    topic,
    difficulty
) {
    /*
     * ------------------------------------------------
     * CASE 1:
     * Specific topic + specific difficulty
     * ------------------------------------------------
     */

    if (
        topic !== "mixed" &&
        difficulty !== "mixed"
    ) {
        return getFromPool(
            region,
            topic,
            difficulty
        );
    }


    /*
     * ------------------------------------------------
     * CASE 2:
     * Determine possible topics
     * ------------------------------------------------
     */

    const topics =
        topic === "mixed"
            ? [...TOPICS]
            : [topic];


    /*
     * ------------------------------------------------
     * CASE 3:
     * Determine possible difficulties
     * ------------------------------------------------
     */

    const difficulties =
        difficulty === "mixed"
            ? [...DIFFICULTIES]
            : [difficulty];


    /*
     * ------------------------------------------------
     * Create all possible pools
     * ------------------------------------------------
     */

    const pools = [];

    for (const currentTopic of topics) {
        for (
            const currentDifficulty
            of difficulties
        ) {
            pools.push({
                topic: currentTopic,
                difficulty:
                    currentDifficulty,
            });
        }
    }


    /*
     * Randomize pool order.
     *
     * This prevents mixed quizzes from
     * always preferring geography/easy.
     */

    pools.sort(
        () => Math.random() - 0.5
    );


    /*
     * ------------------------------------------------
     * Search for an unused question
     * ------------------------------------------------
     */

    for (const pool of pools) {
        const question =
            await getFromPool(
                region,
                pool.topic,
                pool.difficulty
            );

        if (question) {
            console.log(
                `⚡ Mixed quiz loaded from: ${pool.topic} / ${pool.difficulty}`
            );

            return question;
        }
    }


    /*
     * No suitable question exists.
     *
     * IMPORTANT:
     *
     * We return null here.
     *
     * generateQuiz() will decide which
     * concrete pool Gemini should generate.
     */

    return null;
}


/*
|--------------------------------------------------------------------------
| Get number of unused questions
|--------------------------------------------------------------------------
*/

async function getPoolSize(
    region,
    topic,
    difficulty
) {
    return await redis.llen(
        poolKey(
            region,
            topic,
            difficulty
        )
    );
}


/*
|--------------------------------------------------------------------------
| Get total number of questions
|--------------------------------------------------------------------------
*/

async function getTotalQuestionCount() {
    const keys =
        await redis.keys(
            `${QUESTION_PREFIX}*`
        );

    return keys.length;
}


/*
|--------------------------------------------------------------------------
| Exports
|--------------------------------------------------------------------------
*/

module.exports = {
    addQuestion,
    getQuestion,
    getPoolSize,
    getTotalQuestionCount,
    TOPICS,
    DIFFICULTIES,
};