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

        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('How It Works')
                .setEmoji('📖')
                .setStyle(ButtonStyle.Link)
                .setURL(WEEKLY_GUIDE_URL),
        ),
    ];
}

function challengeReadyEmbed() {
    return new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('⚔️ READY FOR TODAY’S CHALLENGE?')
        .setDescription(
            'Are you ready to take **today’s Weekly World Quiz Challenge**?\n\n' +
            '📝 **5 questions**\n' +
            '⏱️ **15 seconds per question**\n' +
            '⚡ Correct answers earn points based on your answering speed.\n' +
            '❌ Incorrect answers: **−15 points**\n' +
            '⏰ Timeout: **0 points**\n\n' +
            'You can attempt the challenge once per UTC day. Ready to begin?',
        )
        .setFooter({
            text: 'Your weekly score updates as you answer.',
        });
}

function challengeReadyComponents() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('weekly:ready')
                .setLabel('I’m Ready — Start!')
                .setEmoji('🚀')
                .setStyle(ButtonStyle.Success),
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
            text: '⏱️ 15 seconds • Correct: 0–100 points • Incorrect: −15 • Timeout: 0',
        });
}

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

function answerFeedbackEmbed({ correct, timeout, pointsDelta, elapsedMs, question, questionNumber }) {
    const letters = ['A', 'B', 'C', 'D'];
    const answerIndex = Number(question.correctAnswer);
    const answerText = question.options?.[answerIndex] ?? 'Answer unavailable';
    const answerLetter = letters[answerIndex] || '?';
    const elapsed = (Math.max(0, elapsedMs) / 1000).toFixed(2);

    let title;
    let color;
    let scoreLine;

    if (timeout) {
        title = '⏰ TIME’S UP!';
        color = 0xE67E22;
        scoreLine = '**Points earned:** 0';
    } else if (correct) {
        title = '✅ CORRECT!';
        color = 0x57F287;
        scoreLine = `**You scored:** +${pointsDelta} points`;
    } else {
        title = '❌ INCORRECT!';
        color = 0xED4245;
        scoreLine = '**Penalty:** −15 points';
    }

    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(
            `${scoreLine}\n` +
            `**Time taken:** ${timeout ? '15.00 seconds (timeout)' : `${elapsed} seconds`}\n` +
            `**Correct answer:** ${answerLetter}. ${answerText}\n\n` +
            '**Next question in 5 seconds…**',
        )
        .setFooter({
            text: `Question ${questionNumber} answered`,
        });
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
    challengeReadyEmbed,
    challengeReadyComponents,
    answerFeedbackEmbed,
};
