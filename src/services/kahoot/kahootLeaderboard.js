const { rankPlayers } = require("./kahootScoring");

function topFive(players) {
    return rankPlayers(players).slice(0, 5);
}

function getRankEmoji(rank) {
    const ranks = {
        1: "🥇",
        2: "🥈",
        3: "🥉",
        4: "4️⃣",
        5: "5️⃣",
        6: "6️⃣",
        7: "7️⃣",
        8: "8️⃣",
        9: "9️⃣",
        10: "🔟",
    };

    return ranks[rank] || `${rank}.`;
}

function getPlayerName(player) {
    if (player.isTestBot) {
        return player.displayName || player.username;
    }

    return `<@${player.id}>`;
}

function buildLeaderboardText(players, limit = null, kahoot = null) {
    const ranked = rankPlayers(players);
    const rows = limit ? ranked.slice(0, limit) : ranked;

    if (!rows.length) {
        return "No players have answered yet.";
    }

    return rows
        .map((player) => {
            const prefix = getRankEmoji(player.rank);
            const name = getPlayerName(player);

            let rewardText = "";

            if (kahoot) {
                if (player.rank <= 5) {
                    const rewardKeys = [
                        "first",
                        "second",
                        "third",
                        "fourth",
                        "fifth",
                    ];

                    const reward = Number(
                        kahoot.rewards?.[rewardKeys[player.rank - 1]] || 0
                    );

                    if (reward > 0) {
                        rewardText = ` — 🏆 **${reward} Mora**`;
                    }
                } else if (player.participated) {
                    const reward = Number(
                        kahoot.rewards?.participation || 0
                    );

                    if (reward > 0) {
                        rewardText = ` — 🎁 **${reward} Mora**`;
                    }
                }
            }

            return (
                `${prefix} ${name} — ` +
                `**${Number(player.score).toFixed(2)} pts**` +
                rewardText
            );
        })
        .join("\n");
}

module.exports = {
    topFive,
    buildLeaderboardText,
    rankPlayers,
};
