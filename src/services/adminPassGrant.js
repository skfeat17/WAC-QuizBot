const { awardPass } = require("./worldPass/worldPassRedis");

// Replace with your Discord user ID
const ADMIN_USER_ID = "759810328791482428";

async function giveMyPasses() {
    if (!ADMIN_USER_ID) {
        throw new Error("Admin user ID is missing.");
    }

    const passes = [
        { tier: "explorer", amount: 50 },
        { tier: "voyager", amount: 50 },
        { tier: "pathfinder", amount: 30 },
        { tier: "discoverer", amount: 20 },
        { tier: "celestial", amount: 10 },
    ];

    for (const pass of passes) {
        for (let i = 0; i < pass.amount; i++) {
            const grantId =
                `ADMIN-GRANT-${pass.tier}-${Date.now()}-${i}`;

            await awardPass(
                ADMIN_USER_ID,
                pass.tier,
                grantId
            );
        }
    }

    console.log("🎟️ Admin passes awarded successfully!");
}

giveMyPasses().catch(console.error);