const readline = require("readline");

// ==========================================
// TREASURE REWARD
// ==========================================

function getTreasureReward() {
const tiers = [
    { weight: 42, min: 25, max: 35 },  // 42%
    { weight: 22, min: 36, max: 50 },  // 22%
    { weight: 16, min: 51, max: 65 },  // 16%
    { weight: 10, min: 66, max: 75 },  // 10%
    { weight: 7,  min: 76, max: 90 },  // 7%
    { weight: 3,  min: 91, max: 100 }, // 3%
];
    let random = Math.random() * 100;

    for (const tier of tiers) {
        random -= tier.weight;

        if (random <= 0) {
            return randomInteger(tier.min, tier.max);
        }
    }

    return 25;
}

// ==========================================
// RANDOM INTEGER
// ==========================================

function randomInteger(min, max) {
    return Math.floor(
        Math.random() * (max - min + 1)
    ) + min;
}

// ==========================================
// TEST
// ==========================================

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

rl.question(
    "How many treasure openings? ",
    (input) => {

        const totalTests = Number(input);

        if (
            !Number.isInteger(totalTests) ||
            totalTests <= 0
        ) {
            console.log("❌ Invalid number.");
            rl.close();
            return;
        }

        const results = {};

        for (let amount = 25; amount <= 100; amount++) {
            results[amount] = 0;
        }

        let totalReward = 0;

        console.log("\n======================================");
        console.log("       TREASURE OPENING TEST");
        console.log("======================================\n");

        // ==========================================
        // SHOW EVERY RESULT
        // ==========================================

        for (let i = 1; i <= totalTests; i++) {

            const reward = getTreasureReward();

            results[reward]++;
            totalReward += reward;

            console.log(
                `#${String(i).padStart(5)} → 💰 ${reward} Mora`
            );
        }

        // ==========================================
        // SUMMARY
        // ==========================================

        console.log("\n\n======================================");
        console.log("          FINAL SUMMARY");
        console.log("======================================");

        console.log(
            `Total openings : ${totalTests.toLocaleString()}`
        );

        console.log(
            `Total Mora     : ${totalReward.toLocaleString()}`
        );

        console.log(
            `Average reward : ${(totalReward / totalTests).toFixed(2)} Mora`
        );

        console.log("\n--------------------------------------");
        console.log("REWARD DISTRIBUTION");
        console.log("--------------------------------------");

        for (let amount = 25; amount <= 100; amount++) {

            const count = results[amount];

            if (count === 0) continue;

            const percentage =
                (count / totalTests) * 100;

            console.log(
                `${String(amount).padStart(3)} Mora → ` +
                `${String(count).padStart(6)} times ` +
                `(${percentage.toFixed(3)}%)`
            );
        }

        // ==========================================
        // RANGE SUMMARY
        // ==========================================

        console.log("\n--------------------------------------");
        console.log("RANGE SUMMARY");
        console.log("--------------------------------------");

        const ranges = [
            ["25-35", 25, 35],
            ["36-50", 36, 50],
            ["51-65", 51, 65],
            ["66-75", 66, 75],
            ["76-90", 76, 90],
            ["91-100", 91, 100],
        ];

        for (const [name, min, max] of ranges) {

            let count = 0;

            for (
                let amount = min;
                amount <= max;
                amount++
            ) {
                count += results[amount];
            }

            const percentage =
                (count / totalTests) * 100;

            console.log(
                `${name.padEnd(8)} → ` +
                `${String(count).padStart(6)} times ` +
                `(${percentage.toFixed(3)}%)`
            );
        }

        console.log("\n======================================");

        rl.close();
    }
);