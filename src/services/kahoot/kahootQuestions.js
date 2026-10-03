const {
    getKahoot,
    getQuestions,
    addQuestion,
    updateQuestion,
    removeQuestion,
} = require("./kahootRedis");

function validateQuestionInput(data) {
    if (!data.question?.trim()) {
        throw new Error("Question is required.");
    }

    if (!Array.isArray(data.options) || data.options.length !== 4) {
        throw new Error("Exactly 4 answers are required.");
    }

    if (data.options.some((x) => !String(x).trim())) {
        throw new Error("All 4 answers are required.");
    }

    const correctIndex = Number(data.correctIndex);

    if (
        !Number.isInteger(correctIndex) ||
        correctIndex < 0 ||
        correctIndex > 3
    ) {
        throw new Error("Correct answer must be 1, 2, 3, or 4.");
    }

    return {
        question: data.question.trim(),
        options: data.options.map((x) => String(x).trim()),
        correctIndex,
        imageUrl: data.imageUrl?.trim() || null,
    };
}

async function createQuestion(kahootId, data) {
    const kahoot = await getKahoot(kahootId);

    if (!kahoot) throw new Error("Kahoot not found.");
    if (kahoot.status !== "created") {
        throw new Error("Questions can only be changed before the Kahoot starts.");
    }

    return await addQuestion(kahootId, validateQuestionInput(data));
}

async function modifyQuestion(kahootId, questionId, data) {
    const kahoot = await getKahoot(kahootId);

    if (!kahoot) throw new Error("Kahoot not found.");

    const current = await getQuestions(kahootId);
    const existing = current.find((q) => Number(q.id) === Number(questionId));

    if (!existing) throw new Error("Question not found.");

    return await updateQuestion(
        kahootId,
        questionId,
        validateQuestionInput(data)
    );
}

async function deleteQuestion(kahootId, questionId) {
    const kahoot = await getKahoot(kahootId);

    if (!kahoot) throw new Error("Kahoot not found.");

    const removed = await removeQuestion(kahootId, questionId);

    if (!removed) throw new Error("Question not found.");

    return true;
}

module.exports = {
    createQuestion,
    modifyQuestion,
    deleteQuestion,
    validateQuestionInput,
};
