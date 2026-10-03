const {
    createPaymentTransaction,
} = require("../paymentService");

async function notifyPaymentStaff({
    client,
    kahoot,
    rankedPlayers,
}) {
    // Top 5 are winners.
    const winners = rankedPlayers.slice(0, 5);

    const winnerIds = new Set(
        winners.map((p) => p.id)
    );

    // Everyone outside the Top 5 who actually participated
    // receives the participation reward.
    const participants = rankedPlayers.filter(
        (p) => p.participated && !winnerIds.has(p.id)
    );

    const rewardByRank = [
        kahoot.rewards.first,
        kahoot.rewards.second,
        kahoot.rewards.third,
        kahoot.rewards.fourth,
        kahoot.rewards.fifth,
    ];

    const createdTransactions = [];

    // ================================
    // TOP 5 WINNERS
    // ================================

    for (let i = 0; i < winners.length; i++) {
        const winner = winners[i];
        const reward = Number(rewardByRank[i] || 0);

        if (reward <= 0) continue;

        const suffixes = ["st", "nd", "rd", "th", "th"];

        const transaction = await createPaymentTransaction({
            client,
            winnerId: winner.id,
            displayName: winner.displayName,
            username: winner.username,
            eventName:
                `🎮 ${kahoot.name} — ${i + 1}${suffixes[i]} Place`,
            eventType: "Kahoot",
            reward,
            sourceChannelId: kahoot.channelId || null,
            sourceMessageId: kahoot.messageId || null,
        });

        createdTransactions.push(transaction);
    }

    // ================================
    // PARTICIPATION REWARDS
    // ================================

    const participationReward = Number(
        kahoot.rewards.participation || 0
    );

    for (const player of participants) {
        if (participationReward <= 0) continue;

        const transaction = await createPaymentTransaction({
            client,
            winnerId: player.id,
            displayName: player.displayName,
            username: player.username,
            eventName:
                `🎮 ${kahoot.name} — Participation`,
            eventType: "Kahoot Participation",
            reward: participationReward,
            sourceChannelId: kahoot.channelId || null,
            sourceMessageId: kahoot.messageId || null,
        });

        createdTransactions.push(transaction);
    }

    return {
        winners,
        participants,
        transactions: createdTransactions,
    };
}

module.exports = {
    notifyPaymentStaff,
};
