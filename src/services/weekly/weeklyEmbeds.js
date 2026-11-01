// All Discord embeds and interactive components used by the weekly quiz.
const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');

const PRIZE_LINES = '🥇 1st — 1,000 Mora\n🥈 2nd — 750 Mora\n🥉 3rd — 550 Mora\n🏅 4th — 400 Mora\n🎖️ 5th — 300 Mora';

function participationEmbed(state, participantCount = 0) {
    const end = Math.floor(state.endsAt / 1000);
    const now = new Date();
    const nextReset = Math.floor(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1,
    ) / 1000);

    return new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('🏆 WEEKLY WORLD QUIZ CHALLENGE')
        .setDescription(
            'Think you know the world? Take the challenge and compete for Mora!\n\n' +
            '**Click 🌎 Challenge to compete.**\n\n' +
            '📖 Need help? Click **Rules & Guide** below to learn how the quiz works.',
        )
        .addFields(
            { name: '🏆 Prizes', value: PRIZE_LINES, inline: true },
            { name: '🔄 Daily Reset', value: `<t:${nextReset}:t>`, inline: true },
            { name: '⏳ Competition Ends', value: `<t:${end}:F> (<t:${end}:R>)` },
        )
        .setFooter({ text: `Compete, Accumulate Points & Claim Your Place on the Podium!` })
        .setTimestamp(new Date(state.startedAt));
}

// --------------------------------------------------
// PARTICIPATION COMPONENTS
// --------------------------------------------------

function participationComponents(disabled = false) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('weekly:challenge').setLabel('Challenge').setEmoji('🌎').setStyle(ButtonStyle.Success).setDisabled(disabled),
            new ButtonBuilder().setCustomId('weekly:profile').setLabel('My Profile').setEmoji('👤').setStyle(ButtonStyle.Primary).setDisabled(disabled),
            new ButtonBuilder().setCustomId('weekly:leaderboard').setLabel('Leaderboard').setEmoji('🏆').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('weekly:rules-guide').setLabel('Rules & Guide').setEmoji('📖').setStyle(ButtonStyle.Secondary),
        ),
    ];
}


function rulesGuideEmbed() {
    return new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('📖 WEEKLY WORLD QUIZ • RULES & GUIDE')
        .setDescription('Learn how to play, how points work, and how to compete fairly.')
        .addFields(
            {
                name: '🌍 How the Quiz Works',
                value: '• Play **5 questions** each day: 2 Easy, 2 Medium, and 1 Hard.\n' +
                    '• Topics include geography, history, landmarks, food, language, and more.\n' +
                    '• You have **15 seconds** to answer each question. The timer starts when the question appears.\n' +
                    '• You can complete one regular daily challenge per UTC day.',
            },
            {
                name: '🎯 Points & Penalties',
                value: '• Correct answers earn points based on speed and difficulty.\n' +
                    '• Difficulty multipliers: 🟢 Easy ×1 · 🟡 Medium ×1.5 · 🔴 Hard ×2.\n' +
                    '• Incorrect-answer penalties: Easy −15 · Medium −23 · Hard −30 points.\n' +
                    '• If time runs out, you earn **0 points** for that question.',
            },
            {
                name: '🔥 Streaks & Missed Attempts',
                value: '• Keep completing your daily challenge to build your streak.\n' +
                    '• Regular daily challenges can earn a streak bonus of **25 × your streak**.\n' +
                    '• Eligible missed challenges can be restored from **My Profile → Missed Attempts**.\n' +
                    '• Missed attempts do **not** earn streak bonuses.',
            },
            {
                name: '🏆 Competition & Prizes',
                value: '• Points accumulate on the weekly leaderboard.\n' +
                    '• Top rewards: 🥇 **1,000 Mora** · 🥈 **750 Mora** · 🥉 **550 Mora** · 🏅 **400 Mora** · 🎖️ **300 Mora**.\n' +
                    '• Play fairly; do not exploit bugs or interfere with other players.',
            },
        )
        .setFooter({ text: 'Daily reset follows UTC. Good luck, and have fun exploring the world!' });
}

function challengeReadyEmbed() {
    return new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('⚔️ READY FOR TODAY’S CHALLENGE?')
        .setDescription(
            'Are you ready to take **today’s Weekly World Quiz Challenge**?\n\n' +
            '📝 **5 questions:** 2 Easy, 2 Medium, 1 Hard\n' +
            '🌍 Categories: Geography, History, Landmarks, Food, and Language\n' +
            '⏱️ **15 seconds per question**\n' +
            '⚡ Correct points and ❌ incorrect penalties both scale with difficulty:\n' +
            '🟢 Easy ×1 • 🟡 Medium ×1.5 • 🔴 Hard ×2\n' +
            '⏰ Timeout: **0 points**\n\n' +
            'You can attempt the challenge once per UTC day. Ready to begin?',
        )
        .setFooter({ text: 'Your weekly score updates as you answer.' });
}

function challengeReadyComponents() {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('weekly:ready').setLabel('I’m Ready — Start!').setEmoji('🚀').setStyle(ButtonStyle.Success),
    )];
}

function profileEmbed({ user, participant, rank, participantCount, todayAttempt, attempts = [], rankingsHidden = false }) {
    const p = participant || {};
    const answers = attempts.flatMap((attempt) => Array.isArray(attempt.answers) ? attempt.answers : []);
    const today = todayAttempt || {};
    const todayAnswers = Array.isArray(today.answers) ? today.answers : [];
    const todayQuestionPoints = todayAnswers.reduce((sum, answer) => sum + (Number(answer.pointsDelta) || 0), 0);
    const todayStreakBonus = Number(today.streakBonus) || 0;
    const totalStreakBonus = Number(p.streakBonusTotal) || 0;
    const totalCorrect = Number(p.correct) || 0;
    const totalIncorrect = Number(p.incorrect) || 0;
    const totalTimedOut = attempts.reduce((sum, attempt) => sum + (Number(attempt.timedOut) || 0), 0);
    // Show today's question score only; streak bonus is displayed separately.
    const todayPoints = todayQuestionPoints;
    return new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`👤 ${user.globalName || user.username}’s Weekly Profile`)
        .setDescription([
            `🏆 **Weekly Rank:** ${rankingsHidden ? '🔒 Sealed' : (rank ? `#${rank} of ${participantCount}` : 'Unranked')}`,
            `⭐ **Total Points:** ${Number(p.points) || 0}`,
            `🔥 **Current Streak:** ${Number(p.currentStreak) || 0} days`,
            `🎯 **Challenges Completed:** ${Number(p.challengesCompleted) || 0}`,
            `✅ **Correct Answers:** ${totalCorrect}`,
            `❌ **Incorrect Answers:** ${totalIncorrect}`,
            `⏰ **Timed-Out Questions:** ${totalTimedOut}`,
            '',
            `🎁 **Today’s Streak Bonus:** +${todayStreakBonus} points`,
            `🔥 **Total Streak Bonus:** +${totalStreakBonus} points`,
            `📅 **Today’s Points (without bonus):** ${todayPoints >= 0 ? '+' : ''}${todayPoints} points`,
            `✨ **Today’s Points (with bonus):** ${todayPoints + todayStreakBonus >= 0 ? '+' : ''}${todayPoints + todayStreakBonus} points`,
        ].join('\n'))
        .setFooter({ text: 'Your profile and history are visible only to you.' })
        .setTimestamp();
}

function profileComponents() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('weekly:missed').setLabel('Missed Attempts').setEmoji('🔄').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('weekly:reattempt').setLabel('Reattempt Today').setEmoji('🔁').setStyle(ButtonStyle.Primary),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('weekly:points-history:0').setLabel('Points History').setEmoji('📊').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('weekly:attempt-history:0').setLabel('Attempt History').setEmoji('📝').setStyle(ButtonStyle.Secondary),
        ),
    ];
}

function profileMenuEmbed() {
    return new EmbedBuilder().setColor(0x5865F2).setTitle('👤 MY WEEKLY PROFILE').setDescription('View your weekly stats, make up missed challenges, reattempt today, or review your histories.');
}

function leaderboardEmbed(state, rows, participantCount) {
    const end = Math.floor(state.endsAt / 1000);
    const status = state.status === 'active' ? '🟢 Active' : '🔴 Ended';
    const board = rows.slice(0, 10)
        .map((player, index) => `**${index + 1}.** <@${player.userId}>`)
        .join('\n') || 'No participants yet. Be the first to play!';

    return new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('🏆 WEEKLY WORLD QUIZ • TOP 10')
        .setDescription(`**Status:** ${status}\n**Competition ends:** <t:${end}:F>\n\n${board}`)
        .addFields(
            { name: '👥 Participants', value: String(participantCount), inline: true },
            { name: '📅 Duration', value: '7 days', inline: true },
        )
        .setFooter({ text: 'Points and individual prizes are not shown on this public leaderboard.' })
        .setTimestamp();
}

// --------------------------------------------------
// QUESTION EMBED
// --------------------------------------------------

function questionEmbed(question, index, total, deadlineMs) {
    const deadline = Math.floor(deadlineMs / 1000);
    const difficulty = String(question.difficulty || 'easy').toLowerCase();
    const multiplier = ({ easy: '×1', medium: '×1.5', hard: '×2' })[difficulty] || '×1';
    const penalty = ({ easy: 15, medium: 23, hard: 30 })[difficulty] || 15;

 return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`🌍 Weekly World Quiz • Question ${index + 1}/${total}`)
    .setDescription(
        `### ${question.question}\n\n\n` +
        `\n⏳ **Time Remaining:** <t:${deadline}:R>\n` +
        `🎯 **Difficulty:** ${difficulty.toUpperCase()} (${multiplier})`
    )
    .setFooter({ text: '⏱️ You have 15 seconds to answer!' });
}

// --------------------------------------------------
// ANSWER BUTTONS
// --------------------------------------------------

function answerRows(attemptId, question, questionIndex, disabled = false, dayKey = null) {
    const letters = ['A', 'B', 'C', 'D'];
    return [new ActionRowBuilder().addComponents(
        question.options.map((label, optionIndex) => new ButtonBuilder()
            .setCustomId(`weekly:answer:${attemptId}:${dayKey ? Buffer.from(String(dayKey).split(':date-')[1] || '').toString('base64url') : ''}:${questionIndex}:${optionIndex}`)
            .setLabel(`${letters[optionIndex]}. ${label}`.slice(0, 80))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled)),
    )];
}

// --------------------------------------------------
// ANSWER FEEDBACK EMBED
// --------------------------------------------------

function answerFeedbackEmbed({ correct, timeout, pointsDelta, elapsedMs, question, questionNumber }) {
    const letters = ['A', 'B', 'C', 'D'];
    const answerIndex = Number(question.correctAnswer);
    const answerText = question.options?.[answerIndex] ?? 'Answer unavailable';
    const answerLetter = letters[answerIndex] || '?';
    const elapsed = (Math.max(0, elapsedMs) / 1000).toFixed(2);
    const difficulty = String(question.difficulty || 'easy').toUpperCase();
    let title, color, scoreLine;

    if (timeout) {
        title = '⏰ TIME’S UP!';
        color = 0xE67E22;
        scoreLine = '**Points earned:** 0';
    } else if (correct) {
        title = '✅ CORRECT!';
        color = 0x57F287;
        scoreLine = `**You scored:** ${pointsDelta > 0 ? '+' : ''}${pointsDelta} points`;
    } else {
        title = '❌ INCORRECT!';
        color = 0xED4245;
        scoreLine = `**Penalty:** ${pointsDelta} points`;
    }

    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(
            `**Difficulty:** ${difficulty}\n${scoreLine}\n` +
            `**Time taken:** ${timeout ? '15.00 seconds (timeout)' : `${elapsed} seconds`}\n` +
            `**Correct answer:** ${answerLetter}. ${answerText}\n\n` +
            '**Next question in 3 seconds…**',
        )
        .setFooter({ text: `Question ${questionNumber} answered` });
}

function resultEmbed(attempt, participant, rank, rankingsHidden = false) {
    // attempt.points includes the streak bonus; show quiz points separately.
    const streakBonus = Number(attempt.streakBonus) || 0;
    const quizPoints = (Number(attempt.points) || 0) - streakBonus;

    return new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('🎉 🌍 Challenge Completed!')
        .setDescription([
            `**Correct:** ${attempt.correct}/${attempt.totalQuestions}`,
            `**Incorrect:** ${attempt.incorrect}/${attempt.totalQuestions}`,
            `**Timed out:** ${attempt.timedOut}`,
            '',
            `**Quiz Points (without bonus):** ${quizPoints >= 0 ? '+' : ''}${quizPoints} points`,
            `**Streak Bonus:** +${streakBonus} points`,
            `**Challenge Total (with bonus):** ${Number(attempt.points) || 0} points`,
            '',
            `**Your Ranking:** ${rankingsHidden ? '🔒 Sealed' : (rank ? `#${rank}` : 'Unranked')}`,
            `**Weekly Total (including bonuses):** ${Number(participant?.points) || 0} points`,
        ].join('\n'))
        .setFooter({ text: 'Your weekly total includes any streak bonuses earned.' })
        .setTimestamp();
}


function rankingSealedEmbed() {
    return new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('🔒 YOUR RANK IS SEALED!')
        .setDescription([
            'Your performance and points are still being recorded normally.',
            '',
            '**Your Rank:** 🔒 Sealed',
            '',
            'Individual rankings are hidden until the official results announcement.',
            'No spoilers — let the suspense continue!',
        ].join('\\n'))
        .setFooter({ text: 'Weekly World Quiz • Official Results Awaited' })
        .setTimestamp();
}

function leaderboardSealedEmbed() {
    return new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('🤫 THE LEADERBOARD IS SEALED!')
        .setDescription([
            'The weekly standings are currently confidential.',
            '',
            '🏆 No leaderboard previews. No individual rankings. No spoilers.',
            '',
            'All results will be revealed during the official announcement.',
        ].join('\\n'))
        .setFooter({ text: 'Weekly World Quiz • Rankings Temporarily Hidden' })
        .setTimestamp();
}

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
    participationEmbed, participationComponents, leaderboardEmbed, questionEmbed,
    answerRows, resultEmbed, challengeReadyEmbed, challengeReadyComponents, answerFeedbackEmbed,
    profileEmbed, profileComponents, profileMenuEmbed, rulesGuideEmbed,
    rankingSealedEmbed, leaderboardSealedEmbed,
};

