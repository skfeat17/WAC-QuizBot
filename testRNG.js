function generateReward() {
    const roll = Math.random() * 100;

    if (roll < 87) {
        return Math.floor(Math.random() * 6) + 10; // 10-15 | 87%
    }

    if (roll < 95) {
        return Math.floor(Math.random() * 5) + 16; // 16-20 | 8%
    }

    if (roll < 99) {
        return Math.floor(Math.random() * 5) + 21; // 21-25 | 4%
    }

    return Math.floor(Math.random() * 5) + 26; // 26-30 | 1%
}

function testRewards(iterations = 100000) {
    const counts = {
        "10-15": 0,
        "16-20": 0,
        "21-25": 0,
        "26-30": 0,
    };

    let total = 0;

    for (let i = 0; i < iterations; i++) {
        const reward = generateReward();

        total += reward;

        if (reward >= 10 && reward <= 15) {
            counts["10-15"]++;
        } else if (reward >= 16 && reward <= 20) {
            counts["16-20"]++;
        } else if (reward >= 21 && reward <= 25) {
            counts["21-25"]++;
        } else if (reward >= 26 && reward <= 30) {
            counts["26-30"]++;
        }
    }

    console.log("\n🎁 REWARD TEST");
    console.log("==============================");
    console.log(`Iterations: ${iterations}`);

    console.log("\n📊 DISTRIBUTION");

    console.log(
        `10-15: ${counts["10-15"]} (${((counts["10-15"] / iterations) * 100).toFixed(2)}%)`
    );

    console.log(
        `16-20: ${counts["16-20"]} (${((counts["16-20"] / iterations) * 100).toFixed(2)}%)`
    );

    console.log(
        `21-25: ${counts["21-25"]} (${((counts["21-25"] / iterations) * 100).toFixed(2)}%)`
    );

    console.log(
        `26-30: ${counts["26-30"]} (${((counts["26-30"] / iterations) * 100).toFixed(2)}%)`
    );

    console.log("\n💰 AVERAGE REWARD");
    console.log(
        `Average: ${(total / iterations).toFixed(2)} Mora`
    );

    console.log("==============================\n");
}

testRewards(100000);