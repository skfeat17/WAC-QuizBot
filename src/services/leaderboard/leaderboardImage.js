const { createCanvas, loadImage } = require("@napi-rs/canvas");

const WIDTH = 1800;
const HEIGHT = 900;

const MORA_EMOJI_URL =
    "https://cdn.discordapp.com/emojis/1503931162525962333.png?size=64";

const AVATAR_SIZE = 64;
const AVATAR_CACHE = new Map();

function roundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
}

function fitText(ctx, text, maxWidth, initialSize = 22) {
    let size = initialSize;

    do {
        ctx.font = `600 ${size}px Sans`;

        if (ctx.measureText(text).width <= maxWidth) break;

        size--;
    } while (size > 12);

    return size;
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString("en-IN");
}

// ==========================================
// USER CACHE
// ==========================================

async function getUserData(userId, client) {
    try {
        let user = client.users.cache.get(userId);

        if (!user) {
            user = await client.users.fetch(userId);
        }

        return {
            name:user.username,
            avatarUrl: user.displayAvatarURL({
                extension: "png",
                size: AVATAR_SIZE,
            }),
        };
    } catch {
        return {
            name: `User ${userId.slice(-4)}`,
            avatarUrl: null,
        };
    }
}

// ==========================================
// AVATAR CACHE
// ==========================================

async function getAvatar(url) {
    if (!url) return null;

    if (AVATAR_CACHE.has(url)) {
        return AVATAR_CACHE.get(url);
    }

    try {
        const image = await loadImage(url);

        AVATAR_CACHE.set(url, image);

        // Prevent unlimited memory growth.
        if (AVATAR_CACHE.size > 150) {
            const firstKey = AVATAR_CACHE.keys().next().value;
            AVATAR_CACHE.delete(firstKey);
        }

        return image;
    } catch {
        return null;
    }
}

// ==========================================
// PRELOAD USERS AND AVATARS
// ==========================================

async function preloadLeaderboard(data, client) {
    const userIds = [
        ...new Set(
            data.sections.flatMap(section =>
                (section.entries || [])
                    .slice(0, 10)
                    .map(entry => entry.userId)
            )
        ),
    ];

    const users = await Promise.all(
        userIds.map(async userId => [
            userId,
            await getUserData(userId, client),
        ])
    );

    const userMap = new Map(users);

    const avatarUrls = [
        ...new Set(
            [...userMap.values()]
                .map(user => user.avatarUrl)
                .filter(Boolean)
        ),
    ];

    const avatars = await Promise.all(
        avatarUrls.map(async url => [
            url,
            await getAvatar(url),
        ])
    );

    return {
        userMap,
        avatarMap: new Map(avatars),
    };
}

// ==========================================
// RENDER LEADERBOARD
// ==========================================

async function renderLeaderboardImage(data, client) {
    const startTime = Date.now();

    // Load users and avatars concurrently.
    const { userMap, avatarMap } =
        await preloadLeaderboard(data, client);

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext("2d");

    // BACKGROUND
    const bg = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);

    bg.addColorStop(0, "#090d18");
    bg.addColorStop(0.5, "#151b2b");
    bg.addColorStop(1, "#080b13");

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // HEADER
    ctx.textAlign = "center";
    ctx.fillStyle = "#f3c969";
    ctx.font = "800 42px Sans";

    ctx.fillText(
        "WORLD ADVENTURE CLUB",
        WIDTH / 2,
        66
    );

    ctx.fillStyle = "#aeb8cb";
    ctx.font = "500 19px Sans";

    ctx.fillText(
        "MORA LEADERBOARD • THE RACE FOR MORA ",
        WIDTH / 2,
        101
    );

    // MORA EMOJI
    let moraImage = null;

    try {
        moraImage = await loadImage(MORA_EMOJI_URL);
    } catch {}

    // PANEL SETTINGS
    const margin = 42;
    const gap = 22;
    const panelY = 140;
    const panelH = 690;

    const panelW =
        (WIDTH - margin * 2 - gap * 2) / 3;

    // PANELS
    for (let sectionIndex = 0; sectionIndex < 3; sectionIndex++) {
        const section = data.sections[sectionIndex];

        if (!section) continue;

        const x =
            margin + sectionIndex * (panelW + gap);

        // PANEL BACKGROUND
        const panelGradient = ctx.createLinearGradient(
            x,
            panelY,
            x + panelW,
            panelY + panelH
        );

        panelGradient.addColorStop(0, "#1a2335");
        panelGradient.addColorStop(1, "#101725");

        roundedRect(ctx, x, panelY, panelW, panelH, 24);

        ctx.fillStyle = panelGradient;
        ctx.fill();

        ctx.strokeStyle = "rgba(243,201,105,0.45)";
        ctx.lineWidth = 2;
        ctx.stroke();

        // TITLE
        ctx.textAlign = "center";
        ctx.fillStyle = "#f3c969";
        ctx.font = "800 25px Sans";

        ctx.fillText(
            section.title,
            x + panelW / 2,
            panelY + 48
        );

        ctx.fillStyle = "#71809a";

        ctx.fillRect(
            x + 25,
            panelY + 70,
            panelW - 50,
            1
        );

        // ENTRIES
        const entries = section.entries || [];

        for (let i = 0; i < 10; i++) {
            const rowY = panelY + 92 + i * 52;
            const entry = entries[i];

            if (!entry) {
                ctx.fillStyle = "#667187";
                ctx.font = "500 17px Sans";
                ctx.textAlign = "center";

                ctx.fillText(
                    "—",
                    x + panelW / 2,
                    rowY + 27
                );

                continue;
            }

            const userData = userMap.get(entry.userId);

            const displayName =
                userData?.name ||
                `User ${entry.userId.slice(-4)}`;

            // RANK
            ctx.fillStyle =
                i === 0 ? "#f3c969" :
                i === 1 ? "#c8d2e3" :
                i === 2 ? "#c58d63" :
                "#8793a9";

            ctx.textAlign = "left";
            ctx.font = "800 19px Sans";

            ctx.fillText(
                String(i + 1).padStart(2, "0"),
                x + 22,
                rowY + 29
            );

            // AVATAR
            const avatar = userData?.avatarUrl
                ? avatarMap.get(userData.avatarUrl)
                : null;

            if (avatar) {
                ctx.save();

                ctx.beginPath();
                ctx.arc(
                    x + 76,
                    rowY + 21,
                    19,
                    0,
                    Math.PI * 2
                );

                ctx.closePath();
                ctx.clip();

                ctx.drawImage(
                    avatar,
                    x + 57,
                    rowY + 2,
                    38,
                    38
                );

                ctx.restore();
            }

            // USERNAME
            const nameX = x + 108;
            const amountWidth = 94;

            const nameMaxWidth =
                panelW - (nameX - x) - amountWidth - 45;

            const fontSize = fitText(
                ctx,
                displayName,
                nameMaxWidth,
                19
            );

            ctx.fillStyle = "#edf1f8";
            ctx.font = `600 ${fontSize}px Sans`;
            ctx.textAlign = "left";

            ctx.fillText(
                displayName,
                nameX,
                rowY + 27
            );

            // AMOUNT
            ctx.textAlign = "right";
            ctx.fillStyle = "#f3c969";
            ctx.font = "800 19px Sans";

            ctx.fillText(
                formatNumber(entry.amount),
                x + panelW - 48,
                rowY + 27
            );

            if (moraImage) {
                ctx.drawImage(
                    moraImage,
                    x + panelW - 38,
                    rowY + 9,
                    22,
                    22
                );
            }

            // DIVIDER
            if (i < 9) {
                ctx.strokeStyle =
                    "rgba(130,148,177,0.13)";

                ctx.lineWidth = 1;
                ctx.beginPath();

                ctx.moveTo(
                    x + 22,
                    rowY + 47
                );

                ctx.lineTo(
                    x + panelW - 22,
                    rowY + 47
                );

                ctx.stroke();
            }
        }

        // LEADERBOARD SUMMARY
        // Compact inline stats: icon + label + value.
        const summaryY = panelY + 620;
        const summaryX = x + 18;
        const summaryW = panelW - 36;
        const summaryH = 62;
        const innerGap = 8;
        const statW = (summaryW - innerGap * 2) / 3;

        const stats = [
            {
                label: "Mora",
                value: formatNumber(section.totalRewarded),
                icon: "mora",
                color: "#f3c969",
            },
            {
                label: "Users",
                value: formatNumber(section.uniqueUsers),
                icon: "👤",
                color: "#8fd6ff",
            },
            {
                label: "Attempts",
                value: formatNumber(section.totalAttempts),
                icon: "🎯",
                color: "#c5a4ff",
            },
        ];

        stats.forEach((stat, index) => {
            const statX = summaryX + index * (statW + innerGap);
            const cardY = summaryY + 7;
            const cardH = summaryH - 14;
            const centerX = statX + statW / 2;

            roundedRect(
                ctx,
                statX,
                cardY,
                statW,
                cardH,
                9
            );

            ctx.fillStyle = "rgba(255,255,255,0.045)";
            ctx.fill();

            ctx.strokeStyle = "rgba(255,255,255,0.08)";
            ctx.lineWidth = 1;
            ctx.stroke();

            const iconText = stat.icon === "mora" ? "" : `${stat.icon} `;
            const lineText = `${iconText}${stat.label} : ${stat.value}`;

            ctx.textAlign = "center";
            ctx.fillStyle = stat.color;

            const fontSize = fitText(ctx, lineText, statW - 12, 16);
            ctx.font = `700 ${fontSize}px Sans`;
            ctx.fillText(lineText, centerX, summaryY + 39);

            // Use the actual custom Discord Mora emoji.
            if (stat.icon === "mora" && moraImage) {
                const textWidth = ctx.measureText(lineText).width;
                const emojiSize = 17;
                ctx.drawImage(
                    moraImage,
                    centerX - textWidth / 2 - emojiSize - 4,
                    summaryY + 22,
                    emojiSize,
                    emojiSize
                );
            }
        });
    }

    // FOOTER
    ctx.textAlign = "center";
    ctx.fillStyle = "#7f8ba2";
    ctx.font = "500 16px Sans";

    const updated = new Date(
        data.generatedAt
    ).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
    });

    ctx.fillText(
        `Updated ${updated} IST  •  Refreshes on the next IST period boundary`,
        WIDTH / 2,
        870
    );

    console.log(
        `[LEADERBOARD] Rendered in ${Date.now() - startTime}ms`
    );

    return canvas.toBuffer("image/png");
}

module.exports = {
    renderLeaderboardImage,
};