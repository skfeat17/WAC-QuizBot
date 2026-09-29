function generateReward() {
    const roll = Math.random() * 100;

    if (roll < 70) {
        return Math.floor(Math.random() * 6) + 10; // 10-15
    }

    if (roll < 85) {
        return Math.floor(Math.random() * 6) + 15; // 15-20
    }

    if (roll < 95) {
        return Math.floor(Math.random() * 6) + 20; // 20-25
    }

    return Math.floor(Math.random() * 6) + 25; // 25-30
}

function testRewards(iterations = 100000) {
    const counts = {
        "10-15": 0,
        "15-20": 0,
        "20-25": 0,
        "25-30": 0,
    };

    let total = 0;

    for (let i = 0; i < iterations; i++) {
        const reward = generateReward();

        total += reward;

        if (reward >= 10 && reward <= 15) {
            counts["10-15"]++;
        } else if (reward >= 16 && reward <= 20) {
            counts["15-20"]++;
        } else if (reward >= 21 && reward <= 25) {
            counts["20-25"]++;
        } else if (reward >= 26 && reward <= 30) {
            counts["25-30"]++;
        }
    }

    console.log("\n🎁 REWARD TEST");
    console.log(`Iterations: ${iterations}`);

    console.log(
        `10-15: ${counts["10-15"]} (${((counts["10-15"] / iterations) * 100).toFixed(2)}%)`
    );

    console.log(
        `15-20: ${counts["15-20"]} (${((counts["15-20"] / iterations) * 100).toFixed(2)}%)`
    );

    console.log(
        `20-25: ${counts["20-25"]} (${((counts["20-25"] / iterations) * 100).toFixed(2)}%)`
    );

    console.log(
        `25-30: ${counts["25-30"]} (${((counts["25-30"] / iterations) * 100).toFixed(2)}%)`
    );

    console.log(
        `Average Reward: ${(total / iterations).toFixed(2)} Mora`
    );
}

testRewards(100000);