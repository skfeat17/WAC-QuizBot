const {
    SlashCommandBuilder,
    MessageFlags,
} = require("discord.js");

const BAN_KEY_PREFIX = "wac:quiz:ban:";

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
            .setDescription("Ban duration in minutes")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(525600)
    );

async function isQuizBanned(redis, userId) {
    const key = `${BAN_KEY_PREFIX}${userId}`;
    const value = await redis.get(key);

    if (!value) {
        return { banned: false, ttl: 0 };
    }

    const ttl = Number(await redis.ttl(key));

    return {
        banned: true,
        ttl: ttl > 0 ? ttl : 0,
    };
}

async function handleBanCommand(interaction, redis) {
    await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
    });

    try {
        const action = interaction.options.getString("action", true);
        const user = interaction.options.getUser("user", true);
        const key = `${BAN_KEY_PREFIX}${user.id}`;

        if (action === "ban") {
            const durationMinutes =
                interaction.options.getInteger("duration");

            if (
                !Number.isInteger(durationMinutes) ||
                durationMinutes < 1
            ) {
                await interaction.editReply({
                    content:
                        "❌ Provide a duration in minutes when banning a user.",
                });
                return;
            }

            const durationSeconds = durationMinutes * 60;

            await redis.set(
                key,
                JSON.stringify({
                    userId: user.id,
                    username: user.username,
                    bannedBy: interaction.user.id,
                    createdAt: Date.now(),
                    durationMinutes,
                }),
                { ex: durationSeconds }
            );

            const expiresAt =
                Math.floor(Date.now() / 1000) + durationSeconds;

            const hours = Math.floor(durationMinutes / 60);
            const minutes = durationMinutes % 60;

            const durationLabel = [
                hours
                    ? `${hours} hour${hours === 1 ? "" : "s"}`
                    : null,
                minutes
                    ? `${minutes} minute${minutes === 1 ? "" : "s"}`
                    : null,
            ]
                .filter(Boolean)
                .join(" ");

            await interaction.editReply({
                content:
                    `🚫 **Quiz Ban Applied**\n\n` +
                    `👤 User: <@${user.id}>\n` +
                    `⏳ Duration: **${durationLabel}**\n` +
                    `🕐 Expires: <t:${expiresAt}:F>\n` +
                    `✅ Quiz participation is blocked until expiry.`,
            });

            return;
        }

        if (action === "unban") {
            const removed = await redis.del(key);

            await interaction.editReply({
                content: removed
                    ? `✅ <@${user.id}> has been unbanned from quiz participation.`
                    : `ℹ️ <@${user.id}> does not have an active quiz ban.`,
            });

            return;
        }

        await interaction.editReply({
            content: "❌ Unknown action.",
        });
    } catch (error) {
        console.error("❌ /ban failed:", error);

        await interaction.editReply({
            content:
                "❌ Failed to update the quiz ban. Check your Redis configuration and bot logs.",
        });
    }
}

module.exports = {
    banCommand,
    handleBanCommand,
    isQuizBanned,
};