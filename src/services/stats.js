
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


const VALID_EVENTS = new Set([
    "mystery",
    "chest",
]);


const EVENT_NAMES = {
    mystery: "MYSTERY EVENT",
    chest: "TREASURE CHEST",
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
    if (
        !interaction.customId.startsWith(
            "stats_"
        )
    ) {
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

