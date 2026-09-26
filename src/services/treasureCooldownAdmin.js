require("dotenv").config();

const {
    SlashCommandBuilder,
    MessageFlags,
} = require("discord.js");
const {
    setTreasureCooldownForDuration,
} = require("./treasureChestEventredis");
const {
    getTreasureCooldown,
    clearTreasureCooldown,
} = require("./treasureChestEventredis");

// ==========================================
// /TREASURECOOLDOWN COMMAND
// ==========================================
//
// Subcommands:
//
// /treasurecooldown check user:@User
// /treasurecooldown list
// /treasurecooldown remove user:@User
//
// Recommended access: staff/admin only.
// ==========================================

const treasureCooldownCommand = new SlashCommandBuilder()
    .setName("treasurecooldown")
    .setDescription("Manage Treasure Chest cooldowns.")
    .addSubcommand(subcommand =>
        subcommand
            .setName("check")
            .setDescription("Check a person's Treasure Chest cooldown.")
            .addUserOption(option =>
                option
                    .setName("user")
                    .setDescription("Person to check.")
                    .setRequired(true)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName("list")
            .setDescription("List everyone currently on Treasure Chest cooldown.")
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName("remove")
            .setDescription("Remove one person's Treasure Chest cooldown.")
            .addUserOption(option =>
                option
                    .setName("user")
                    .setDescription("Person whose cooldown should be removed.")
                    .setRequired(true)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName("set")
            .setDescription("Set a treasure cooldown for a user")
            .addUserOption(option =>
                option
                    .setName("user")
                    .setDescription("User to give the cooldown")
                    .setRequired(true)
            )
            .addIntegerOption(option =>
                option
                    .setName("hr")
                    .setDescription("Hours")
                    .setMinValue(0)
                    .setMaxValue(720)
                    .setRequired(true)
            )
            .addIntegerOption(option =>
                option
                    .setName("min")
                    .setDescription("Minutes")
                    .setMinValue(0)
                    .setMaxValue(59)
                    .setRequired(true)
            )
    );

// ==========================================
// HELPERS
// ==========================================

function formatCooldown(seconds) {
    seconds = Math.max(0, Number(seconds) || 0);

    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];

    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);

    // Show seconds when there is less than a minute remaining.
    if (!days && !hours && !minutes && secs) {
        parts.push(`${secs}s`);
    }

    return parts.join(" ") || "expired";
}

// ==========================================
// REDIS COOLDOWN LIST
// ==========================================

async function getTreasureCooldownList() {
    const redis = getRedisClient();

    const prefix = "wac:treasure:cooldown:";
    const users = [];

    let cursor = 0;

    do {
        const result = await redis.scan(cursor, {
            match: `${prefix}*`,
            count: 100,
        });

        cursor = Number(result[0]);
        const keys = result[1] || [];

        for (const key of keys) {
            const userId = key.slice(prefix.length);

            if (!userId) continue;

            const ttl = await redis.ttl(key);

            if (ttl > 0) {
                users.push({
                    userId,
                    ttl,
                });
            }
        }
    } while (cursor !== 0);

    users.sort((a, b) => b.ttl - a.ttl);

    return users;
}

// ==========================================
// GET REDIS CLIENT
// ==========================================
//
// The normal cooldown functions intentionally do not expose
// the Redis client. This small helper creates the same Upstash
// connection for the admin LIST operation.
// ==========================================

let redisClient = null;

function getRedisClient() {
    if (redisClient) {
        return redisClient;
    }

    const { Redis } = require("@upstash/redis");

    redisClient = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    return redisClient;
}

// ==========================================
// HANDLE /TREASURECOOLDOWN
// ==========================================

async function handleTreasureCooldown(interaction) {
    const subcommand = interaction.options.getSubcommand();

    // ======================================
    // CHECK
    // ======================================

    if (subcommand === "check") {
        const user = interaction.options.getUser("user");

        const ttl = await getTreasureCooldown(user.id);

        if (ttl <= 0) {
            await interaction.editReply({
                content:
                    `🟢 **${user.username}** has no Treasure Chest cooldown.\n` +
                    `👤 <@${user.id}>`,
                flags: MessageFlags.Ephemeral,
            });

            return;
        }

        await interaction.editReply({
            content:
                `⏳ **Treasure Chest Cooldown**\n\n` +
                `👤 **User:** <@${user.id}>\n` +
                `🆔 **ID:** \`${user.id}\`\n` +
                `⏱️ **Remaining:** **${formatCooldown(ttl)}**`,
            flags: MessageFlags.Ephemeral,
        });

        return;
    }

    // ======================================
    // REMOVE
    // ======================================

    if (subcommand === "remove") {
        const user = interaction.options.getUser("user");

        const ttl = await getTreasureCooldown(user.id);

        if (ttl <= 0) {
            await interaction.editReply({
                content:
                    `ℹ️ <@${user.id}> does not currently have a Treasure Chest cooldown.`,
                flags: MessageFlags.Ephemeral,
            });

            return;
        }


        await clearTreasureCooldown(user.id);

        await interaction.editReply({
            content:
                `✅ Treasure Chest cooldown removed.\n\n` +
                `👤 **User:** <@${user.id}>\n` +
                `⏱️ **Previous remaining time:** **${formatCooldown(ttl)}**`,
            flags: MessageFlags.Ephemeral,
        });

        console.log(
            `🧹 TREASURE COOLDOWN REMOVED | User: ${user.username} | ID: ${user.id}`
        );

        return;
    }
    // ======================================
    // SET
    // ======================================        
        if (
            interaction.options.getSubcommand() ===
            "set"
        ) {
            const user =
                interaction.options.getUser("user");

            const hours =
                interaction.options.getInteger("hr");

            const minutes =
                interaction.options.getInteger("min");

            const totalSeconds =
                (hours * 60 * 60) +
                (minutes * 60);

            if (totalSeconds <= 0) {
                await interaction.editReply({
                    content:
                        "❌ Cooldown must be greater than 0 minutes.",
                });

                return;
            }

            await setTreasureCooldownForDuration(
                user.id,
                totalSeconds
            );

            await interaction.editReply({
                content:
                    `✅ Treasure cooldown restored for ${user}.\n\n` +
                    `⏳ Duration: **${hours}h ${minutes}m**`,
            });

            return;
        }
    // ======================================
    // LIST
    // ======================================

    if (subcommand === "list") {
        const cooldowns = await getTreasureCooldownList();

        if (!cooldowns.length) {
            await interaction.editReply({
                content:
                    "🟢 **No one is currently on Treasure Chest cooldown.**",
                flags: MessageFlags.Ephemeral,
            });

            return;
        }

        const lines = cooldowns.map((entry, index) =>
            `${index + 1}. <@${entry.userId}> — **${formatCooldown(entry.ttl)}**`
        );

        // Discord message limit protection.
        const chunks = [];
        let current = "";

        for (const line of lines) {
            if ((current + line + "\n").length > 3900) {
                chunks.push(current);
                current = "";
            }

            current += line + "\n";
        }

        if (current) {
            chunks.push(current);
        }

        const firstEmbed = {
            title: "🏝️ TREASURE COOLDOWNS",
            description:
                `**${cooldowns.length}** person(s) currently have a cooldown.\n\n` +
                chunks[0],
            footer: {
                text: "World Adventure Club • Treasure Chest",
            },
        };

        await interaction.editReply({
            embeds: [firstEmbed],
            flags: MessageFlags.Ephemeral,
        });

        // Send additional pages if necessary.
        for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({
                embeds: [
                    {
                        title: `🏝️ TREASURE COOLDOWNS • PAGE ${i + 1}`,
                        description: chunks[i],
                        footer: {
                            text: "World Adventure Club • Treasure Chest",
                        },
                    },
                ],
                flags: MessageFlags.Ephemeral,
            });
        }

        return;
    }

    await interaction.editReply({
        content: "❌ Unknown Treasure cooldown action.",
        flags: MessageFlags.Ephemeral,
    });
}

module.exports = {
    treasureCooldownCommand,
    handleTreasureCooldown,
    getTreasureCooldownList,
    formatCooldown,
};
