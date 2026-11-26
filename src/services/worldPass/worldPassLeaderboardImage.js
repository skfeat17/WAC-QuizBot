const fs = require("node:fs");
const {
    createCanvas,
    loadImage,
    GlobalFonts,
} = require("@napi-rs/canvas");

const {
    getAllPassInventories,
    getAllLifetimePassInventories,
} = require("./worldPassRedis");

// --------------------------------------------------
// EMOJI FONT SUPPORT
// --------------------------------------------------

const EMOJI_FONT_PATHS = [
    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
    "/usr/share/fonts/truetype/noto/NotoEmoji-Regular.ttf",
    "/usr/share/fonts/google-noto-emoji/NotoColorEmoji.ttf",
];

let emojiFontRegistered = false;

for (const fontPath of EMOJI_FONT_PATHS) {
    if (fs.existsSync(fontPath)) {
        try {
            GlobalFonts.registerFromPath(
                fontPath,
                "Noto Color Emoji"
            );

            emojiFontRegistered = true;

            console.log(
                `[WORLD PASS LEADERBOARD] Emoji font registered: ${fontPath}`
            );

            break;
        } catch (error) {
            console.warn(
                "[WORLD PASS LEADERBOARD] Emoji font registration failed:",
                error.message
            );
        }
    }
}

if (!emojiFontRegistered) {
    console.warn(
        "[WORLD PASS LEADERBOARD] Noto Emoji font not found. Install fonts-noto-color-emoji on Render."
    );
}

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

const WIDTH = 1000;
const HEIGHT = 1200;
const AVATAR_SIZE = 64;

const AVATAR_CACHE = new Map();

const COLORS = {
    gold: "#f3c969",
    text: "#edf1f8",
    muted: "#9ba8bd",
    panel: "#151e2e",
    panelAlt: "#111a29",
    line: "rgba(130,148,177,0.20)",

    explorer: "#e8b84f",
    voyager: "#38a9e8",
    pathfinder: "#57bd85",
    discoverer: "#4d8de8",
    celestial: "#e17ac4",
};

const TIER_ORDER = [
    "explorer",
    "voyager",
    "pathfinder",
    "discoverer",
    "celestial",
];

const TIER_EMOJIS = {
    explorer: "🧭",
    voyager: "🌊",
    pathfinder: "🗺️",
    discoverer: "💎",
    celestial: "🌟",
};

const TIER_NAMES = {
    explorer: "Explorer",
    voyager: "Voyager",
    pathfinder: "Pathfinder",
    discoverer: "Discoverer",
    celestial: "Celestial",
};

const MORA_VALUE_PER_PASS = {
    explorer: 5,
    voyager: 10,
    pathfinder: 15,
    discoverer: 30,
    celestial: 50,
};

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function roundedRect(ctx, x, y, width, height, radius = 14) {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
}

function formatNumber(value) {
    const number = Number(value || 0);

    return (
        Number.isFinite(number) ? number : 0
    ).toLocaleString("en-IN");
}

function fitText(
    ctx,
    value,
    maxWidth,
    initialSize = 18,
    minSize = 10
) {
    let size = initialSize;

    while (size > minSize) {
        ctx.font = `600 ${size}px Sans`;

        if (
            ctx.measureText(
                String(value ?? "")
            ).width <= maxWidth
        ) {
            break;
        }

        size--;
    }

    return size;
}

function drawPanel(
    ctx,
    x,
    y,
    width,
    height,
    radius = 22
) {
    roundedRect(ctx, x, y, width, height, radius);

    ctx.fillStyle = COLORS.panel;
    ctx.fill();

    ctx.strokeStyle = "rgba(243,201,105,0.35)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
}

function drawDivider(ctx, x1, y, x2) {
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.stroke();
}

// IMPORTANT: Every call must pass ctx first.
function drawText(ctx, value, x, y, options = {}) {
    const {
        color = COLORS.text,
        size = 16,
        weight = 600,
        align = "left",
        maxWidth,
    } = options;

    const fittedSize = maxWidth
        ? fitText(ctx, value, maxWidth, size, 10)
        : size;

    ctx.save();

    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = color;
    ctx.font = `${weight} ${fittedSize}px Sans`;

    ctx.fillText(String(value ?? ""), x, y);

    ctx.restore();
}

function getTierObject(player) {
    return (
        player?.inventory ||
        player?.passes ||
        player?.tiers ||
        player ||
        {}
    );
}

function getTierCount(
    player,
    tier,
    type = "available"
) {
    const source = getTierObject(player);
    const item = source?.[tier];

    if (typeof item === "number") {
        return type === "available"
            ? Math.max(0, Number(item))
            : 0;
    }

    if (!item || typeof item !== "object") {
        return 0;
    }

    const value =
        item[type] ??
        (type === "available" ? item.owned : 0) ??
        0;

    return Math.max(0, Number(value || 0));
}

function getAvailableCounts(player) {
    return Object.fromEntries(
        TIER_ORDER.map(tier => [
            tier,
            getTierCount(player, tier, "available"),
        ])
    );
}

function getAvailableTotal(player) {
    const counts = getAvailableCounts(player);

    const tierTotal = TIER_ORDER.reduce(
        (sum, tier) => sum + counts[tier],
        0
    );

    return player?.available !== undefined
        ? Math.max(0, Number(player.available || 0))
        : tierTotal;
}

function getLifetimeCount(player, tier) {
    const value =
        player?.lifetime?.[tier] ??
        player?.earned?.[tier] ??
        player?.[tier]?.lifetime ??
        0;

    return Math.max(0, Number(value || 0));
}

function calculateMoraValue(counts) {
    return TIER_ORDER.reduce((total, tier) => {
        return (
            total +
            Number(counts[tier] || 0) *
            MORA_VALUE_PER_PASS[tier]
        );
    }, 0);
}

function getInventoryStatistics(
    inventories,
    lifetimeInventories
) {
    const available = Object.fromEntries(
        TIER_ORDER.map(tier => [tier, 0])
    );

    const reserved = Object.fromEntries(
        TIER_ORDER.map(tier => [tier, 0])
    );

    const lifetime = Object.fromEntries(
        TIER_ORDER.map(tier => [tier, 0])
    );

    for (const player of inventories || []) {
        for (const tier of TIER_ORDER) {
            available[tier] += getTierCount(
                player,
                tier,
                "available"
            );

            reserved[tier] += getTierCount(
                player,
                tier,
                "reserved"
            );
        }
    }

    for (const player of lifetimeInventories || []) {
        for (const tier of TIER_ORDER) {
            lifetime[tier] += getLifetimeCount(
                player,
                tier
            );
        }
    }

    const sumTiers = values => TIER_ORDER.reduce(
        (sum, tier) =>
            sum + Number(values[tier] || 0),
        0
    );

    const totalAvailable = sumTiers(available);
    const totalReserved = sumTiers(reserved);
    const totalEarned = sumTiers(lifetime);

    const redeemed = Object.fromEntries(
        TIER_ORDER.map(tier => [
            tier,
            Math.max(
                0,
                lifetime[tier] -
                available[tier] -
                reserved[tier]
            ),
        ])
    );

    const totalRedeemed = sumTiers(redeemed);

    return {
        available,
        reserved,
        lifetime,
        redeemed,

        totalAvailable,
        totalReserved,
        totalEarned,
        totalRedeemed,

        availableMoraValue:
            calculateMoraValue(available),

        redeemedMoraValue:
            calculateMoraValue(redeemed),

        reservedMoraValue:
            calculateMoraValue(reserved),

        lifetimeMoraValue:
            calculateMoraValue(lifetime),
    };
}

// --------------------------------------------------
// DISCORD USER DATA
// --------------------------------------------------

async function getUserData(client, userId) {
    try {
        let user = client.users.cache.get(
            String(userId)
        );

        if (!user) {
            user = await client.users.fetch(
                String(userId)
            );
        }

        return {
            name: user.username,

            avatarUrl: user.displayAvatarURL({
                extension: "png",
                size: AVATAR_SIZE,
            }),
        };
    } catch {
        return {
            name: `User ${String(userId).slice(-4)}`,
            avatarUrl: null,
        };
    }
}

async function getAvatar(url) {
    if (!url) return null;

    if (AVATAR_CACHE.has(url)) {
        return AVATAR_CACHE.get(url);
    }

    try {
        const avatar = await loadImage(url);

        AVATAR_CACHE.set(url, avatar);

        if (AVATAR_CACHE.size > 150) {
            AVATAR_CACHE.delete(
                AVATAR_CACHE.keys().next().value
            );
        }

        return avatar;
    } catch {
        return null;
    }
}

// --------------------------------------------------
// DISTRIBUTION CHART
// --------------------------------------------------

function drawDonutChart(
    ctx,
    distribution,
    centerX,
    centerY,
    radius
) {
    const total = TIER_ORDER.reduce(
        (sum, tier) =>
            sum + Number(distribution[tier] || 0),
        0
    );

    if (!total) {
        ctx.beginPath();

        ctx.arc(
            centerX,
            centerY,
            radius,
            0,
            Math.PI * 2
        );

        ctx.strokeStyle = "#344158";
        ctx.lineWidth = 28;
        ctx.stroke();
    } else {
        let angle = -Math.PI / 2;

        for (const tier of TIER_ORDER) {
            const value = Number(
                distribution[tier] || 0
            );

            if (!value) continue;

            const slice =
                (value / total) * Math.PI * 2;

            ctx.beginPath();

            ctx.arc(
                centerX,
                centerY,
                radius,
                angle,
                angle + slice
            );

            ctx.strokeStyle = COLORS[tier];
            ctx.lineWidth = 28;
            ctx.lineCap = "butt";
            ctx.stroke();

            angle += slice;
        }
    }

    drawText(
        ctx,
        formatNumber(total),
        centerX,
        centerY + 5,
        {
            color: COLORS.text,
            size: 27,
            weight: 800,
            align: "center",
        }
    );

    drawText(
        ctx,
        "AVAILABLE",
        centerX,
        centerY + 26,
        {
            color: COLORS.muted,
            size: 12,
            weight: 600,
            align: "center",
        }
    );
}

// --------------------------------------------------
// MAIN RENDERER
// --------------------------------------------------

async function renderWorldPassLeaderboard(data, client) {
    const startedAt = Date.now();

    let inventories = [];
    let lifetimeInventories = [];

    try {
        [
            inventories,
            lifetimeInventories,
        ] = await Promise.all([
            getAllPassInventories(),
            getAllLifetimePassInventories(),
        ]);
    } catch (error) {
        console.error(
            "[WORLD PASS LEADERBOARD] Inventory loading failed:",
            error
        );
    }

    // --------------------------------------------------
    // AVAILABLE LEADERBOARD DATA
    // --------------------------------------------------

    // IMPORTANT:
    // Do NOT use data.entries here.
    // The command previously supplied only the lifetime
    // top 10, which caused available members to be lost.
    //
    // We now use ALL current inventories and calculate
    // the available ranking from those records.

    const sourceEntries = inventories || [];

    const entries = sourceEntries
        .map(entry => {
            const userId = String(entry.userId);

            const availableCounts =
                getAvailableCounts(entry);

            const available =
                getAvailableTotal(entry);

            const availableMoraValue =
                calculateMoraValue(availableCounts);

            return {
                ...entry,
                userId,
                available,
                availableCounts,
                availableMoraValue,
            };
        })

        // Only members with available passes.
        .filter(entry => entry.available > 0)

        // Highest available Mora value first.
        .sort((a, b) => {
            const valueDifference =
                b.availableMoraValue -
                a.availableMoraValue;

            if (valueDifference !== 0) {
                return valueDifference;
            }

            // Tie-breaker: more available passes.
            if (b.available !== a.available) {
                return b.available - a.available;
            }

            // Stable final tie-breaker.
            return String(a.userId).localeCompare(
                String(b.userId)
            );
        })

        // Only the top 10 available members.
        .slice(0, 10);

    console.log(
        `[WORLD PASS LEADERBOARD] Found ${entries.length} available members.`
    );

    // --------------------------------------------------
    // FETCH USERNAMES AND AVATARS
    // --------------------------------------------------

    const userPairs = await Promise.all(
        entries.map(async entry => [
            entry.userId,
            await getUserData(
                client,
                entry.userId
            ),
        ])
    );

    const userMap = new Map(userPairs);

    const avatarPairs = await Promise.all(
        [...userMap.values()]
            .filter(user => user.avatarUrl)
            .map(async user => [
                user.avatarUrl,
                await getAvatar(user.avatarUrl),
            ])
    );

    const avatarMap = new Map(avatarPairs);

    // --------------------------------------------------
    // CREATE CANVAS
    // --------------------------------------------------

    const canvas = createCanvas(
        WIDTH,
        HEIGHT
    );

    const ctx = canvas.getContext("2d");

    // --------------------------------------------------
    // BACKGROUND
    // --------------------------------------------------

    const background = ctx.createLinearGradient(
        0,
        0,
        WIDTH,
        HEIGHT
    );

    background.addColorStop(0, "#0b101b");
    background.addColorStop(0.55, "#151e2e");
    background.addColorStop(1, "#0b101a");

    ctx.fillStyle = background;

    ctx.fillRect(
        0,
        0,
        WIDTH,
        HEIGHT
    );

    // --------------------------------------------------
    // HEADER
    // --------------------------------------------------

    drawText(
        ctx,
        "WORLD ADVENTURE CLUB",
        WIDTH / 2,
        65,
        {
            color: COLORS.gold,
            size: 32,
            weight: 800,
            align: "center",
        }
    );

    drawText(
        ctx,
        "🎟️ WORLD PASS LEADERBOARD",
        WIDTH / 2,
        115,
        {
            color: COLORS.text,
            size: 27,
            weight: 800,
            align: "center",
        }
    );

    drawText(
        ctx,
        "TOP 10 MEMBERS • RANKED BY AVAILABLE PASSES MORA VALUE",
        WIDTH / 2,
        148,
        {
            color: COLORS.muted,
            size: 13,
            weight: 600,
            align: "center",
        }
    );

    // --------------------------------------------------
    // LEADERBOARD PANEL
    // --------------------------------------------------

    const panelX = 35;
    const panelY = 185;
    const panelW = 930;
    const panelH = 900;

    drawPanel(
        ctx,
        panelX,
        panelY,
        panelW,
        panelH,
        22
    );

    const innerLeft = panelX + 25;
    const innerRight = panelX + panelW - 25;

    drawText(
        ctx,
        "🏆 MEMBER RANKINGS",
        innerLeft,
        panelY + 40,
        {
            color: COLORS.gold,
            size: 20,
            weight: 800,
        }
    );

    drawText(
        ctx,
        "AVAILABLE COLLECTION",
        innerRight,
        panelY + 40,
        {
            color: COLORS.muted,
            size: 12,
            weight: 600,
            align: "right",
        }
    );

    drawDivider(
        ctx,
        innerLeft,
        panelY + 60,
        innerRight
    );

    // --------------------------------------------------
    // TABLE HEADER
    // --------------------------------------------------

    const headerY = panelY + 98;

    drawText(
        ctx,
        "RANK",
        innerLeft,
        headerY,
        {
            color: COLORS.gold,
            size: 12,
            weight: 700,
        }
    );

    drawText(
        ctx,
        "MEMBER",
        innerLeft + 65,
        headerY,
        {
            color: COLORS.gold,
            size: 12,
            weight: 700,
        }
    );

    drawText(
        ctx,
        "PASS COLLECTION",
        innerLeft + 390,
        headerY,
        {
            color: COLORS.gold,
            size: 12,
            weight: 700,
        }
    );

    drawText(
        ctx,
        "TOTAL",
        innerRight,
        headerY,
        {
            color: COLORS.gold,
            size: 12,
            weight: 700,
            align: "right",
        }
    );

    drawDivider(
        ctx,
        innerLeft,
        headerY + 16,
        innerRight
    );

    // --------------------------------------------------
    // MEMBER ROWS
    // --------------------------------------------------

    const rowStart = headerY + 22;
    const rowHeight = 76;

    if (!entries.length) {
        drawText(
            ctx,
            "No available World Passes found.",
            WIDTH / 2,
            panelY + 180,
            {
                color: COLORS.muted,
                size: 20,
                weight: 600,
                align: "center",
            }
        );
    }

    entries.forEach((entry, index) => {
        const rowY =
            rowStart + index * rowHeight;

        if (index > 0) {
            drawDivider(
                ctx,
                innerLeft,
                rowY,
                innerRight
            );
        }

        const user =
            userMap.get(entry.userId) || {};

        const avatar = user.avatarUrl
            ? avatarMap.get(user.avatarUrl)
            : null;

        const rankColor =
            index === 0 ? "#f3c969" :
            index === 1 ? "#c8d2e3" :
            index === 2 ? "#c58d63" :
            COLORS.muted;

        // --------------------------------------------------
        // RANK
        // --------------------------------------------------

        drawText(
            ctx,
            index < 3
                ? ["🥇 1", "🥈 2", "🥉 3"][index]
                : String(index + 1).padStart(2, "0"),
            innerLeft,
            rowY + 43,
            {
                color: rankColor,
                size: 18,
                weight: 800,
            }
        );

        // --------------------------------------------------
        // AVATAR
        // --------------------------------------------------

        const avatarX = innerLeft + 65;
        const avatarY = rowY + 15;

        if (avatar) {
            ctx.save();

            ctx.beginPath();

            ctx.arc(
                avatarX + 20,
                avatarY + 20,
                20,
                0,
                Math.PI * 2
            );

            ctx.clip();

            ctx.drawImage(
                avatar,
                avatarX,
                avatarY,
                40,
                40
            );

            ctx.restore();
        } else {
            ctx.beginPath();

            ctx.arc(
                avatarX + 20,
                avatarY + 20,
                20,
                0,
                Math.PI * 2
            );

            ctx.fillStyle = "#2b3549";
            ctx.fill();
        }

        // --------------------------------------------------
        // USERNAME
        // --------------------------------------------------

        const name =
            user.name ||
            `User ${entry.userId.slice(-4)}`;

        drawText(
            ctx,
            name,
            innerLeft + 120,
            rowY + 35,
            {
                color: COLORS.text,
                size: 17,
                weight: 700,
                maxWidth: 215,
            }
        );

        drawText(
            ctx,
            "World Pass Holder",
            innerLeft + 120,
            rowY + 53,
            {
                color: COLORS.muted,
                size: 11,
                weight: 500,
            }
        );

        // --------------------------------------------------
        // PASS CATEGORIES
        // Show only categories with available passes.
        // --------------------------------------------------

        let tierX = innerLeft + 390;

        const ownedTiers = TIER_ORDER.filter(
            tier =>
                Number(
                    entry.availableCounts[tier] || 0
                ) > 0
        );

        for (const tier of TIER_ORDER) {
            drawText(
                ctx,
                `${TIER_EMOJIS[tier]} ${formatNumber(
                    entry.availableCounts[tier]
                )}`,
                tierX,
                rowY + 45,
                {
                    color: COLORS[tier],
                    size: 18,
                    weight: 800,
                    maxWidth: 75,
                }
            );

            tierX += 78;
        }

        // --------------------------------------------------
        // TOTAL AVAILABLE PASSES
        // --------------------------------------------------

        drawText(
            ctx,
            `🎟️ ${formatNumber(entry.available)}`,
            innerRight,
            rowY + 46,
            {
                color: COLORS.gold,
                size: 19,
                weight: 800,
                align: "right",
            }
        );
    });

    // --------------------------------------------------
    // FOOTER
    // --------------------------------------------------

    drawText(
        ctx,
        "WORLD ADVENTURE CLUB • WORLD PASS COLLECTION",
        WIDTH / 2,
        1145,
        {
            color: "#7f8ba2",
            size: 13,
            weight: 600,
            align: "center",
        }
    );

    // --------------------------------------------------
    // FINISH
    // --------------------------------------------------

    console.log(
        `[WORLD PASS LEADERBOARD] Rendered ${entries.length} members in ${Date.now() - startedAt}ms`
    );

    return canvas.toBuffer("image/png");
}

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
    renderWorldPassLeaderboard,
};