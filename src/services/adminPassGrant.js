
const {
    setPassInventory,
} = require("./worldPass/worldPassRedis");

const ADMIN_USER_ID = "759810328791482428";

async function setMyPasses() {
    const passes = {
        explorer: 100,
        voyager: 100,
        pathfinder: 100,
        discoverer: 100,
        celestial: 100,
    };

    const updated = await setPassInventory(
        ADMIN_USER_ID,
        passes
    );

    console.log("🎟️ World Pass inventory replaced successfully!");
    console.log(updated);
}

setMyPasses().catch(console.error);
