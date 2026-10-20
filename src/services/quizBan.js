const {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags,
} = require("discord.js");

const BAN_KEY_PREFIX = "wac:quiz:ban:";
const DEFAULT_BAN_REASON = "Unknown";

const banCommand = new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban or unban a user from quiz participation.")
    .addStringOption(option =>
        option
            .setName("action")
            .setDescription("Choose ban or unban")
            .setRequired(true)
            .addChoices(
                { name: "ban", value: "ban" },
                { name: "unban", value: "unban" }
            )
    )
    .addUserOption(option =>
        option
            .setName("user")
            .setDescription("User to ban or unban")
            .setRequired(true)
    )
    .addIntegerOption(option =>
        option
            .setName("duration")
            .setDescription("Ban duration in minutes (required when banning)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(525600)
    )
    .addStringOption(option =>
        option
            .setName("reason")
            .setDescription("Reason for the ban (optional)")
            .setRequired(false)
            .setMaxLength(500)
    );

async function isQuizBanned(redis, userId) {
    const key = `${BAN_KEY_PREFIX}${userId}`;
    const value = await redis.get(key);

    if (!value) {
        return { banned: false, ttl: 0 };
    }

    const ttl = Number(await redis.ttl(key));
    let banData = {};

    try {
        banData = typeof value === "string" ? JSON.parse(value) : (value || {});
    } catch {
        banData = {};
    }

    return {
        banned: true,
        ttl: ttl > 0 ? ttl : 0,
        reason: banData.reason || "No reason provided.",
        bannedBy: banData.bannedBy || null,
        createdAt: banData.createdAt || null,
        durationMinutes: banData.durationMinutes || null,
    };
}

function formatDuration(durationMinutes) {
    const hours = Math.floor(durationMinutes / 60);
    const minutes = durationMinutes % 60;

    return [
        hours ? `${hours} hour${hours === 1 ? "" : "s"}` : null,
        minutes ? `${minutes} minute${minutes === 1 ? "" : "s"}` : null,
    ]
        .filter(Boolean)
        .join(" ");
}

function createBanEmbed({ title, description, color, user, reason, fields = [] }) {
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description)
        .addFields(
            {
                name: "👤 User",
                value: `<@${user.id}> (\`${user.id}\`)`,
                inline: false,
            },
            {
                name: "📝 Reason",
                value: reason || DEFAULT_BAN_REASON,
                inline: false,
            },
            ...fields
        )
        .setTimestamp()
        .setFooter({ text: "World Adventure Club • Quiz Moderation" });
}

async function handleBanCommand(interaction, redis) {
    await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
    });

    try {
        const action = interaction.options.getString("action", true);
        const user = interaction.options.getUser("user", true);
        const durationMinutes = interaction.options.getInteger("duration");
        const suppliedReason = interaction.options.getString("reason");
        const reason = suppliedReason?.trim() || DEFAULT_BAN_REASON;
        const key = `${BAN_KEY_PREFIX}${user.id}`;

        if (action === "ban") {
            if (!Number.isInteger(durationMinutes) || durationMinutes < 1) {
                const embed = new EmbedBuilder()
                    .setColor(0xE74C3C)
                    .setTitle("⚠️ Ban Duration Required")
                    .setDescription(
                        "Please provide a ban duration in **minutes** when applying a quiz ban."
                    )
                    .addFields({
                        name: "Example",
                        value: "`/ban action:ban user:@user duration:60`",
                    })
                    .setTimestamp()
                    .setFooter({ text: "World Adventure Club • Quiz Moderation" });

                await interaction.editReply({ embeds: [embed] });
                return;
            }

            const durationSeconds = durationMinutes * 60;
            const createdAt = Date.now();
            const expiresAt = Math.floor(createdAt / 1000) + durationSeconds;

            await redis.set(
                key,
                JSON.stringify({
                    userId: user.id,
                    username: user.username,
                    bannedBy: interaction.user.id,
                    createdAt,
                    durationMinutes,
                    reason,
                }),
                { ex: durationSeconds }
            );

            const embed = createBanEmbed({
                title: "🚫 Quiz Ban Applied",
                description: `**${user.username}** has been restricted from participating in quizzes.`,
                color: 0xE74C3C,
                user,
                reason,
                fields: [
                    {
                        name: "⏳ Duration",
                        value: `**${formatDuration(durationMinutes)}**`,
                        inline: true,
                    },
                    {
                        name: "🕐 Expires",
                        value: `<t:${expiresAt}:F>\n<t:${expiresAt}:R>`,
                        inline: true,
                    },
                    {
                        name: "🛡️ Moderator",
                        value: `<@${interaction.user.id}>`,
                        inline: true,
                    },
                ],
            });

            await interaction.editReply({ embeds: [embed] });
            return;
        }

        if (action === "unban") {
            const removed = await redis.del(key);

            const embed = removed
                ? createBanEmbed({
                    title: "✅ Quiz Ban Removed",
                    description: `**${user.username}** can participate in quizzes again.`,
                    color: 0x2ECC71,
                    user,
                    reason: "The active quiz ban was removed by a moderator.",
                    fields: [
                        {
                            name: "🛡️ Moderator",
                            value: `<@${interaction.user.id}>`,
                            inline: true,
                        },
                        {
                            name: "📌 Status",
                            value: "Quiz participation restored",
                            inline: true,
                        },
                    ],
                })
                : createBanEmbed({
                    title: "ℹ️ No Active Quiz Ban",
                    description: `**${user.username}** does not currently have an active quiz ban.`,
                    color: 0x3498DB,
                    user,
                    reason: "No active ban was found for this user.",
                    fields: [
                        {
                            name: "📌 Status",
                            value: "No changes made",
                            inline: true,
                        },
                    ],
                });

            await interaction.editReply({ embeds: [embed] });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(0xE74C3C)
            .setTitle("❌ Unknown Action")
            .setDescription("Choose either **ban** or **unban**.")
            .setTimestamp()
            .setFooter({ text: "World Adventure Club • Quiz Moderation" });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error("❌ /ban failed:", error);

        const embed = new EmbedBuilder()
            .setColor(0xE74C3C)
            .setTitle("❌ Ban Command Failed")
            .setDescription(
                "I couldn't update the quiz ban. Please check the Redis configuration and bot logs."
            )
            .setTimestamp()
            .setFooter({ text: "World Adventure Club • Quiz Moderation" });

        await interaction.editReply({ embeds: [embed] });
    }
}

module.exports = {
    banCommand,
    handleBanCommand,
    isQuizBanned,
};
