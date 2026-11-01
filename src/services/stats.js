
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
} = require("discord.js");

const {
    getAvailableDays,
    getDayStats,
    getLast24Hours,
} = require("./statsService");

const weeklyRedis = require("./weekly/weeklyRedis");
const VALID_EVENTS = new Set([
    "mystery",
]);

const WEEKLY_PAGE_SIZE = 10;
const WEEKLY_SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const weeklyStatsSnapshots = new Map();

function cleanWeeklyStatsSnapshots() {
    const now = Date.now();
    for (const [key, snapshot] of weeklyStatsSnapshots) {
        if (snapshot.expiresAt <= now) weeklyStatsSnapshots.delete(key);
    }
}

function getAttemptDate(dayKey) {
    const match = String(dayKey || "").match(/:date-(\d{4}-\d{2}-\d{2})$/);
    return match ? match[1] : null;
}

async function loadWeeklyStatsSnapshot() {
    const [players, attempts] = await Promise.all([
        weeklyRedis.getLeaderboard(10000),
        weeklyRedis.getTrackedAttempts(),
    ]);

    const byUser = new Map();
    for (const player of players) {
        const userId = String(player.userId);
        byUser.set(userId, {
            userId,
            displayName: player.displayName || userId,
            points: Number(player.points) || 0,
            correct: Number(player.correct) || 0,
            incorrect: Number(player.incorrect) || 0,
            timedOut: 0,
            days: new Set(),
            joinedAt: Number(player.joinedAt) || null,
        });
    }

    for (const attempt of attempts) {
        if (!attempt?.userId) continue;
        const userId = String(attempt.userId);
        let row = byUser.get(userId);
        if (!row) {
            row = {
                userId,
                displayName: userId,
                points: 0,
                correct: 0,
                incorrect: 0,
                timedOut: 0,
                days: new Set(),
                joinedAt: null,
            };
            byUser.set(userId, row);
        }

        row.timedOut += Number(attempt.timedOut) || 0;
        const date = getAttemptDate(attempt.dayKey);
        if (date && (attempt.participatedAt || attempt.startedAt || Number(attempt.answered) > 0 || attempt.status === "completed")) {
            row.days.add(date);
        }
    }

    const rows = [...byUser.values()]
        .map(row => ({ ...row, daysParticipated: row.days.size }))
        .sort((a, b) => b.points - a.points || a.displayName.localeCompare(b.displayName));

    return rows;
}

function buildWeeklyStatsButtons(snapshotId, pageIndex, totalPages) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`stats_weekly_prev_${snapshotId}_${pageIndex}`)
                .setLabel("Previous")
                .setEmoji("◀️")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(pageIndex <= 0),
            new ButtonBuilder()
                .setCustomId(`stats_weekly_next_${snapshotId}_${pageIndex}`)
                .setLabel("Next")
                .setEmoji("▶️")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(pageIndex >= totalPages - 1),
        ),
    ];
}

async function getWeeklyStatsPage(client, snapshotId, pageIndex) {
    cleanWeeklyStatsSnapshots();
    const snapshot = weeklyStatsSnapshots.get(snapshotId);
    if (!snapshot || snapshot.expiresAt <= Date.now()) {
        weeklyStatsSnapshots.delete(snapshotId);
        return {
            embed: new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle("🏆 WEEKLY WORLD QUIZ STATS")
                .setDescription("This stats snapshot has expired. Run `/stats` again to load the latest data."),
            components: [],
        };
    }

    const totalPages = Math.max(1, Math.ceil(snapshot.rows.length / WEEKLY_PAGE_SIZE));
    const safePage = Math.min(Math.max(Number(pageIndex) || 0, 0), totalPages - 1);
    const visibleRows = snapshot.rows.slice(safePage * WEEKLY_PAGE_SIZE, (safePage + 1) * WEEKLY_PAGE_SIZE);
    const lines = [];

    for (let i = 0; i < visibleRows.length; i += 1) {
        const player = visibleRows[i];
        const user = await getUserLabel(client, player.userId);
        const joined = player.joinedAt
            ? `<t:${Math.floor(player.joinedAt / 1000)}:F> (<t:${Math.floor(player.joinedAt / 1000)}:R>)`
            : "Unknown";
        lines.push(
            `**${safePage * WEEKLY_PAGE_SIZE + i + 1}.** ${user.mention} — **${formatNumber(player.points)} points**\n` +
            `   ✅ ${formatNumber(player.correct)} • ❌ ${formatNumber(player.incorrect)} • ⏰ ${formatNumber(player.timedOut)} • 📅 ${formatNumber(player.daysParticipated)} days\n` +
            `   🕒 Joined: ${joined}`
        );
    }

    const description = lines.length ? lines.join("\n\n") : "No weekly participants found.";
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("🏆 WEEKLY WORLD QUIZ STATS")
        .setDescription(`**Players:** ${formatNumber(snapshot.rows.length)}\n**Page:** ${safePage + 1}/${totalPages}\n\n${description}`)
        .setFooter({ text: `World Adventure Club • Weekly Stats • Snapshot expires in 15 minutes` });

    return {
        embed,
        components: snapshot.rows.length ? buildWeeklyStatsButtons(snapshotId, safePage, totalPages) : [],
    };
}


const EVENT_NAMES = {
    mystery: "DAILY STATS",
};

const MORA_EMOJI =
    "<:mora:1503931162525962333>";
const PAGE_SIZE = 20;


/*
    Format a YYYY-MM-DD date into:
    1 October 2026
*/
function formatDate(dateKey) {
    const date = new Date(`${dateKey}T00:00:00Z`);

    if (Number.isNaN(date.getTime())) {
        return dateKey;
    }

    return new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
    }).format(date);
}


/*
    Format large numbers safely.
*/
function formatNumber(value) {
    return Number(value || 0).toLocaleString("en-US");
}


/*
    Get Discord display name.
*/
async function getUserLabel(client, userId) {
    try {
        const user = await client.users.fetch(userId);

        return {
            label:
                user.globalName ||
                user.username ||
                `<@${userId}>`,

            mention: `<@${userId}>`,
        };
    } catch {
        return {
            label: `<@${userId}>`,
            mention: `<@${userId}>`,
        };
    }
}


/*
    Build navigation buttons.

    Refresh has intentionally been removed.
*/
function buildStatsButtons(
    event,
    pageIndex,
    totalPages
) {
    const previousButton =
        new ButtonBuilder()
            .setCustomId(
                `stats_prev_${event}_${pageIndex}`
            )
            .setLabel("Previous")
            .setEmoji("◀️")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(pageIndex <= 0);


    const nextButton =
        new ButtonBuilder()
            .setCustomId(
                `stats_next_${event}_${pageIndex}`
            )
            .setLabel("Next")
            .setEmoji("▶️")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(
                pageIndex >= totalPages - 1
            );


    return [
        new ActionRowBuilder().addComponents(
            previousButton,
            nextButton
        ),
    ];
}


/*
    Build one day's stats embed.
*/
async function buildStatsEmbed(
    client,
    event,
    dateKey
) {
    const stats =
        await getDayStats(
            event,
            dateKey
        );


    const last24 =
        await getLast24Hours(
            event
        );


    const entries =
        Array.isArray(stats.users)
            ? stats.users
            : [];


    /*
        Mora information.

        stats.moraUsers has:
        [
            {
                userId,
                amount
            }
        ]
    */
    const moraEntries =
        Array.isArray(stats.moraUsers)
            ? stats.moraUsers
            : [];


    /*
        Convert Mora data into a Map.

        This makes it easy to find a user's
        Mora amount while displaying participants.
    */
    const moraMap =
        new Map(
            moraEntries.map(
                entry => [
                    entry.userId,
                    Number(entry.amount) || 0,
                ]
            )
        );


    /*
        Only show the first PAGE_SIZE
        participation users.
    */
    const visibleEntries =
        entries.slice(
            0,
            PAGE_SIZE
        );


    const participantLines = [];


    for (const entry of visibleEntries) {
        const user =
            await getUserLabel(
                client,
                entry.userId
            );


        const mora =
            moraMap.get(
                entry.userId
            ) || 0;


        participantLines.push(
            `${user.mention} — **${formatNumber(entry.count)}** participation${entry.count === 1 ? "" : "s"} • **${formatNumber(mora)} ${MORA_EMOJI}**`
        );
    }


    const participantText =
        participantLines.length
            ? participantLines.join("\n")
            : "No participation recorded.";


    const hiddenCount =
        Math.max(
            0,
            entries.length - PAGE_SIZE
        );


    const hiddenText =
        hiddenCount > 0
            ? `\n…and **${hiddenCount}** more participants.`
            : "";


    return new EmbedBuilder()
        .setColor(0x5865F2)

        .setTitle(
            `📊 ${EVENT_NAMES[event]} STATS`
        )

        .setDescription(
            `━━━━━━━━━━━━━━━━━━━━\n\n` +

            `📅 **${formatDate(dateKey)}**\n\n` +

            `👥 **Participants:** ${formatNumber(stats.participants)}\n` +

            `🎯 **Total Participations:** ${formatNumber(stats.totalParticipations)}\n` +

            `💰 **Mora Awarded:** ${formatNumber(stats.totalMora)}\n\n` +

            `⏱️ **LAST 24 HOURS**\n` +

            `👥 ${formatNumber(last24.participants)} participants\n` +

            `🎯 ${formatNumber(last24.totalParticipations)} participations\n\n` +

            `👤 **PARTICIPANTS**\n\n` +

            `${participantText}` +

            hiddenText +

            `\n\n━━━━━━━━━━━━━━━━━━━━`
        )

        .setFooter({
            text:
                "World Adventure Club • Participation Stats",
        });
}


/*
    Get the currently selected day.
*/
async function getStatsPage(
    client,
    event,
    pageIndex
) {
    const days =
        await getAvailableDays(
            event
        );


    if (!days.length) {
        return {
            embed:
                new EmbedBuilder()
                    .setColor(0x5865F2)

                    .setTitle(
                        `📊 ${EVENT_NAMES[event]} STATS`
                    )

                    .setDescription(
                        "━━━━━━━━━━━━━━━━━━━━\n\n" +

                        "📭 **No participation data yet.**\n\n" +

                        "Once someone participates, their statistics will appear here.\n\n" +

                        "━━━━━━━━━━━━━━━━━━━━"
                    )

                    .setFooter({
                        text:
                            "World Adventure Club • Participation Stats",
                    }),

            components: [],

            pageIndex: 0,

            totalPages: 0,
        };
    }


    const safePageIndex =
        Math.min(
            Math.max(
                Number(pageIndex) || 0,
                0
            ),
            days.length - 1
        );


    const dateKey =
        days[safePageIndex];


    const embed =
        await buildStatsEmbed(
            client,
            event,
            dateKey
        );


    return {
        embed,

        components:
            buildStatsButtons(
                event,
                safePageIndex,
                days.length
            ),

        pageIndex:
            safePageIndex,

        totalPages:
            days.length,
    };
}


/*
    /stats command handler.
*/
async function handleStatsCommand(
    interaction
) {
    const event =
        interaction.options.getString(
            "event",
            true
        );


    if (event === "weekly") {
        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const rows = await loadWeeklyStatsSnapshot();
            const snapshotId = interaction.id;
            cleanWeeklyStatsSnapshots();
            weeklyStatsSnapshots.set(snapshotId, {
                rows,
                expiresAt: Date.now() + WEEKLY_SNAPSHOT_TTL_MS,
            });
            const page = await getWeeklyStatsPage(interaction.client, snapshotId, 0);
            await interaction.editReply({ embeds: [page.embed], components: page.components });
        } catch (error) {
            console.error("❌ Failed to load weekly stats:", error);
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({
                    content: "⚠️ I couldn't load Weekly World Quiz statistics right now.",
                    embeds: [],
                    components: [],
                });
            } else {
                await interaction.reply({ content: "⚠️ I couldn't load Weekly World Quiz statistics right now.", flags: MessageFlags.Ephemeral });
            }
        }
        return;
    }

    if (!VALID_EVENTS.has(event)) {
        await interaction.reply({
            content:
                "❌ Invalid stats event.",

            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }


    try {
        await interaction.deferReply({
            flags:
                MessageFlags.Ephemeral,
        });


        const page =
            await getStatsPage(
                interaction.client,
                event,
                0
            );


        await interaction.editReply({
            embeds: [
                page.embed,
            ],

            components:
                page.components,
        });

    } catch (error) {
        console.error(
            "❌ Failed to load stats:",
            error
        );


        await interaction.editReply({
            content:
                "⚠️ I couldn't load the participation statistics right now.",

            embeds: [],

            components: [],
        });
    }
}


/*
    Stats button handler.

    Handles:
    stats_prev_event_page
    stats_next_event_page
*/
async function handleStatsButton(
    interaction
) {
    if (!interaction.customId.startsWith("stats_")) return;

    const weeklyParts = interaction.customId.split("_");
    if (weeklyParts.length === 5 && weeklyParts[1] === "weekly") {
        const action = weeklyParts[2];
        const snapshotId = weeklyParts[3];
        const pageIndex = Number(weeklyParts[4]);
        if (!["prev", "next"].includes(action) || !Number.isInteger(pageIndex)) return;

        try {
            await interaction.deferUpdate();
            const targetPage = action === "prev" ? pageIndex - 1 : pageIndex + 1;
            const page = await getWeeklyStatsPage(interaction.client, snapshotId, targetPage);
            await interaction.editReply({ embeds: [page.embed], components: page.components });
        } catch (error) {
            console.error("❌ Failed to update weekly stats:", error);
        }
        return;
    }

    const parts =
        interaction.customId.split("_");


    if (parts.length !== 4) {
        return;
    }


    const action =
        parts[1];

    const event =
        parts[2];

    const pageIndex =
        Number(parts[3]);


    if (
        !VALID_EVENTS.has(event) ||
        !["prev", "next"].includes(action) ||
        !Number.isInteger(pageIndex)
    ) {
        return;
    }


    try {
        await interaction.deferUpdate();


        const days =
            await getAvailableDays(
                event
            );


        if (!days.length) {
            const page =
                await getStatsPage(
                    interaction.client,
                    event,
                    0
                );


            await interaction.editReply({
                embeds: [
                    page.embed,
                ],

                components:
                    page.components,
            });


            return;
        }


        let targetPage =
            pageIndex;


        if (action === "prev") {
            targetPage =
                pageIndex - 1;
        }


        if (action === "next") {
            targetPage =
                pageIndex + 1;
        }


        targetPage =
            Math.min(
                Math.max(
                    targetPage,
                    0
                ),
                days.length - 1
            );


        const page =
            await getStatsPage(
                interaction.client,
                event,
                targetPage
            );


        await interaction.editReply({
            embeds: [
                page.embed,
            ],

            components:
                page.components,
        });

    } catch (error) {
        console.error(
            "❌ Failed to update stats:",
            error
        );
    }
}


module.exports = {
    handleStatsCommand,
    handleStatsButton,
    buildStatsEmbed,
    buildStatsButtons,
};

