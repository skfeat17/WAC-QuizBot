
const {
    setPassInventory,
} = require("./worldPass/worldPassRedis");

const ADMIN_USER_ID = "1242132608574292118";

async function setMyPasses() {
    const passes = {
        explorer: 0,
        voyager: 0,
        pathfinder: 0,
        discoverer: 0,
        celestial: 0,
    };

    const updated = await setPassInventory(
        ADMIN_USER_ID,
        passes
    );

    console.log("🎟️ World Pass inventory replaced successfully!");
    console.log(updated);
}

setMyPasses().catch(console.error);
