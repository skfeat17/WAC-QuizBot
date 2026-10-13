

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateReward() {
    const roll = Math.random() * 100;

    if (roll < 80) {
        return randomInt(20, 22); // 80%
    }

    if (roll < 90) {
        return randomInt(23, 25); // 10%
    }

    if (roll < 94) {
        return randomInt(26, 30); // 4%
    }

    if (roll < 97) {
        return randomInt(31, 35); // 3%
    }

    if (roll < 99) {
        return randomInt(36, 40); // 2%
    }

    return randomInt(41, 50); // 1%
}

// CONFIGURATION
const TOTAL_ROLLS = 1000;

// REWARD TIERS
const tiers = [
    { name: "20–22 Mora", min: 20, max: 22 },
    { name: "23–25 Mora", min: 23, max: 25 },
    { name: "26–30 Mora", min: 26, max: 30 },
    { name: "31–35 Mora", min: 31, max: 35 },
    { name: "36–40 Mora", min: 36, max: 40 },
    { name: "41–50 Mora", min: 41, max: 50 }
];

// TRACKING
const results = [];
const counts = {};
const tierCounts = {};

let totalMora = 0;

for (const tier of tiers) {
    tierCounts[tier.name] = 0;

    for (let reward = tier.min; reward <= tier.max; reward++) {
        counts[reward] = 0;
    }
}

// SIMULATION
for (let i = 0; i < TOTAL_ROLLS; i++) {
    const reward = generateReward();

    results.push(reward);
    counts[reward]++;
    totalMora += reward;

    const tier = tiers.find(
        t => reward >= t.min && reward <= t.max
    );

    tierCounts[tier.name]++;
}

// DISPLAY EVERY ROLL
console.log("\n========== ALL REWARD ROLLS ==========\n");

results.forEach((reward, index) => {
    console.log(`Roll ${(index + 1).toString().padStart(4)}: ${reward} Mora`);
});

// DISPLAY INDIVIDUAL REWARD FREQUENCIES
console.log("\n========== INDIVIDUAL REWARD COUNTS ==========\n");

for (const [reward, count] of Object.entries(counts)) {
    const percentage = (count / TOTAL_ROLLS * 100).toFixed(2);

    console.log(
        `${reward.padStart(2)} Mora: ${count.toString().padStart(4)} times (${percentage}%)`
    );
}

// DISPLAY TIER STATISTICS
console.log("\n========== REWARD TIER STATISTICS ==========\n");

for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const count = tierCounts[tier.name];
    const actualPercentage = (count / TOTAL_ROLLS * 100).toFixed(2);

    const probabilities = [75, 15, 4, 3, 2, 1];

    console.log(
        `${tier

        }.name.padEnd(12)}: ${count.toString().padStart(4)} times (${actualPercentage}%) | Expected: ${probabilities[i]}%`
    );
}