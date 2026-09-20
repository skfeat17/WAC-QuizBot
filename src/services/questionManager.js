// src/services/questionManager.js

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

const POOL_PREFIX =
    "wac:pool:";

const QUESTION_PREFIX =
    "wac:question:";

const FACT_PREFIX =
    "wac:fact:";

const REFILL_LOCK_PREFIX =
    "wac:lock:refill:";


/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const REFILL_THRESHOLD = 20;

const REFILL_BATCH_SIZE = 50;

const REFILL_LOCK_TTL = 120;


/*
|--------------------------------------------------------------------------
| Topics
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


/*
|--------------------------------------------------------------------------
| Difficulties
|--------------------------------------------------------------------------
*/

const DIFFICULTIES = [
    "easy",
    "medium",
    "hard",
];


/*
|--------------------------------------------------------------------------
| Pool key
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
| Refill lock key
|--------------------------------------------------------------------------
*/

function refillLockKey(
    region,
    topic,
    difficulty
) {

    return `${REFILL_LOCK_PREFIX}${region}:${topic}:${difficulty}`;
}


/*
|--------------------------------------------------------------------------
| Question ID
|--------------------------------------------------------------------------
*/

function questionId(
    question
) {

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
| Fact ID
|--------------------------------------------------------------------------
*/

function factId(
    factKey
) {

    return factKey
        .toLowerCase()
        .trim()
        .replace(
            /[^a-z0-9_]/g,
            "_"
        );
}


/*
|--------------------------------------------------------------------------
| Shuffle options
|--------------------------------------------------------------------------
*/

function shuffleQuestionOptions(
    question
) {

    if (
        !question ||
        !Array.isArray(
            question.options
        ) ||
        question.options.length !== 4
    ) {

        return question;
    }


    const shuffled =
        question.options.map(
            (option, index) => ({

                text:
                    option,

                isCorrect:
                    index ===
                    question.correctAnswer,
            })
        );


    /*
    |--------------------------------------------------------------------------
    | Fisher-Yates
    |--------------------------------------------------------------------------
    */

    for (
        let i =
            shuffled.length - 1;

        i > 0;

        i--
    ) {

        const j =
            Math.floor(
                Math.random() *
                (i + 1)
            );


        [
            shuffled[i],
            shuffled[j],
        ] = [
            shuffled[j],
            shuffled[i],
        ];
    }


    const newCorrectAnswer =
        shuffled.findIndex(
            option =>
                option.isCorrect
        );


    return {

        ...question,

        options:
            shuffled.map(
                option =>
                    option.text
            ),

        correctAnswer:
            newCorrectAnswer,
    };
}


/*
|--------------------------------------------------------------------------
| Get pool size
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
| Add question
|--------------------------------------------------------------------------
|
| Every question is saved independently.
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

    /*
    |--------------------------------------------------------------------------
    | Basic validation
    |--------------------------------------------------------------------------
    */

    if (
        !question ||
        !factKey ||
        !Array.isArray(options) ||
        options.length !== 4 ||
        typeof correctAnswer !==
            "number"
    ) {

        console.log(
            "⚠️ Invalid question rejected before Redis."
        );

        return false;
    }


    /*
    |--------------------------------------------------------------------------
    | IDs
    |--------------------------------------------------------------------------
    */

    const qId =
        questionId(
            question
        );

    const fId =
        factId(
            factKey
        );


    const questionKey =
        `${QUESTION_PREFIX}${qId}`;

    const factKeyName =
        `${FACT_PREFIX}${fId}`;


    /*
    |--------------------------------------------------------------------------
    | Duplicate question
    |--------------------------------------------------------------------------
    */

    const questionExists =
        await redis.exists(
            questionKey
        );


    if (questionExists) {

        console.log(
            `⚠️ Duplicate question skipped: ${question}`
        );

        return false;
    }


    /*
    |--------------------------------------------------------------------------
    | Duplicate fact
    |--------------------------------------------------------------------------
    */

    const factExists =
        await redis.exists(
            factKeyName
        );


    if (factExists) {

        console.log(
            `⚠️ Duplicate fact skipped: ${factKey}`
        );

        return false;
    }


    /*
    |--------------------------------------------------------------------------
    | Store canonical question
    |--------------------------------------------------------------------------
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
    |--------------------------------------------------------------------------
    | Fact → question mapping
    |--------------------------------------------------------------------------
    */

    await redis.set(
        factKeyName,
        qId
    );


    /*
    |--------------------------------------------------------------------------
    | Add to pool
    |--------------------------------------------------------------------------
    */

    const key =
        poolKey(
            region,
            topic,
            difficulty
        );


    await redis.rpush(
        key,
        qId
    );


    /*
    |--------------------------------------------------------------------------
    | Current pool count
    |--------------------------------------------------------------------------
    */

    const currentCount =
        await redis.llen(
            key
        );


    console.log(
        `✅ Valid question found | Added to Redis | Redis current question count: ${currentCount}`
    );


    return true;
}


/*
|--------------------------------------------------------------------------
| Get question from one pool
|--------------------------------------------------------------------------
*/

async function getFromPool(
    region,
    topic,
    difficulty
) {

    const key =
        poolKey(
            region,
            topic,
            difficulty
        );


    /*
    |--------------------------------------------------------------------------
    | Atomically remove one question
    |--------------------------------------------------------------------------
    */

    const qId =
        await redis.lpop(
            key
        );


    if (!qId) {

        console.log(
            `⚠️ Redis pool empty | ${region} / ${topic} / ${difficulty}`
        );

        return null;
    }


    /*
    |--------------------------------------------------------------------------
    | Remaining count
    |--------------------------------------------------------------------------
    */

    const remaining =
        await redis.llen(
            key
        );


    console.log(
        `📦 Redis current question count: ${remaining} | ${region} / ${topic} / ${difficulty}`
    );


    /*
    |--------------------------------------------------------------------------
    | Trigger background refill
    |--------------------------------------------------------------------------
    |
    | <= 20 → refill
    |
    | This is NOT awaited.
    |
    |--------------------------------------------------------------------------
    */

    if (
        remaining <=
        REFILL_THRESHOLD
    ) {

        void startBackgroundRefill(
            region,
            topic,
            difficulty
        );
    }


    /*
    |--------------------------------------------------------------------------
    | Retrieve question
    |--------------------------------------------------------------------------
    */

    const question =
        await redis.get(
            `${QUESTION_PREFIX}${qId}`
        );


    /*
    |--------------------------------------------------------------------------
    | Missing question safety
    |--------------------------------------------------------------------------
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


    /*
    |--------------------------------------------------------------------------
    | Shuffle returned copy
    |--------------------------------------------------------------------------
    */

    const shuffledQuestion =
        shuffleQuestionOptions(
            question
        );


    console.log(
        `🔀 Options shuffled | Correct option index: ${shuffledQuestion.correctAnswer}`
    );


    return shuffledQuestion;
}


/*
|--------------------------------------------------------------------------
| Background refill
|--------------------------------------------------------------------------
|
| Only one refill per pool can run at a time.
|
|--------------------------------------------------------------------------
*/

async function startBackgroundRefill(
    region,
    topic,
    difficulty
) {

    /*
    |--------------------------------------------------------------------------
    | Mixed is never a real Redis pool.
    |--------------------------------------------------------------------------
    */

    if (
        topic === "mixed" ||
        difficulty === "mixed"
    ) {

        return;
    }


    const key =
        poolKey(
            region,
            topic,
            difficulty
        );


    /*
    |--------------------------------------------------------------------------
    | Check pool
    |--------------------------------------------------------------------------
    */

    const currentSize =
        await redis.llen(
            key
        );


    /*
    | More than 20 → nothing to generate.
    */

    if (
        currentSize >
        REFILL_THRESHOLD
    ) {

        return;
    }


    /*
    |--------------------------------------------------------------------------
    | Distributed lock
    |--------------------------------------------------------------------------
    */

    const lockKey =
        refillLockKey(
            region,
            topic,
            difficulty
        );


    const lock =
        await redis.set(
            lockKey,
            Date.now().toString(),
            {
                nx: true,
                ex: REFILL_LOCK_TTL,
            }
        );


    /*
    | Another process is already generating.
    */

    if (!lock) {

        console.log(
            `⏳ Refill already running | ${region} / ${topic} / ${difficulty}`
        );

        return;
    }


    console.log(
        `🔄 Background generation started | ${region} / ${topic} / ${difficulty} | Redis current question count: ${currentSize}`
    );


    try {

        /*
        |--------------------------------------------------------------------------
        | Load AI lazily
        |--------------------------------------------------------------------------
        |
        | Avoid circular dependency.
        |--------------------------------------------------------------------------
        */

        const {
            generateQuestionBatch,
        } = require("./ai");


        if (
            typeof generateQuestionBatch !==
            "function"
        ) {

            throw new Error(
                "generateQuestionBatch() is not available in ai.js"
            );
        }


        /*
        |--------------------------------------------------------------------------
        | Generate 50 in background
        |--------------------------------------------------------------------------
        |
        | Each valid question is saved immediately
        | by ai.js.
        |--------------------------------------------------------------------------
        */

        await generateQuestionBatch(
            region,
            topic,
            difficulty,
            {
                target:
                    REFILL_BATCH_SIZE,
            }
        );


        /*
        |--------------------------------------------------------------------------
        | Final count
        |--------------------------------------------------------------------------
        */

        const finalCount =
            await redis.llen(
                key
            );


        console.log(
            `✅ Background generation finished | ${region} / ${topic} / ${difficulty} | Redis current question count: ${finalCount}`
        );

    } catch (error) {

        /*
        |--------------------------------------------------------------------------
        | Do NOT remove successful questions.
        |--------------------------------------------------------------------------
        */

        const currentCount =
            await redis.llen(
                key
            );


        console.error(
            `⚠️ Background generation stopped | ${region} / ${topic} / ${difficulty} | Redis current question count: ${currentCount} | ${error?.message || error}`
        );

    } finally {

        /*
        |--------------------------------------------------------------------------
        | Release lock
        |--------------------------------------------------------------------------
        */

        await redis.del(
            lockKey
        );
    }
}


/*
|--------------------------------------------------------------------------
| Get question
|--------------------------------------------------------------------------
*/

async function getQuestion(
    region,
    topic,
    difficulty
) {

    /*
    |--------------------------------------------------------------------------
    | Specific topic + difficulty
    |--------------------------------------------------------------------------
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
    |--------------------------------------------------------------------------
    | Determine topics
    |--------------------------------------------------------------------------
    */

    const topics =
        topic === "mixed"
            ? [...TOPICS]
            : [topic];


    /*
    |--------------------------------------------------------------------------
    | Determine difficulties
    |--------------------------------------------------------------------------
    */

    const difficulties =
        difficulty === "mixed"
            ? [...DIFFICULTIES]
            : [difficulty];


    /*
    |--------------------------------------------------------------------------
    | Create pool list
    |--------------------------------------------------------------------------
    */

    const pools = [];


    for (
        const currentTopic
        of topics
    ) {

        for (
            const currentDifficulty
            of difficulties
        ) {

            pools.push({

                topic:
                    currentTopic,

                difficulty:
                    currentDifficulty,
            });
        }
    }


    /*
    |--------------------------------------------------------------------------
    | Randomize
    |--------------------------------------------------------------------------
    */

    pools.sort(
        () =>
            Math.random() -
            0.5
    );


    /*
    |--------------------------------------------------------------------------
    | Search pools
    |--------------------------------------------------------------------------
    */

    for (
        const pool
        of pools
    ) {

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
    |--------------------------------------------------------------------------
    | Nothing available
    |--------------------------------------------------------------------------
    */

    return null;
}


/*
|--------------------------------------------------------------------------
| Total question count
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

    startBackgroundRefill,

    REFILL_THRESHOLD,

    REFILL_BATCH_SIZE,

    TOPICS,

    DIFFICULTIES,
};