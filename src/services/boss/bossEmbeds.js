const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');

function eventEmbed(state, participantCount) {
    const ends = Math.floor(state.endsAt / 1000);
    return new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('🌍 WORLD BOSS MODE — CHAOS CHAMPIONSHIP')
        .setDescription([
            '**Hard questions. No cooldowns. Unlimited attempts.**',
            '',
            `**Status:** ${state.status === 'active' ? '🟢 LIVE' : '🔴 ENDED'}`,
            `**Ends:** <t:${ends}:F> (<t:${ends}:R>)`,
            `**Participants:** ${participantCount}`,
            '',
            'Correct answers earn speed-based points. Incorrect answers cost **50 points**. Timeouts cost **0 points**.',
        ].join('\n'))
        .setFooter({ text: 'Every answer leads to another hard question.' })
        .setTimestamp();
}

function eventComponents(disabled = false) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('boss:challenge')
            .setLabel('Challenge')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId('boss:leaderboard')
            .setLabel('Leaderboard')
            .setStyle(ButtonStyle.Secondary),
    )];
}

function questionEmbed(question, deadlineMs) {
    return new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('⚔️ BOSS QUESTION')
        .setDescription(
            `### ${question.question}\n\n` +
            `**Difficulty:** HARD\n` +
            `**Time limit:** 10 seconds\n` +
            `**Deadline:** <t:${Math.floor(deadlineMs / 1000)}:R>`
        )
        .setFooter({ text: '5 questions per attempt • Quit anytime • No cooldowns.' });
}

function questionComponents(questionId, question, disabled = false) {
    const letters = ['A', 'B', 'C', 'D'];
    return [
        new ActionRowBuilder().addComponents(
            question.options.slice(0, 4).map((option, index) =>
                new ButtonBuilder()
                    .setCustomId(`boss:answer:${questionId}:${index}`)
                    .setLabel(`${letters[index]}. ${String(option)}`.slice(0, 80))
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(disabled)
            )
        )
    ];
}

function leaderboardEmbed(rows, status = 'LIVE') {
    const medals = ['🥇', '🥈', '🥉'];
    const body = rows.length
        ? rows.map((p, i) =>
            `${medals[i] || `**${i + 1}.**`} **${escapeMarkdown(p.username || p.userId)}** — **${p.points} pts**  ·  ✅ ${p.correct}  ·  ❌ ${p.incorrect}`
          ).join('\n')
        : 'No participants yet.';
    return new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('🏆 BOSS MODE LEADERBOARD')
        .setDescription(body)
        .setFooter({ text: `${status} • Points | Correct | Incorrect` })
        .setTimestamp();
}

function resultEmbed({ correct, timeout, delta, total, question, questionNumber }) {
    let title;
    if (timeout) title = '⏰ TIME’S UP';
    else if (correct) title = '✅ CORRECT';
    else title = '❌ INCORRECT';
    const answer = question.options?.[Number(question.correctAnswer)] ?? 'Unavailable';
    return new EmbedBuilder()
        .setColor(timeout ? 0xE67E22 : correct ? 0x57F287 : 0xED4245)
        .setTitle(title)
        .setDescription([
            `**Correct answer:** ${answer}`,
            `**Points change:** ${delta > 0 ? '+' : ''}${delta}`,
            `**Your total:** ${total} points`,
            questionNumber ? `**Attempt progress:** ${questionNumber}/5` : '',
            '',
            'Your next question is ready.' ,
        ].join('\n'));
}

function attemptSummaryEmbed(session, eventTotal, reason = 'Completed') {
    return new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('🏁 BOSS ATTEMPT FINISHED')
        .setDescription([
            `**Status:** ${reason}`,
            `**Questions answered:** ${session.answered}/5`,
            `**Attempt points:** ${session.points > 0 ? '+' : ''}${session.points}`,
            `**Correct:** ${session.correct}  ·  **Incorrect:** ${session.incorrect}  ·  **Timeouts:** ${session.timeouts}`,
            '',
            `**Overall event score:** ${eventTotal} points`,
            '',
            'You can start another 5-question attempt immediately. Your leaderboard score keeps accumulating.',
        ].join('\n'))
        .setTimestamp();
}

function escapeMarkdown(value) {
    return String(value).replace(/[\\*_`~|>]/g, '\\$&');
}

module.exports = {
    eventEmbed, eventComponents, questionEmbed, questionComponents,
    leaderboardEmbed, resultEmbed, attemptSummaryEmbed,
};
