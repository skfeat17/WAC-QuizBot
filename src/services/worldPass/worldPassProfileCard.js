
const { createCanvas, loadImage } = require("@napi-rs/canvas");

// --------------------------------------------------
// WORLD PASS SVG ICONS
// --------------------------------------------------

const ICONS = {
    explorer: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r="28" fill="#f5c451" stroke="#9b6b1c" stroke-width="3"/>
        <circle cx="32" cy="32" r="22" fill="#fff4cf"/>
        <path d="M44 15 35 35 16 49 29 29Z" fill="#e34b4b" stroke="#743333" stroke-width="2"/>
        <circle cx="32" cy="32" r="3" fill="#49351c"/>
    </svg>`,

    voyager: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <path d="M4 34c8-13 15-13 23 0s15 13 23 0 10-9 10-9v24H4Z" fill="#269bd8"/>
        <path d="M4 23c8-13 15-13 23 0s15 13 23 0 10-9 10-9" fill="none" stroke="#8de4ff" stroke-width="7" stroke-linecap="round"/>
    </svg>`,

    pathfinder: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <path d="m6 14 17-7 18 7 17-7v43l-17 7-18-7-17 7Z" fill="#7fcf8b" stroke="#347c52" stroke-width="3"/>
        <path d="M23 7v43M41 14v43" stroke="#347c52" stroke-width="3"/>
        <path d="M32 15c-7 0-11 5-11 11 0 9 11 22 11 22s11-13 11-22c0-6-4-11-11-11Z" fill="#e94f58"/>
        <circle cx="32" cy="26" r="4" fill="#fff"/>
    </svg>`,

    discoverer: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <path d="m8 22 12-14h24l12 14-24 34Z" fill="#53c9f0" stroke="#167ba5" stroke-width="3"/>
        <path d="M8 22h48M20 8l12 48L44 8" fill="none" stroke="#d9f8ff" stroke-width="2.5"/>
    </svg>`,

    celestial: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <path d="m32 4 8 18 20 2-15 13 5 20-18-11-18 11 5-20L4 24l20-2Z" fill="#ffd84d" stroke="#d18a1b" stroke-width="3"/>
    </svg>`,

    ticket: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <path d="M8 15h48v12a7 7 0 0 0 0 14v8H8v-8a7 7 0 0 0 0-14Z" fill="#f3c969" stroke="#a97825" stroke-width="3"/>
        <path d="M24 17v30" stroke="#a97825" stroke-width="3" stroke-dasharray="4 4"/>
    </svg>`,

    trophy: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <path d="M18 8h28v13c0 13-6 21-14 21s-14-8-14-21Z" fill="#ffd447" stroke="#a97825" stroke-width="3"/>
        <path d="M18 14H7v7c0 10 6 15 15 15M46 14h11v7c0 10-6 15-15 15" fill="none" stroke="#d49a2d" stroke-width="5"/>
        <path d="M28 42h8v9h10v6H18v-6h10Z" fill="#c58d32"/>
    </svg>`,
};

// --------------------------------------------------
// CONFIG
// --------------------------------------------------

const WIDTH = 1000;
const HEIGHT = 720;
const REDEEM_TARGET = 10;

const TIER_ORDER = [
    "explorer",
    "voyager",
    "pathfinder",
    "discoverer",
    "celestial",
];

const TIER_COLORS = {
    explorer: "#e8b84f",
    voyager: "#38a9e8",
    pathfinder: "#57bd85",
    discoverer: "#53bce8",
    celestial: "#e17ac4",
};

const COLORS = {
    gold: "#f3c969",
    text: "#edf2fa",
    muted: "#8f9db2",
    panel: "#172234",
    line: "rgba(160,180,210,0.15)",
};

const ICON_CACHE = new Map();
const AVATAR_CACHE = new Map();

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function safeNumber(value) {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function formatNumber(value) {
    return safeNumber(value).toLocaleString("en-IN");
}

function roundedRect(ctx, x, y, width, height, radius = 16) {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
}

function fillPanel(ctx, x, y, width, height, color = COLORS.panel) {
    roundedRect(ctx, x, y, width, height, 17);

    ctx.fillStyle = color;
    ctx.fill();

    ctx.strokeStyle = "rgba(160,180,210,0.12)";
    ctx.lineWidth = 1;
    ctx.stroke();
}

function drawText(ctx, value, x, y, options = {}) {
    const {
        color = COLORS.text,
        size = 16,
        weight = 600,
        align = "left",
        maxWidth,
    } = options;

    ctx.save();

    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.font = `${weight} ${size}px Sans`;

    let text = String(value ?? "");

    if (maxWidth && ctx.measureText(text).width > maxWidth) {
        while (
            text.length > 3 &&
            ctx.measureText(`${text}...`).width > maxWidth
        ) {
            text = text.slice(0, -1);
        }

        text += "...";
    }

    ctx.fillText(text, x, y);
    ctx.restore();
}

function drawDivider(ctx, x1, y, x2) {
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);

    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1;
    ctx.stroke();
}

async function getIcon(name) {
    if (ICON_CACHE.has(name)) {
        return ICON_CACHE.get(name);
    }

    const svg = ICONS[name];
    if (!svg) return null;

    const image = await loadImage(Buffer.from(svg));
    ICON_CACHE.set(name, image);

    return image;
}

async function drawIcon(ctx, name, x, y, size = 28) {
    const icon = await getIcon(name);

    if (icon) {
        ctx.drawImage(icon, x, y, size, size);
    }
}

// Only count currently AVAILABLE passes.
function getAvailableCount(value) {
    if (typeof value === "number") {
        return safeNumber(value);
    }

    if (value && typeof value === "object") {
        return safeNumber(value.available);
    }

    return 0;
}

// Mora value per pass.
// Supports moraValue, passValue, or passCost in challenge config.
function getPassMoraValue(config = {}) {
    const reward = safeNumber(config.reward);
    const passCost = safeNumber(config.passCost) || 10;

    return reward / passCost;
}
function getNextRedeem(tiers) {
    const redeemable = tiers
        .filter(tier => tier.available >= REDEEM_TARGET)
        .sort((a, b) => b.available - a.available);

    if (redeemable.length) {
        return {
            tier: redeemable[0],
            remaining: 0,
            ready: true,
        };
    }

    const closest = [...tiers].sort(
        (a, b) => b.available - a.available
    )[0];

    if (!closest) return null;

    return {
        tier: closest,
        remaining: Math.max(0, REDEEM_TARGET - closest.available),
        ready: false,
    };
}

async function getAvatar(user) {
    try {
        const url = user.displayAvatarURL({
            extension: "png",
            size: 256,
        });

        if (AVATAR_CACHE.has(url)) {
            return AVATAR_CACHE.get(url);
        }

        const avatar = await loadImage(url);

        AVATAR_CACHE.set(url, avatar);

        if (AVATAR_CACHE.size > 100) {
            AVATAR_CACHE.delete(AVATAR_CACHE.keys().next().value);
        }

        return avatar;
    } catch {
        return null;
    }
}

function drawAvatar(ctx, avatar, x, y, radius) {
    ctx.save();

    ctx.beginPath();
    ctx.arc(x, y, radius + 5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(243,201,105,0.22)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.clip();

    if (avatar) {
        ctx.drawImage(
            avatar,
            x - radius,
            y - radius,
            radius * 2,
            radius * 2
        );
    } else {
        ctx.fillStyle = "#34435a";
        ctx.fillRect(
            x - radius,
            y - radius,
            radius * 2,
            radius * 2
        );
    }

    ctx.restore();
}

// --------------------------------------------------
// MAIN PROFILE CARD
// --------------------------------------------------

async function renderWorldPassProfileCard({
    user,
    inventory = {},
    challenges = {},
    tierEmojis = {},
}) {
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext("2d");

    // --------------------------------------------------
    // PASS DATA
    // --------------------------------------------------

    const tiers = TIER_ORDER.map(tier => {
        const config = challenges[tier] || {};

        return {
            id: tier,
            name: config.name || tier,
            available: getAvailableCount(inventory?.[tier]),
            moraValue: getPassMoraValue(config),
            color: TIER_COLORS[tier] || COLORS.gold,
        };
    });

    const totalAvailable = tiers.reduce(
        (sum, tier) => sum + tier.available,
        0
    );

    const estimatedMora = tiers.reduce(
        (sum, tier) => sum + tier.available * tier.moraValue,
        0
    );

    const nextRedeem = getNextRedeem(tiers);

    // --------------------------------------------------
    // BACKGROUND
    // --------------------------------------------------

    const background = ctx.createLinearGradient(
        0, 0, WIDTH, HEIGHT
    );

    background.addColorStop(0, "#0b1220");
    background.addColorStop(0.5, "#172338");
    background.addColorStop(1, "#0b1422");

    ctx.fillStyle = background;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const glow = ctx.createRadialGradient(
        850, 80, 10,
        850, 80, 400
    );

    glow.addColorStop(0, "rgba(243,201,105,0.10)");
    glow.addColorStop(1, "rgba(243,201,105,0)");

    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    roundedRect(ctx, 15, 15, WIDTH - 30, HEIGHT - 30, 25);

    ctx.strokeStyle = "rgba(243,201,105,0.28)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // --------------------------------------------------
    // HEADER
    // --------------------------------------------------

    await drawIcon(ctx, "ticket", 48, 37, 34);

    drawText(ctx, "WORLD ADVENTURE CLUB", 92, 58, {
        color: COLORS.gold,
        size: 17,
        weight: 800,
    });

    drawText(ctx, "YOUR WORLD PASS INVENTORY", 48, 112, {
        color: COLORS.text,
        size: 31,
        weight: 800,
    });

    drawText(ctx, "Your collection and redemption progress", 50, 140, {
        color: COLORS.muted,
        size: 14,
        weight: 500,
    });

    drawDivider(ctx, 48, 160, 952);

    // --------------------------------------------------
    // PLAYER PROFILE
    // --------------------------------------------------

    const avatar = await getAvatar(user);

    drawAvatar(ctx, avatar, 105, 218, 48);

    // Username only. Never use globalName.
    drawText(ctx, user?.username || "Unknown Player", 180, 211, {
        color: COLORS.text,
        size: 27,
        weight: 800,
        maxWidth: 570,
    });

    drawText(ctx, "WORLD PASS HOLDER", 182, 240, {
        color: COLORS.gold,
        size: 12,
        weight: 700,
    });

    drawText(ctx, `ID: ${String(user?.id || "").slice(-8)}`, 950, 225, {
        color: COLORS.muted,
        size: 12,
        weight: 600,
        align: "right",
    });

    // --------------------------------------------------
    // TOP THREE SUMMARY CARDS
    // --------------------------------------------------

    const summaryCards = [
        {
            x: 48,
            label: "AVAILABLE PASSES",
            value: formatNumber(totalAvailable),
            subtitle: "Across all collections",
            color: "#63d6a5",
            icon: "ticket",
        },
        {
            x: 355,
            label: "ESTIMATED MORA VALUE",
            value: formatNumber(estimatedMora),
            subtitle: "Based on configured pass value",
            color: COLORS.gold,
            icon: "trophy",
        },
        {
            x: 662,
            label: "NEXT REDEEM",
            value: nextRedeem?.tier.name || "No passes",
            subtitle: nextRedeem
                ? nextRedeem.ready
                    ? "Ready to redeem!"
                    : `${formatNumber(nextRedeem.remaining)} more needed`
                : "No collection available",
            color: nextRedeem?.ready ? "#63d6a5" : "#70b8f2",
            icon: "ticket",
        },
    ];

    for (const card of summaryCards) {
        fillPanel(ctx, card.x, 280, 290, 96, "#1a293d");

        await drawIcon(ctx, card.icon, card.x + 16, 298, 29);

        drawText(ctx, card.label, card.x + 55, 309, {
            color: COLORS.muted,
            size: 11,
            weight: 700,
        });

        drawText(ctx, card.value, card.x + 55, 340, {
            color: card.color,
            size: card.value.length > 15 ? 17 : 23,
            weight: 800,
            maxWidth: 215,
        });

        drawText(ctx, card.subtitle, card.x + 18, 362, {
            color: COLORS.muted,
            size: 11,
            weight: 500,
            maxWidth: 255,
        });
    }

    // --------------------------------------------------
    // COLLECTION HEADER
    // --------------------------------------------------

    await drawIcon(ctx, "trophy", 49, 399, 23);

    drawText(ctx, "PASS COLLECTION", 80, 418, {
        color: COLORS.gold,
        size: 16,
        weight: 800,
    });

    drawText(ctx, "AVAILABLE PASSES", 950, 418, {
        color: COLORS.muted,
        size: 11,
        weight: 700,
        align: "right",
    });

    drawDivider(ctx, 48, 432, 952);

    // --------------------------------------------------
    // TIER ROWS
    // Available passes ONLY.
    // --------------------------------------------------

    const rowStart = 443;
    const rowHeight = 45;

    for (let index = 0; index < tiers.length; index++) {
        const tier = tiers[index];
        const y = rowStart + index * rowHeight;

        fillPanel(
            ctx,
            48,
            y,
            904,
            39,
            index % 2 === 0 ? "#1b2a3e" : "#172438"
        );

        await drawIcon(ctx, tier.id, 60, y + 5, 28);

        drawText(ctx, tier.name, 103, y + 26, {
            color: COLORS.text,
            size: 16,
            weight: 700,
        });

        // Progress towards 10 passes.
        const progress = Math.min(
            tier.available / REDEEM_TARGET,
            1
        );

        const barX = 620;
        const barY = y + 15;
        const barWidth = 165;

        roundedRect(ctx, barX, barY, barWidth, 9, 5);
        ctx.fillStyle = "#0d1726";
        ctx.fill();

        if (progress > 0) {
            roundedRect(
                ctx,
                barX,
                barY,
                Math.max(5, barWidth * progress),
                9,
                5
            );

            ctx.fillStyle = tier.color;
            ctx.fill();
        }

        drawText(ctx, `${formatNumber(tier.available)} / ${REDEEM_TARGET}`, 925, y + 26, {
            color: tier.color,
            size: 16,
            weight: 800,
            align: "right",
        });
    }

    // --------------------------------------------------
    // NEXT REDEEM PROGRESS
    // --------------------------------------------------

    // drawDivider(ctx, 48, 682, 952);

    // const footerText = nextRedeem
    //     ? nextRedeem.ready
    //         ? `${nextRedeem.tier.name} is ready to redeem`
    //         : `${nextRedeem.tier.name}: ${formatNumber(nextRedeem.remaining)} more pass${nextRedeem.remaining === 1 ? "" : "es"} needed for redemption`
    //     : "Start collecting World Passes!";

    // drawText(ctx, footerText, 500, 704, {
    //     color: nextRedeem?.ready ? "#63d6a5" : COLORS.muted,
    //     size: 12,
    //     weight: 700,
    //     align: "center",
    // });

    return canvas.toBuffer("image/png");
}

// --------------------------------------------------
// EXPORT
// --------------------------------------------------

module.exports = {
    renderWorldPassProfileCard,
};
