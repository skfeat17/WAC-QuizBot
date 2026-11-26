
const {
    SlashCommandBuilder,
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    EmbedBuilder,
    MessageFlags,
} = require("discord.js");


const {
    getChallengeAttempt,
    getAllPassInventories,
    getAllLifetimePassInventories,
} = require("./worldPassRedis");


const {
    WORLD_PASS_CONFIG,
} = require("./worldPassConfig");

const {
    renderWorldPassLeaderboard,
} = require("./worldPassLeaderboardImage");

const {
    startWorldPassChallenge,
    answerWorldPassChallenge,
    getWorldPassPlayerInventory,
} = require("./worldPassService");

const {
    isWorldPassChallengeActive,
    setWorldPassChallengeActive,
    incrementWorldPassStat,
    getWorldPassStatistics,
} = require("./worldPassControlRedis");

// ============================================================
// COMMAND
// ============================================================

const worldPassCommand = new SlashCommandBuilder()
    .setName("pass-challenge")
    .setDescription("Manage the World Pass Challenge")
    .addStringOption(option =>
        option
            .setName("action")
            .setDescription("Choose an action")
            .setRequired(true)
            .addChoices(
                { name: "Start", value: "start" },
                { name: "End", value: "end" },
                { name: "Statistics", value: "statistics" }
            )
    );

// ============================================================
// CONSTANTS
// ============================================================

const PANEL_COLOR = 0x5865f2;
const STATS_PAGE_PREFIX = "worldpass:stats:";
const STATS_PAGE_SIZE = 10;
const ANSWER_PREFIX = "worldpass:answer:";
const TIER_SELECT_ID = "worldpass:tier";
const INVENTORY_BUTTON_ID = "worldpass:inventory";
const GUIDE_BUTTON_ID = "worldpass:guide";
const LEADERBOARD_BUTTON_ID = "worldpass:leaderboard";

const WORLD_PASS_TIER_EMOJIS = {
    explorer: "🧭",
    voyager: "🌊",
    pathfinder: "🗺️",
    discoverer: "💎",
    celestial: "🌟",
};

const MORA_EMOJI = "<:mora:1503931162525962333>";

function buildPassRankings(inventories, page = 0) {
    const sorted = [...inventories].sort((a, b) => {
        if (a.total !== b.total) {
            return a.total - b.total;
        }

        return a.userId.localeCompare(b.userId);
    });

    const totalPages = Math.max(
        1,
        Math.ceil(sorted.length / STATS_PAGE_SIZE)
    );

    page = Math.max(0, Math.min(page, totalPages - 1));

    const start = page * STATS_PAGE_SIZE;
    const shown = sorted.slice(
        start,
        start + STATS_PAGE_SIZE
    );

    if (!shown.length) {
        return {
            description: "No players currently have World Passes.",
            page,
            totalPages,
        };
    }

    const lines = shown.map((player, index) => {
        const rank = start + index + 1;

        const tierBreakdown = Object.keys(
            WORLD_PASS_CONFIG.CHALLENGES
        ).map(tier => {
            const count =
                player.inventory[tier]?.owned || 0;

            return `${getTierEmoji(tier)} ${count}`;
        }).join(" • ");

        return [
            `**${rank}.** <@${player.userId}> — **${player.total} passes**`,
            `Available: ${player.available} • Reserved: ${player.reserved}`,
            tierBreakdown,
        ].join("\n");
    });

    return {
        description: lines.join("\n\n"),
        page,
        totalPages,
    };
}

function buildPassStatisticsEmbed(
    stats,
    active,
    inventories,
    page = 0
) {
    const totalHolders = inventories.length;

    const totalPasses = inventories.reduce(
        (sum, player) => sum + player.total,
        0
    );

    const ranking = buildPassRankings(inventories, page);

    const embed = new EmbedBuilder()
        .setColor(PANEL_COLOR)
        .setTitle("📊 WORLD PASS CHALLENGE STATISTICS")
        .setDescription([
            `**Status:** ${active ? "🟢 Active" : "🔴 Inactive"}`,
            "",
            `🎟️ **Total Entries:** ${formatNumber(stats.entries)}`,
            `🎫 **Passes Spent:** ${formatNumber(stats.passesSpent)}`,
            `💰 **Mora Rewards Queued:** ${formatNumber(stats.moraQueued)} ${MORA_EMOJI}`,
            "",
            "━━━━━━━━━━━━━━━━━━━━",
            "**🎟️ PASS HOLDER RANKINGS**",
            `👥 Holders: **${formatNumber(totalHolders)}**`,
            `🎟️ Total Passes Owned: **${formatNumber(totalPasses)}**`,
            "",
            ranking.description,
        ].join("\n"))
        .setFooter({
            text: `Lowest to highest passes • Page ${ranking.page + 1}/${ranking.totalPages}`,
        });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${STATS_PAGE_PREFIX}${ranking.page - 1}`)
            .setLabel("Previous")
            .setEmoji("◀️")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(ranking.page <= 0),

        new ButtonBuilder()
            .setCustomId(`${STATS_PAGE_PREFIX}${ranking.page + 1}`)
            .setLabel("Next")
            .setEmoji("▶️")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(ranking.page >= ranking.totalPages - 1)
    );

    return {
        embeds: [embed],
        components: [row],
    };
}

// ============================================================
// ACTIVITY LOGGER
// ============================================================

function logWorldPassActivity(interaction, activity, details = {}) {
    const user = interaction?.user;

    const globalName =
        user?.globalName ||
        user?.username ||
        "Unknown User";

    const username = user?.username || "Unknown";
    const userId = user?.id || "Unknown";

    const detailText = Object.entries(details)
        .map(([key, value]) => {
            const safeValue = String(value ?? "None")
                .replace(/[\r\n]/g, " ")
                .replace(/\|/g, "/");

            return `${key}: ${safeValue}`;
        })
        .join(" | ");

    console.log(
        [
            "🎟️[WORLD PASS LOG]",
             `${activity}`,
            `${globalName}`,
            detailText,
        ].filter(Boolean).join(" | ")
    );
}

// ============================================================
// HELPERS
// ============================================================

function getDisplayName(user, member) {
    return member?.displayName ||
        user?.globalName ||
        user?.username ||
        "Player";
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString("en-US");
}

async function recordWorldPassStat(field, amount = 1) {
    try {
        await incrementWorldPassStat(field, amount);
    } catch (error) {
        console.error(
            `[World Pass] Could not record statistic ${field}:`,
            error.message
        );
    }
}

function getTierEmoji(tier) {
    return WORLD_PASS_TIER_EMOJIS[tier] || "🎟️";
}

function getTierLabel(tier, config) {
    return `${getTierEmoji(tier)} ${config.name}`;
}

function getInventoryLines(inventory) {
    return Object.entries(WORLD_PASS_CONFIG.CHALLENGES).map(
        ([tier, config]) => {
            const item = inventory?.[tier] || {};

            const available = Number(item.available) || 0;
            const reserved = Number(item.reserved) || 0;
            const total = Number(item.total) ||
                available + reserved;

            return [
                `${getTierEmoji(tier)} **${config.name}**`,
                `Available: **${formatNumber(available)}**`,
                `Reserved: **${formatNumber(reserved)}**`,
                `Total: **${formatNumber(total)}**`,
            ].join(" • ");
        }
    );
}

// ============================================================
// PUBLIC PANEL
// ============================================================

function buildWorldPassPanel() {
    const tierLines = Object.entries(WORLD_PASS_CONFIG.CHALLENGES).map(
        ([tier, config]) =>
            `${getTierEmoji(tier)} **${config.name}** — ${config.passCost} 🎟️ → **${formatNumber(config.reward)} ${MORA_EMOJI}**`
    );

    const embed = new EmbedBuilder()
        .setColor(PANEL_COLOR)
        .setTitle("🌍 WORLD PASS CHALLENGE")
        .setDescription([
            "Spend World Passes to answer bonus questions and earn Mora.",
            "",
            ...tierLines,
            "",
            "Select a tier below to enter a challenge.",
            "",
             "Get 1 🎟️ World Pass for Every Daily Event Question You Answer Correctly.",
        ].join("\n"))
        .setFooter({
            text: "Correct answer: earn Mora • Incorrect answer: passes returned",
        });

    const tierMenu = new StringSelectMenuBuilder()
        .setCustomId(TIER_SELECT_ID)
        .setPlaceholder("🎟️ Select a World Pass tier")
        .addOptions(
            Object.entries(WORLD_PASS_CONFIG.CHALLENGES).map(
                ([tier, config]) => ({
                    label: config.name,
                    value: tier,
                    description: `${config.passCost} passes • ${config.reward} Mora • ${config.difficulty}`,
                    emoji: getTierEmoji(tier),
                })
            )
        );

    const selectRow = new ActionRowBuilder().addComponents(tierMenu);

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(INVENTORY_BUTTON_ID)
            .setLabel("My Passes")
            .setEmoji("🎒")
            .setStyle(ButtonStyle.Secondary),



        new ButtonBuilder()
            .setCustomId(GUIDE_BUTTON_ID)
            .setLabel("Guide")
            .setEmoji("📖")
            .setStyle(ButtonStyle.Secondary),
   new ButtonBuilder()
            .setCustomId(LEADERBOARD_BUTTON_ID)
            .setLabel("World Pass Leaderboard")
            .setEmoji("🏆")
            .setStyle(ButtonStyle.Secondary),
    );

    return {
        embeds: [embed],
        components: [selectRow, buttonRow],
    };
}

// ============================================================
// GUIDE
// ============================================================

function buildWorldPassGuideEmbed() {
    const tierLines = Object.entries(WORLD_PASS_CONFIG.CHALLENGES).map(
        ([tier, config]) => {
            const dropRate = WORLD_PASS_CONFIG.DROP_RATES[tier] || 0;

            return `${getTierEmoji(tier)} **${config.name}** — ${config.passCost} 🎟️ • ${formatNumber(config.reward)} ${MORA_EMOJI}`;
        }
    );

    return new EmbedBuilder()
        .setColor(PANEL_COLOR)
        .setTitle("📖 WORLD PASS GUIDE")
        .setDescription([
            "**How to get passes**",
            "Answer the Daily World Event correctly to get 50% Chance to receive one random-tier World Pass.",
            "",
            "**Tiers and rewards**",
            ...tierLines,
            "",
            "**How challenges work**",
            "• Select a tier and spend the required passes.",
            "• Each entry gives you one bonus question.",
            "• You have 10 minutes to answer.",
            "• Correct answer: passes are spent and the Mora reward is queued.",
            "• Incorrect answer: reserved passes are returned immediately, so you can retry.",
            "• You can have multiple active entries at the same time.",
        ].join("\n"))
        .setFooter({
            text: "Choose a tier from the main panel to begin",
        });
}

// ============================================================
// QUESTION EMBED
// ============================================================

function buildChallengeQuestionEmbed(attempt) {
    const config = WORLD_PASS_CONFIG.CHALLENGES[attempt.tier];

    const expiresAt = Math.floor(
        Number(attempt.expiresAt) / 1000
    );

    return new EmbedBuilder()
        .setColor(PANEL_COLOR)
        .setTitle(
            `${getTierEmoji(attempt.tier)} ${config?.name || "WORLD"} CHALLENGE`
        )
        .setDescription([
            `**${attempt.question}**`,
            "",
            "Choose the correct answer.",
            "",
            `🎟️ Reserved passes: **${config?.passCost || 0}**`,
            `🎁 Correct reward: **${formatNumber(config?.reward)} ${MORA_EMOJI}**`,
            "",
            `⏳ Expires <t:${expiresAt}:R>`,
        ].join("\n"))
        .setFooter({
            text: `Attempt ID: ${attempt.attemptId}`,
        });
}

function buildChallengeAnswerButtons(attempt) {
    const row = new ActionRowBuilder();

    attempt.options.forEach((option, index) => {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(
                    `${ANSWER_PREFIX}${attempt.attemptId}:${index}`
                )
                .setLabel(
                    `${String.fromCharCode(65 + index)}. ${option}`
                )
                .setStyle(ButtonStyle.Secondary)
        );
    });

    return [row];
}

// ============================================================
// START / END / STATISTICS
// ============================================================

async function handleWorldPassCommand(interaction) {
    const action = interaction.options.getString("action");

    logWorldPassActivity(interaction, "COMMAND USED", {
        action,
    });

    if (action === "start") {
        await interaction.deferReply();
    } else {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral,
        });
    }

    try {
        if (action === "start") {
            const alreadyActive = await isWorldPassChallengeActive();

            if (alreadyActive) {
                logWorldPassActivity(
                    interaction,
                    "START FAILED",
                    { reason: "Already active" }
                );

                return interaction.editReply({
                    content: "⚠️ The World Pass Challenge is already active.",
                });
            }

            await setWorldPassChallengeActive(true);

            logWorldPassActivity(
                interaction,
                "CHALLENGE ACTIVATED"
            );

            console.log("🌍 WORLD PASS CHALLENGE ACTIVATED");

            return interaction.editReply(
                buildWorldPassPanel()
            );
        }

        if (action === "end") {
            const alreadyActive = await isWorldPassChallengeActive();

            if (!alreadyActive) {
                logWorldPassActivity(
                    interaction,
                    "END FAILED",
                    { reason: "Already inactive" }
                );

                return interaction.editReply({
                    content: "⚠️ The World Pass Challenge is already inactive.",
                });
            }

            await setWorldPassChallengeActive(false);

            logWorldPassActivity(
                interaction,
                "CHALLENGE DEACTIVATED"
            );

            console.log("🛑 WORLD PASS CHALLENGE DEACTIVATED");

            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xed4245)
                        .setTitle("🛑 WORLD PASS CHALLENGE ENDED")
                        .setDescription([
                            "The World Pass Challenge is now inactive.",
                            "",
                            "• New entries are disabled.",
                            "• Existing questions remain answerable.",
                            "• Reserved passes are preserved.",
                            "• Question pools and reward records are preserved.",
                        ].join("\n")),
                ],
            });
        }

    
if (action === "leaderboard") {
    logWorldPassActivity(interaction, "LIFETIME LEADERBOARD VIEWED");

    const inventories = await getAllLifetimePassInventories();

    const ranked = [...inventories]
        .filter(player => Number(player.total) > 0)
        .sort((a, b) => {
            const difference =
                Number(b.total || 0) - Number(a.total || 0);

            return difference ||
                String(a.userId).localeCompare(String(b.userId));
        });

    const rarityOrder = [
        "celestial",
        "discoverer",
        "pathfinder",
        "voyager",
        "explorer",
    ];

    const rarestPasses = rarityOrder.map(tier => {
        const holders = ranked
            .map(player => ({
                userId: player.userId,
                count: Number(player.lifetime?.[tier] || 0),
            }))
            .filter(player => player.count > 0)
            .sort((a, b) =>
                b.count - a.count ||
                String(a.userId).localeCompare(String(b.userId))
            );

        return {
            tier,
            dropRate: Number(WORLD_PASS_CONFIG.DROP_RATES?.[tier] || 0),
            totalEarned: holders.reduce(
                (sum, holder) => sum + holder.count,
                0
            ),
            holderCount: holders.length,
            leadingHolder: holders[0] || null,
        };
    });

    const data = {
        generatedAt: Date.now(),
        holders: ranked.length,
        totalEarned: ranked.reduce(
            (sum, player) => sum + Number(player.total || 0),
            0
        ),
        totalAvailable: ranked.reduce(
            (sum, player) => sum + Number(player.available || 0),
            0
        ),
        entries: ranked.slice(0, 10),
        rarestPasses,
    };

    const image = await renderWorldPassLeaderboard(
        data,
        interaction.client
    );

    const attachment = new AttachmentBuilder(image, {
        name: "world-pass-lifetime-leaderboard.png",
    });

    return interaction.editReply({
        content: "🏆 **WORLD ADVENTURE CLUB — LIFETIME WORLD PASS LEADERBOARD**",
        files: [attachment],
    });
}

if (action === "statistics") {
    logWorldPassActivity(interaction, "STATISTICS VIEWED");

    const [stats, active, inventories] = await Promise.all([
        getWorldPassStatistics(),
        isWorldPassChallengeActive(),
        getAllPassInventories(),
    ]);

    return interaction.editReply(
        buildPassStatisticsEmbed(
            stats,
            active,
            inventories,
            0
        )
    );
}


        logWorldPassActivity(
            interaction,
            "UNKNOWN COMMAND ACTION",
            { action }
        );

        return interaction.editReply({
            content: "❌ Unknown action.",
        });

    } catch (error) {
        logWorldPassActivity(
            interaction,
            "COMMAND ERROR",
            {
                action,
                error: error.message,
            }
        );

        console.error("❌ WORLD PASS COMMAND FAILED:", error);

        return interaction.editReply({
            content: "❌ Something went wrong while processing the World Pass Challenge action.",
        });
    }
}

// ============================================================
// TIER SELECTION
// ============================================================

async function handleWorldPassTierSelect(interaction) {
    if (interaction.customId !== TIER_SELECT_ID) {
        return false;
    }

    const tier = interaction.values[0];

    logWorldPassActivity(
        interaction,
        "CHALLENGE ENTRY REQUESTED",
        { tier }
    );

    await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
    });

    try {
        if (!(await isWorldPassChallengeActive())) {
            logWorldPassActivity(
                interaction,
                "CHALLENGE ENTRY FAILED",
                {
                    tier,
                    reason: "Challenge inactive",
                }
            );

            await interaction.editReply({
                content: "❌ The World Pass Challenge is currently inactive.",
            });

            return true;
        }

        const result = await startWorldPassChallenge(
            interaction.user.id,
            tier
        );

        if (!result.success) {
            logWorldPassActivity(
                interaction,
                "CHALLENGE ENTRY FAILED",
                {
                    tier,
                    reason: result.code,
                    required: result.required,
                    available: result.available,
                }
            );

            const messages = {
                INVALID_TIER: "❌ Invalid challenge tier.",

                NOT_ENOUGH_PASSES:
                    `❌ You don't have enough passes. You need **${result.required}** and have **${result.available}** available.`,

                QUESTION_POOL_EMPTY:
                    "⏳ Questions for this tier are being restocked. Please try again shortly.",

                ENTRY_CREATION_FAILED:
                    "❌ Could not create your challenge entry. Please try again.",
            };

            await interaction.editReply({
                content: messages[result.code] ||
                    "❌ Could not start your challenge.",
            });

            return true;
        }

        await recordWorldPassStat("entries");

        logWorldPassActivity(
            interaction,
            "CHALLENGE ENTRY CREATED",
            {
                tier,
                attemptId: result.attempt.attemptId,
                expiresAt: result.attempt.expiresAt,
            }
        );

        await interaction.editReply({
            embeds: [
                buildChallengeQuestionEmbed(result.attempt),
            ],
            components: buildChallengeAnswerButtons(result.attempt),
        });

        return true;

    } catch (error) {
        logWorldPassActivity(
            interaction,
            "CHALLENGE ENTRY ERROR",
            {
                tier,
                error: error.message,
            }
        );

        console.error("❌ WORLD PASS TIER SELECTION FAILED:", error);

        await interaction.editReply({
            content: "❌ Failed to start your challenge. Please try again.",
        });

        return true;
    }
}

// ============================================================
// INVENTORY BUTTON
// ============================================================

async function handleWorldPassInventory(interaction) {
    if (interaction.customId !== INVENTORY_BUTTON_ID) {
        return false;
    }

    logWorldPassActivity(
        interaction,
        "INVENTORY VIEWED"
    );

    await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
    });

    try {
        const inventory = await getWorldPassPlayerInventory(
            interaction.user.id
        );

        const embed = new EmbedBuilder()
            .setColor(PANEL_COLOR)
            .setTitle("🎒 YOUR WORLD PASS INVENTORY")
            .setDescription(
                getInventoryLines(inventory).join("\n\n")
            )
            .setFooter({
                text: "Reserved passes are currently committed to active challenges.",
            });

        await interaction.editReply({
            embeds: [embed],
        });

    } catch (error) {
        logWorldPassActivity(
            interaction,
            "INVENTORY ERROR",
            { error: error.message }
        );

        console.error("❌ WORLD PASS INVENTORY FAILED:", error);

        await interaction.editReply({
            content: "❌ Could not load your pass inventory.",
        });
    }

    return true;
}

// ============================================================
// ANSWER BUTTON
// ============================================================

async function handleWorldPassAnswer(interaction) {
    if (!interaction.customId.startsWith(ANSWER_PREFIX)) {
        return false;
    }

    const value = interaction.customId.slice(ANSWER_PREFIX.length);
    const separator = value.lastIndexOf(":");

    const attemptId = value.slice(0, separator);
    const selectedIndex = Number(value.slice(separator + 1));

    logWorldPassActivity(
        interaction,
        "ANSWER SUBMITTED",
        {
            attemptId,
            selectedIndex,
        }
    );

    await interaction.deferUpdate();

    try {
        if (
            !attemptId ||
            !Number.isInteger(selectedIndex) ||
            selectedIndex < 0
        ) {
            logWorldPassActivity(
                interaction,
                "INVALID ANSWER SELECTION",
                { attemptId, selectedIndex }
            );

            await interaction.followUp({
                content: "❌ Invalid answer selection.",
                flags: MessageFlags.Ephemeral,
            });

            return true;
        }

        const storedAttempt = await getChallengeAttempt(attemptId);

        if (!storedAttempt) {
            logWorldPassActivity(
                interaction,
                "ATTEMPT NOT FOUND",
                { attemptId }
            );

            await interaction.followUp({
                content: "❌ This challenge attempt could not be found.",
                flags: MessageFlags.Ephemeral,
            });

            return true;
        }

        const selectedOption = storedAttempt.options?.[selectedIndex];

        if (typeof selectedOption !== "string") {
            logWorldPassActivity(
                interaction,
                "INVALID ANSWER OPTION",
                {
                    attemptId,
                    selectedIndex,
                }
            );

            await interaction.followUp({
                content: "❌ Invalid answer selection.",
                flags: MessageFlags.Ephemeral,
            });

            return true;
        }

        const result = await answerWorldPassChallenge(
            interaction.user.id,
            attemptId,
            selectedOption
        );

        if (!result.success) {
            logWorldPassActivity(
                interaction,
                "ANSWER PROCESSING REJECTED",
                {
                    attemptId,
                    reason: result.code,
                }
            );

            const messages = {
                ATTEMPT_NOT_FOUND:
                    "❌ This challenge attempt could not be found.",

                NOT_YOUR_ATTEMPT:
                    "❌ This challenge belongs to another player.",

                ATTEMPT_ALREADY_FINISHED:
                    "⚠️ This challenge has already been completed.",

                ATTEMPT_EXPIRED:
                    "⌛ This challenge has expired.",

                INVALID_ANSWER:
                    "❌ Invalid answer.",
            };

            await interaction.followUp({
                content: messages[result.code] ||
                    "❌ Could not process your answer.",
                flags: MessageFlags.Ephemeral,
            });

            return true;
        }

        const config = WORLD_PASS_CONFIG.CHALLENGES[result.tier];

        logWorldPassActivity(
            interaction,
            result.correct
                ? "CORRECT ANSWER"
                : "INCORRECT ANSWER",
            {
                tier: result.tier,
                attemptId,
                selectedOption,
                reward: result.reward || 0,
                passCost: config?.passCost || 0,
            }
        );

        const embed = new EmbedBuilder()
            .setColor(result.correct ? 0x57f287 : 0xed4245)
            .setTitle(
                result.correct
                    ? "✅ CHALLENGE COMPLETED!"
                    : "❌ INCORRECT ANSWER"
            )
            .setDescription([
                result.correct
                    ? "Congratulations! Your answer was correct."
                    : "That's not the correct answer. Your reserved passes have been returned.",
                "",
                result.correct
                    ? `🎁 **Reward:** ${formatNumber(result.reward)} ${MORA_EMOJI}`
                    : `🎟️ **Returned:** ${config?.passCost || 0} passes`,
                "",
                result.correct
                    ? "Your Mora reward is being processed."
                    : "You can immediately try another challenge.",
                "",
                result.explanation
                    ? `📖 **Did you know?**\n${result.explanation}`
                    : "",
            ].filter(Boolean).join("\n"))
            .setFooter({
                text: `Tier: ${config?.name || result.tier}`,
            });

        await interaction.editReply({
            embeds: [embed],
            components: [],
        });

        await recordWorldPassStat(
            result.correct ? "correct" : "incorrect"
        );

        if (result.correct) {
            await recordWorldPassStat(
                "passesSpent",
                config?.passCost || 0
            );

            await recordWorldPassStat(
                "moraQueued",
                result.reward || 0
            );
        }

    } catch (error) {
        logWorldPassActivity(
            interaction,
            "ANSWER PROCESSING ERROR",
            {
                attemptId,
                error: error.message,
            }
        );

        console.error("❌ WORLD PASS ANSWER FAILED:", error);

        await interaction.followUp({
            content: "❌ Something went wrong while processing your answer.",
            flags: MessageFlags.Ephemeral,
        }).catch(() => { });
    }

    return true;
}

// ============================================================
// COMPONENT ROUTER
// ============================================================

async function handleWorldPassComponent(interaction) {
    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === TIER_SELECT_ID) {
            return handleWorldPassTierSelect(interaction);
        }

        return false;
    }

    if (interaction.isButton()) {
        if (interaction.customId === LEADERBOARD_BUTTON_ID) {
            logWorldPassActivity(
                interaction,
                "LIFETIME LEADERBOARD BUTTON CLICKED"
            );

            await interaction.deferReply({
                flags: MessageFlags.Ephemeral,
            });

            try {
                const inventories = await getAllLifetimePassInventories();

                const ranked = [...inventories]
                    .filter(player => Number(player.total) > 0)
                    .sort((a, b) => {
                        const difference =
                            Number(b.total || 0) - Number(a.total || 0);

                        return difference ||
                            String(a.userId).localeCompare(String(b.userId));
                    });

                const rarityOrder = [
                    "celestial",
                    "discoverer",
                    "pathfinder",
                    "voyager",
                    "explorer",
                ];

                const rarestPasses = rarityOrder.map(tier => {
                    const holders = ranked
                        .map(player => ({
                            userId: player.userId,
                            count: Number(player.lifetime?.[tier] || 0),
                        }))
                        .filter(player => player.count > 0)
                        .sort((a, b) =>
                            b.count - a.count ||
                            String(a.userId).localeCompare(String(b.userId))
                        );

                    return {
                        tier,
                        dropRate: Number(WORLD_PASS_CONFIG.DROP_RATES?.[tier] || 0),
                        totalEarned: holders.reduce(
                            (sum, holder) => sum + holder.count,
                            0
                        ),
                        holderCount: holders.length,
                        leadingHolder: holders[0] || null,
                    };
                });

                const data = {
                    generatedAt: Date.now(),
                    holders: ranked.length,
                    totalEarned: ranked.reduce(
                        (sum, player) => sum + Number(player.total || 0),
                        0
                    ),
                    totalAvailable: ranked.reduce(
                        (sum, player) => sum + Number(player.available || 0),
                        0
                    ),
                    entries: ranked.slice(0, 10),
                    rarestPasses,
                };

                const image = await renderWorldPassLeaderboard(
                    data,
                    interaction.client
                );

                const attachment = new AttachmentBuilder(image, {
                    name: "world-pass-lifetime-leaderboard.png",
                });

                await interaction.editReply({
                    content: "🏆 **WORLD ADVENTURE CLUB — LIFETIME WORLD PASS LEADERBOARD**",
                    files: [attachment],
                });
            } catch (error) {
                console.error("❌ WORLD PASS LEADERBOARD BUTTON FAILED:", error);
                await interaction.editReply({
                    content: "❌ Could not load the World Pass leaderboard.",
                });
            }

            return true;
        }

        if (interaction.customId === INVENTORY_BUTTON_ID) {
            return handleWorldPassInventory(interaction);
        }

        if (interaction.customId === GUIDE_BUTTON_ID) {
            logWorldPassActivity(
                interaction,
                "GUIDE VIEWED"
            );

            await interaction.reply({
                embeds: [buildWorldPassGuideEmbed()],
                flags: MessageFlags.Ephemeral,
            });

            return true;
        }

        if (interaction.customId.startsWith(ANSWER_PREFIX)) {
            return handleWorldPassAnswer(interaction);
        }
    }

    return false;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    worldPassCommand,
    handleWorldPassCommand,
    handleWorldPassComponent,
};
