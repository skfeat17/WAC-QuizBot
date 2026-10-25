
// All Discord embeds and interactive components used by the weekly quiz.
// weeklyEmbeds.js

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');

const MEDALS = ['🥇', '🥈', '🥉'];
const PRIZES = [750, 500, 350];

// Replace this with the Discord message link to your detailed guide.
const WEEKLY_GUIDE_URL = 'https://discordapp.com/channels/1116542113274929233/1520280046001197086/1563843205470879817';

function participationEmbed(state, participantCount = 0) {
    const end = Math.floor(state.endsAt / 1000);
    const now = new Date();

    // Daily reset follows UTC/GMT+0.
    const nextReset = Math.floor(
        Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
        ) / 1000,
    );

    return new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('🏆 WEEKLY WORLD QUIZ CHALLENGE')
        .setDescription(
            'Think you know the world? Take the challenge and compete for Mora!\n\n' +
            '**Click 🌎 Challenge to compete.**\n\n' +
            '📖 Need help? Click **How It Works** below to learn about the competition.',
        )
        .addFields(
            {
                name: '🏆 Prizes',
                value: '🥇 1st — 750 Mora\n🥈 2nd — 500 Mora\n🥉 3rd — 350 Mora',
                inline: true,
            },
            {
                name: '🔄 Daily Reset',
                value: `<t:${nextReset}:t> (<t:${nextReset}:R>) UTC`,
                inline: true,
            },
            {
                name: '⏳ Competition Ends',
                value: `<t:${end}:F> (<t:${end}:R>)`,
            },
        )
        .setFooter({
            text: '🛠️ Still Under Development • Help us improve!',
        })
        .setTimestamp(new Date(state.startedAt));
}

function participationComponents(disabled = false) {
    return [
        // Row 1: Interactive quiz buttons.
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('weekly:challenge')
                .setLabel('Challenge')
                .setEmoji('🌎')
                .setStyle(ButtonStyle.Success)
                .setDisabled(disabled),

            new ButtonBuilder()
                .setCustomId('weekly:my-ranking')
                .setLabel('Check My Ranking')
                .setEmoji('📊')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(disabled),

            new ButtonBuilder()
                .setCustomId('weekly:leaderboard')
                .setLabel('Leaderboard')
                .setEmoji('🏆')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(disabled),
        ),

        // Row 2: Link to the detailed guide.
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('How It Works')
                .setEmoji('📖')
                .setStyle(ButtonStyle.Link)
                .setURL(WEEKLY_GUIDE_URL),
        ),
    ];
}

function leaderboardEmbed(state, rows, participantCount) {
    const end = Math.floor(state.endsAt / 1000);
    const status = state.status === 'active' ? '🟢 Active' : '🔴 Ended';

    const board = rows
        .slice(0, 10)
        .map((player, index) => `**${index + 1}.** <@${player.userId}>`)
        .join('\n') || 'No participants yet. Be the first to play!';

    return new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('🏆 WEEKLY WORLD QUIZ • TOP 10')
        .setDescription(
            `**Status:** ${status}\n` +
            `**Competition ends:** <t:${end}:F>\n\n` +
            board,
        )
        .addFields(
            {
                name: '👥 Participants',
                value: String(participantCount),
                inline: true,
            },
            {
                name: '📅 Duration',
                value: '7 days',
                inline: true,
            },
        )
        .setFooter({
            text: 'Points and individual prizes are not shown on this public leaderboard.',
        })
        .setTimestamp();
}

function questionEmbed(question, index, total, deadlineMs) {
    const deadline = Math.floor(deadlineMs / 1000);

    return new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`🌍 Weekly World Quiz • Question ${index + 1}/${total}`)
        .setDescription(
            `### ${question.question}\n\n` +
            `⏳ **Time remaining:** <t:${deadline}:R>`,
        )
        .setFooter({
            text: '⏱️ 15 seconds • Correct: 0–100 points • Incorrect: −15',
        });
}

// The question index in the button ID rejects stale answer buttons.
function answerRows(attemptId, question, questionIndex, disabled = false) {
    const letters = ['A', 'B', 'C', 'D'];

    return [
        new ActionRowBuilder().addComponents(
            question.options.map((label, optionIndex) =>
                new ButtonBuilder()
                    .setCustomId(
                        `weekly:answer:${attemptId}:${questionIndex}:${optionIndex}`,
                    )
                    .setLabel(`${letters[optionIndex]}. ${label}`.slice(0, 80))
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(disabled),
            ),
        ),
    ];
}

function resultEmbed(attempt, participant, rank) {
    return new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🎉 🌍 Your Challenge Results')
        .setDescription([
            `**Correct:** ${attempt.correct}/${attempt.totalQuestions}`,
            `**Incorrect:** ${attempt.incorrect}/${attempt.totalQuestions}`,
            `**Timed out:** ${attempt.timedOut}`,
            '',
            `**Your Total Score:** ${attempt.points} points`,
            `**Your Ranking:** ${rank ? `#${rank}` : 'Unranked'}`,
            `**Weekly Total:** ${Number(participant?.points) || 0} points`,
            '',
            '✨ **Scoring:** Correct answers earn 0–100 points based on speed; incorrect answers cost −15; timeout earns 0.',
        ].join('\n'))
        .setFooter({
            text: 'Your score stays saved until the admin clears the weekly event.',
        })
        .setTimestamp();
}

module.exports = {
    participationEmbed,
    participationComponents,
    leaderboardEmbed,
    questionEmbed,
    answerRows,
    resultEmbed,
};

