// kahootRedis.js
require("dotenv").config();
const { Redis } = require("@upstash/redis");

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PREFIX = "wac:kahoot:";
const INDEX_KEY = `${PREFIX}index`;
const ACTIVE_KEY = `${PREFIX}active`;

const key = (id) => `${PREFIX}${id}`;
const questionsKey = (id) => `${PREFIX}${id}:questions`;

const runKey = (id, runId) =>
    `${PREFIX}${id}:run:${runId}`;

const playersKey = (id, runId) =>
    `${runKey(id, runId)}:players`;

const answersKey = (id, runId, qid) =>
    `${runKey(id, runId)}:answers:${qid}`;

const usedKey = (id, runId) =>
    `${runKey(id, runId)}:used`;

const currentRunKey = (id) =>
    `${PREFIX}${id}:currentRun`;

async function createKahoot(data) {
    const id =
        `kh_${Date.now().toString(36)}_` +
        Math.random().toString(36).slice(2, 8);

    const kahoot = {
        id,
        name: data.name,
        status: "created",
        createdAt: Date.now(),
        createdBy: data.createdBy,

        settings: {
            questionTimer: 15,
            leaderboardTimer: 15,
        },

        rewards: {
            first: 0,
            second: 0,
            third: 0,
            fourth: 0,
            fifth: 0,
            participation: 0,
        },

        questionCount: 0,

        currentQuestionIndex: -1,
        currentQuestionId: null,
        currentMessageId: null,
        currentQuestionStartedAt: null,
        currentQuestionEndsAt: null,

        // Every Start creates a fresh run.
        runId: null,
        usedQuestionIds: [],
    };

    await redis.set(key(id), kahoot);
    await redis.sadd(INDEX_KEY, id);

    return kahoot;
}

async function getKahoot(id) {
    return await redis.get(key(id));
}

async function listKahoots() {
    const ids = await redis.smembers(INDEX_KEY);

    if (!ids?.length) return [];

    const result = [];

    for (const id of ids) {
        const item = await getKahoot(id);

        if (item) {
            result.push(item);
        }
    }

    return result.sort(
        (a, b) => b.createdAt - a.createdAt
    );
}

async function saveKahoot(kahoot) {
    await redis.set(key(kahoot.id), kahoot);
    return kahoot;
}

async function createKahootRun(id) {
    const runId =
        `run_${Date.now().toString(36)}_` +
        Math.random().toString(36).slice(2, 8);

    await redis.set(
        currentRunKey(id),
        runId
    );

    return runId;
}

async function getCurrentRunId(id) {
    return await redis.get(currentRunKey(id));
}

async function deleteKahoot(id) {
    const questions = await getQuestions(id);
    const currentRunId = await getCurrentRunId(id);

    const keys = [
        key(id),
        questionsKey(id),
        currentRunKey(id),

        // Old storage keys from previous versions.
        `${PREFIX}${id}:players`,
        `${PREFIX}${id}:used`,
    ];

    if (currentRunId) {
        keys.push(
            playersKey(id, currentRunId),
            usedKey(id, currentRunId)
        );

        for (const question of questions) {
            keys.push(
                answersKey(
                    id,
                    currentRunId,
                    question.id
                )
            );
        }
    }

    // Remove legacy answer keys too.
    for (const question of questions) {
        keys.push(
            `${PREFIX}${id}:answers:${question.id}`
        );
    }

    await redis.del(...keys);
    await redis.srem(INDEX_KEY, id);

    const active = await redis.get(ACTIVE_KEY);

    if (active === id) {
        await redis.del(ACTIVE_KEY);
    }
}

async function setActiveKahoot(id) {
    await redis.set(ACTIVE_KEY, id);
}

async function getActiveKahootId() {
    return await redis.get(ACTIVE_KEY);
}

async function clearActiveKahoot(id) {
    const active = await redis.get(ACTIVE_KEY);

    if (active === id) {
        await redis.del(ACTIVE_KEY);
    }
}

async function addQuestion(id, question) {
    const kahoot = await getKahoot(id);

    if (!kahoot) {
        throw new Error("Kahoot not found.");
    }

    const questions = await getQuestions(id);

    const nextId =
        questions.reduce(
            (max, q) =>
                Math.max(max, Number(q.id) || 0),
            0
        ) + 1;

    const item = {
        id: nextId,
        question: question.question,
        options: question.options,
        correctIndex: Number(question.correctIndex),
        imageUrl: question.imageUrl || null,
        createdAt: Date.now(),
    };

    questions.push(item);

    await redis.set(
        questionsKey(id),
        questions
    );

    kahoot.questionCount = questions.length;

    await saveKahoot(kahoot);

    return item;
}

async function getQuestions(id) {
    return (
        (await redis.get(questionsKey(id))) || []
    );
}

async function getQuestion(id, questionId) {
    const questions = await getQuestions(id);

    return (
        questions.find(
            (q) =>
                Number(q.id) ===
                Number(questionId)
        ) || null
    );
}

async function updateQuestion(
    id,
    questionId,
    patch
) {
    const questions = await getQuestions(id);

    const index = questions.findIndex(
        (q) =>
            Number(q.id) ===
            Number(questionId)
    );

    if (index === -1) {
        return null;
    }

    questions[index] = {
        ...questions[index],
        ...patch,
        id: questions[index].id,
        updatedAt: Date.now(),
    };

    await redis.set(
        questionsKey(id),
        questions
    );

    return questions[index];
}

async function removeQuestion(id, questionId) {
    const questions = await getQuestions(id);

    const filtered = questions.filter(
        (q) =>
            Number(q.id) !==
            Number(questionId)
    );

    if (filtered.length === questions.length) {
        return false;
    }

    await redis.set(
        questionsKey(id),
        filtered
    );

    const kahoot = await getKahoot(id);

    if (kahoot) {
        kahoot.questionCount =
            filtered.length;

        await saveKahoot(kahoot);
    }

    return true;
}

async function addPlayer(id, user) {
    const runId = await getCurrentRunId(id);

    if (!runId) {
        throw new Error(
            "Kahoot run is not initialized."
        );
    }

    const existing =
        (await redis.hget(
            playersKey(id, runId),
            user.id
        )) || null;

    /*
     * IMPORTANT:
     * Merge the incoming player object with
     * the stored player.
     *
     * This persists score/answer statistics.
     * The old implementation discarded those
     * modified values and caused the leaderboard
     * to remain at 0 points.
     */
    const player = existing
        ? {
              ...existing,
              ...user,
          }
        : {
              id: user.id,
              username: user.username,
              displayName:
                  user.displayName ||
                  user.username,
              score: 0,
              totalAnswerMs: 0,
              answeredQuestions: 0,
              correctAnswers: 0,
              participated: false,
              joinedAt: Date.now(),
              ...user,
          };

    await redis.hset(
        playersKey(id, runId),
        {
            [user.id]: player,
        }
    );

    return player;
}

async function getPlayer(id, userId) {
    const runId =
        await getCurrentRunId(id);

    if (!runId) {
        return null;
    }

    return (
        (await redis.hget(
            playersKey(id, runId),
            userId
        )) || null
    );
}

async function getPlayers(id) {
    const runId =
        await getCurrentRunId(id);

    if (!runId) {
        return [];
    }

    const data =
        (await redis.hgetall(
            playersKey(id, runId)
        )) || {};

    return Object.values(data);
}


/*
 * Atomically claim a user's answer slot for a question.
 *
 * HSETNX guarantees that only the first click from this
 * user for this question wins, even if two interactions
 * arrive at the same time.
 *
 * The field is stored in the same answer hash that saveAnswer()
 * uses, so no extra lock keys need to be cleaned up.
 */
async function claimAnswer(
    id,
    questionId,
    userId
) {
    const runId =
        await getCurrentRunId(id);

    if (!runId) {
        throw new Error(
            "Kahoot run is not initialized."
        );
    }

    return (
        Number(
            await redis.hsetnx(
                answersKey(
                    id,
                    runId,
                    questionId
                ),
                userId,
                JSON.stringify({
                    claimed: true,
                    userId,
                    claimedAt: Date.now(),
                })
            )
        ) === 1
    );
}

async function saveAnswer(
    id,
    questionId,
    answer
) {
    const runId =
        await getCurrentRunId(id);

    if (!runId) {
        throw new Error(
            "Kahoot run is not initialized."
        );
    }

    return await redis.hset(
        answersKey(
            id,
            runId,
            questionId
        ),
        {
            [answer.userId]: answer,
        }
    );
}

async function getAnswer(
    id,
    questionId,
    userId
) {
    const runId =
        await getCurrentRunId(id);

    if (!runId) {
        return null;
    }

    return await redis.hget(
        answersKey(
            id,
            runId,
            questionId
        ),
        userId
    );
}

async function markUsedQuestion(
    id,
    questionId
) {
    const runId =
        await getCurrentRunId(id);

    if (!runId) {
        throw new Error(
            "Kahoot run is not initialized."
        );
    }

    await redis.sadd(
        usedKey(id, runId),
        String(questionId)
    );
}

async function getUsedQuestions(id) {
    const runId =
        await getCurrentRunId(id);

    if (!runId) {
        return [];
    }

    return (
        (await redis.smembers(
            usedKey(id, runId)
        )) || []
    );
}

module.exports = {
    createKahoot,
    getKahoot,
    listKahoots,
    saveKahoot,
    deleteKahoot,

    createKahootRun,
    getCurrentRunId,

    setActiveKahoot,
    getActiveKahootId,
    clearActiveKahoot,

    addQuestion,
    getQuestions,
    getQuestion,
    updateQuestion,
    removeQuestion,

    addPlayer,
    getPlayer,
    getPlayers,

    saveAnswer,
    getAnswer,
    claimAnswer,

    markUsedQuestion,
    getUsedQuestions,
};
