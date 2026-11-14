const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    MessageFlags,
} = require("discord.js");
const { getLeaderboardData } = require("./leaderboardService");
const { renderLeaderboardImage } = require("./leaderboardImage");

const LEADERBOARD_BUTTON_ID = "wac:leaderboard:open";

function buildLeaderboardButton() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(LEADERBOARD_BUTTON_ID)
                .setLabel("Leaderboard")
                .setEmoji("🏆")
                .setStyle(ButtonStyle.Primary)
        ),
    ];
}

async function handleLeaderboardButton(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const data = await getLeaderboardData();
        const image = await renderLeaderboardImage(data, interaction.client);
        const attachment = new AttachmentBuilder(image, {
            name: "wac-mora-leaderboard.png",
        });

        await interaction.editReply({
            content: "🏆 **World Adventure Club — Mora Leaderboard**",
            files: [attachment],
        });
    } catch (error) {
        console.error("[WAC LEADERBOARD] Failed:", error);
        await interaction.editReply({
            content: "❌ Couldn't load the leaderboard right now. Please try again later.",
        });
    }
}

module.exports = {
    LEADERBOARD_BUTTON_ID,
    buildLeaderboardButton,
    handleLeaderboardButton,
};
