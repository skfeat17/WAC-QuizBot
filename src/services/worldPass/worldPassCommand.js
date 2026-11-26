
const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    EmbedBuilder,
    MessageFlags,
} = require("discord.js");
const {
    getChallengeAttempt,
} = require("./worldPassRedis");
const {
    WORLD_PASS_CONFIG,
} = require("./worldPassConfig");

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
const ANSWER_PREFIX = "worldpass:answer:";
const TIER_SELECT_ID = "worldpass:tier";
const INVENTORY_BUTTON_ID = "worldpass:inventory";
const GUIDE_BUTTON_ID = "worldpass:guide";

const WORLD_PASS_TIER_EMOJIS = {
    explorer: "🧭",
    voyager: "🌊",
    pathfinder: "🗺️",
    discoverer: "💎",
    celestial: "🌟",
};

const MORA_EMOJI = "<:mora:1503931162525962333>";

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
            .setStyle(ButtonStyle.Secondary)
    );

    return {
        embeds: [embed],
        components: [selectRow, buttonRow],
    };
}

function buildWorldPassGuideEmbed() {
    const tierLines = Object.entries(WORLD_PASS_CONFIG.CHALLENGES).map(
        ([tier, config]) => {
            const dropRate = WORLD_PASS_CONFIG.DROP_RATES[tier] || 0;
            return `${getTierEmoji(tier)} **${config.name}** — ${dropRate}% drop rate • ${config.passCost} 🎟️ • ${formatNumber(config.reward)} ${MORA_EMOJI}`;
        }
    );

    return new EmbedBuilder()
        .setColor(PANEL_COLOR)
        .setTitle("📖 WORLD PASS GUIDE")
        .setDescription([
            "**How to get passes**",
            "Answer the Daily World Event correctly to receive one random-tier World Pass.",
            "",
            "**Tiers, rarity and rewards**",
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
        .setFooter({ text: "Choose a tier from the main panel to begin" });
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
        .setTitle(`${getTierEmoji(attempt.tier)} ${config?.name || "WORLD"} CHALLENGE`)
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
                return interaction.editReply({
                    content: "⚠️ The World Pass Challenge is already active.",
                });
            }

            await setWorldPassChallengeActive(true);

            console.log("🌍 WORLD PASS CHALLENGE ACTIVATED");

            return interaction.editReply(
                buildWorldPassPanel()
            );
        }

        if (action === "end") {
            const alreadyActive = await isWorldPassChallengeActive();

            if (!alreadyActive) {
                return interaction.editReply({
                    content: "⚠️ The World Pass Challenge is already inactive.",
                });
            }

            await setWorldPassChallengeActive(false);

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

        if (action === "statistics") {
            const stats = await getWorldPassStatistics();
            const active = await isWorldPassChallengeActive();

            const embed = new EmbedBuilder()
                .setColor(PANEL_COLOR)
                .setTitle("📊 WORLD PASS CHALLENGE STATISTICS")
                .setDescription([
                    `**Status:** ${active ? "🟢 Active" : "🔴 Inactive"}`,
                    "",
                    `🎟️ **Total Entries:** ${formatNumber(stats.entries)}`,
                    `✅ **Correct Answers:** ${formatNumber(stats.correct)}`,
                    `❌ **Incorrect Answers:** ${formatNumber(stats.incorrect)}`,
                    `⌛ **Expired Attempts:** ${formatNumber(stats.expired)}`,
                    `🎫 **Passes Spent:** ${formatNumber(stats.passesSpent)}`,
                    `💰 **Mora Rewards Queued:** ${formatNumber(stats.moraQueued)} ${MORA_EMOJI}`,
                ].join("\n"))
                .setFooter({
                    text: "World Pass Challenge • Lifetime statistics",
                });

            return interaction.editReply({
                embeds: [embed],
            });
        }

        return interaction.editReply({
            content: "❌ Unknown action.",
        });

    } catch (error) {
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
    if (interaction.customId !== TIER_SELECT_ID) return false;

    await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
    });

    try {
        if (!(await isWorldPassChallengeActive())) {
            await interaction.editReply({
                content: "❌ The World Pass Challenge is currently inactive.",
            });
            return true;
        }

        const tier = interaction.values[0];

        const result = await startWorldPassChallenge(
            interaction.user.id,
            tier
        );

        if (!result.success) {
            const messages = {
                INVALID_TIER: "❌ Invalid challenge tier.",
                NOT_ENOUGH_PASSES: `❌ You don't have enough passes. You need **${result.required}** and have **${result.available}** available.`,
                QUESTION_POOL_EMPTY: "⏳ Questions for this tier are being restocked. Please try again shortly.",
                ENTRY_CREATION_FAILED: "❌ Could not create your challenge entry. Please try again.",
            };

            await interaction.editReply({
                content: messages[result.code] ||
                    "❌ Could not start your challenge.",
            });

            return true;
        }

        await recordWorldPassStat("entries");

        await interaction.editReply({
            embeds: [
                buildChallengeQuestionEmbed(result.attempt),
            ],
            components: buildChallengeAnswerButtons(result.attempt),
        });

        console.log(
            `🎟️ WORLD PASS ENTRY | ${interaction.user.id} | ${tier} | ${result.attempt.attemptId}`
        );

        return true;

    } catch (error) {
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
    if (interaction.customId !== INVENTORY_BUTTON_ID) return false;

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

    await interaction.deferUpdate();

    try {
        if (!attemptId || !Number.isInteger(selectedIndex)) {
            await interaction.followUp({
                content: "❌ Invalid answer selection.",
                flags: MessageFlags.Ephemeral,
            });
            return true;
        }

        const storedAttempt = await getChallengeAttempt(attemptId);

        if (!storedAttempt) {
            await interaction.followUp({
                content: "❌ This challenge attempt could not be found.",
                flags: MessageFlags.Ephemeral,
            });
            return true;
        }

        const selectedOption = storedAttempt.options[selectedIndex];

        if (typeof selectedOption !== "string") {
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
            const messages = {
                ATTEMPT_NOT_FOUND: "❌ This challenge attempt could not be found.",
                NOT_YOUR_ATTEMPT: "❌ This challenge belongs to another player.",
                ATTEMPT_ALREADY_FINISHED: "⚠️ This challenge has already been completed.",
                ATTEMPT_EXPIRED: "⌛ This challenge has expired.",
                INVALID_ANSWER: "❌ Invalid answer.",
            };

            await interaction.followUp({
                content: messages[result.code] ||
                    "❌ Could not process your answer.",
                flags: MessageFlags.Ephemeral,
            });

            return true;
        }

        const config = WORLD_PASS_CONFIG.CHALLENGES[result.tier];

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
            await recordWorldPassStat("passesSpent", config?.passCost || 0);
            await recordWorldPassStat("moraQueued", result.reward || 0);
        }

        console.log(
            `🏁 WORLD PASS ANSWER | ${interaction.user.id} | ${attemptId} | ${result.correct ? "CORRECT" : "INCORRECT"}`
        );

    } catch (error) {
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
        return handleWorldPassTierSelect(interaction);
    }

    if (interaction.isButton()) {
        if (interaction.customId === INVENTORY_BUTTON_ID) {
            return handleWorldPassInventory(interaction);
        }

        if (interaction.customId === GUIDE_BUTTON_ID) {
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
