require("dotenv").config();

const {
    saveQuestion,
    questionExists,
    getQuestionCount,
} = require("./src/services/questionManager");

async function test() {
    console.log("Testing Redis...");

    const question =
        "Which country is home to Mount Fuji?";

    console.log(
        "Before:",
        await questionExists(question)
    );

    const saved = await saveQuestion({
        question,
        region: "east_asia",
        topic: "geography",
        difficulty: "easy",
    });

    console.log("Saved:", saved);

    console.log(
        "After:",
        await questionExists(question)
    );

    console.log(
        "Total questions:",
        await getQuestionCount()
    );
}

test().catch(console.error);