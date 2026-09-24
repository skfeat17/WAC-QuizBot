const {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags,
} = require("discord.js");

const {
    Redis,
} = require("@upstash/redis");

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PREFIX = "wac:dailyquiz:";

const EVENT_NAMES = {
    capital: "🏛️ CAPITAL",
    food: "🍜 FAMOUS FOOD",
    monument: "🏰 FAMOUS MONUMENT",
    president: "👤 PRESIDENT",
    independence: "🎉 INDEPENDENCE DAY",
};

const dailyeventCooldownCommand = new SlashCommandBuilder()
    .setName("dailyeventcooldown")
    .setDescription("View Daily Event cooldown statistics.")
    .addSubcommand(subcommand =>
        subcommand
            .setName("list")
            .setDescription("List every active Daily Event cooldown.")
    );

/* ==========================================
   FORMAT TIME
========================================== */

function formatCooldown(seconds) {
    seconds = Math.max(0, Number(seconds) || 0);

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    return `${minutes}m`;
}

/* ==========================================
   GET ALL DAILY EVENT COOLDOWNS
========================================== */

async function getDailyEventCooldowns() {
    let cursor = 0;
    const cooldowns = [];

    do {
        const result = await redis.scan(cursor, {
            match: `${PREFIX}*:cooldown:*`,
            count: 200,
        });

        let nextCursor;
        let keys;

        if (Array.isArray(result)) {
            nextCursor = result[0];
            keys = result[1] || [];
        } else {
            nextCursor = result?.cursor ?? 0;
            keys = result?.keys || [];
        }

        cursor = Number(nextCursor) || 0;
        keys = Array.isArray(keys) ? keys : [];

        for (const key of keys) {
            /*
             * Expected:
             * wac:dailyquiz:capital:cooldown:USER_ID
             */

            const match = key.match(
                /^wac:dailyquiz:([^:]+):cooldown:(\d+)$/
            );

            if (!match) continue;

            const type = match[1];
            const userId = match[2];

            const ttl = await redis.ttl(key);

            // Ignore expired keys.
            if (ttl <= 0) continue;

            cooldowns.push({
                type,
                userId,
                ttl,
            });
        }
    } while (cursor !== 0);

    return cooldowns;
}

/* ==========================================
   HANDLE COMMAND
========================================== */

async function handleDailyEventCooldown(interaction) {
    const subcommand =
        interaction.options.getSubcommand();

    if (subcommand !== "list") {
        return;
    }

    try {
        const cooldowns =
            await getDailyEventCooldowns();

        if (cooldowns.length === 0) {
            await interaction.editReply({
                content:
                    "📊 **DAILY EVENT COOLDOWNS**\n\n" +
                    "✅ No users currently have a Daily Event cooldown.",
            });

            return;
        }

        /*
         * Group cooldowns by event type.
         */

        const grouped = {};

        for (const cooldown of cooldowns) {
            if (!grouped[cooldown.type]) {
                grouped[cooldown.type] = [];
            }

            grouped[cooldown.type].push(cooldown);
        }

        /*
         * Unique users.
         */

        const uniqueUsers = new Set(
            cooldowns.map(cooldown => cooldown.userId)
        );

        let description =
            `👥 **TOTAL ACTIVE COOLDOWNS:** ${cooldowns.length}\n` +
            `👤 **UNIQUE USERS:** ${uniqueUsers.size}\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n`;

        const eventOrder = [
            "capital",
            "food",
            "monument",
            "president",
            "independence",
        ];

        for (const type of eventOrder) {
            const users = grouped[type];

            if (!users || users.length === 0) {
                continue;
            }

            users.sort((a, b) => b.ttl - a.ttl);

            description +=
                `${EVENT_NAMES[type] || `📌 ${type.toUpperCase()}`}\n` +
                `👥 **${users.length} user${users.length === 1 ? "" : "s"}**\n`;

            for (const user of users) {
                description +=
                    `<@${user.userId}> — ⏳ **${formatCooldown(user.ttl)}**\n`;
            }

            description += "\n";
        }

        description +=
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🔒 **TOTAL COOLDOWNS: ${cooldowns.length}**`;

        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle("📊 DAILY EVENT COOLDOWN STATISTICS")
            .setDescription(description)
            .setFooter({
                text: "World Adventure Club • Daily Event",
            })
            .setTimestamp();

        await interaction.editReply({
            embeds: [embed],
        });
    } catch (error) {
        console.error(
            "❌ Daily Event cooldown error:",
            error?.message || error
        );

        await interaction.editReply({
            content:
                "❌ Failed to retrieve Daily Event cooldown statistics.",
        });
    }
}

module.exports = {
    dailyeventCooldownCommand,
    handleDailyEventCooldown,
    getDailyEventCooldowns,
    formatCooldown,
};