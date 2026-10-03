const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require("discord.js");

function questionEmbed(kahoot, question, index, total, remainingMs) {
    const embed = new EmbedBuilder()
        .setTitle(`🎮 ${kahoot.name}`)
        .setDescription(
            `### Question ${index + 1}/${total}\n\n` +
            `## ${question.question}\n\n` +
            `Choose an answer below.`
        )
        .addFields({
            name: "⏱️ Time",
            value: `<t:${Math.floor((Date.now() + remainingMs) / 1000)}:R>`,
            inline: true,
        })
        .setFooter({
            text: "Answer once • Speed affects your score",
        });

    if (question.imageUrl) {
        embed.setImage(question.imageUrl);
    }

    return embed;
}

function answerRow(gameId, question) {
    return new ActionRowBuilder().addComponents(
        question.options.map((option, index) =>
            new ButtonBuilder()
                .setCustomId(`kahoot:answer:${gameId}:${question.id}:${index}`)
                .setLabel(option.slice(0, 80))
                .setStyle(ButtonStyle.Primary)
        )
    );
}

function playerMention(player) {
    return `<@${player.id}>`;
}

function sortPlayers(players) {
    return [...players].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.totalAnswerMs !== b.totalAnswerMs) {
            return a.totalAnswerMs - b.totalAnswerMs;
        }
        return String(a.id).localeCompare(String(b.id));
    });
}

function leaderboardEmbed(kahoot, players) {
    const ranked = sortPlayers(players);
    const medals = ["🥇", "🥈", "🥉"];

    const lines = ranked.slice(0, 5).map((p, i) => {
        const prefix = i < 3 ? medals[i] : `${i + 1}️⃣`;

        return `${prefix} ${playerMention(p)} — **${Number(p.score).toFixed(2)} pts**`;
    });

    return new EmbedBuilder()
        .setTitle(`🏆 ${kahoot.name} — Top 5`)
        .setDescription(lines.length ? lines.join("\n") : "No answers yet.")
        .setFooter({ text: "Next question coming soon..." });
}

function finalLeaderboardEmbed(kahoot, players) {
    const ranked = sortPlayers(players);
    const medals = ["🥇", "🥈", "🥉"];

    const lines = ranked.map((p, i) => {
        const prefix = i < 3 ? medals[i] : `${i + 1}️⃣`;

        return `${prefix} ${playerMention(p)} — **${Number(p.score).toFixed(2)} pts**`;
    });

    return new EmbedBuilder()
        .setTitle(`🏁 ${kahoot.name} — Final Leaderboard`)
        .setDescription(lines.length ? lines.join("\n") : "No participants.")
        .setFooter({ text: "Kahoot finished" });
}

module.exports = {
    questionEmbed,
    answerRow,
    leaderboardEmbed,
    finalLeaderboardEmbed,
};
