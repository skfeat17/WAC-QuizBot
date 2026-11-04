// All Discord embeds and interactive components used by the weekly quiz.
const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const { createCanvas, loadImage } = require('canvas');

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

const avatarImageCache = new Map();

async function getCachedAvatar(user) {
    const url = user.displayAvatarURL({ extension: 'png', size: 128 });
    const cached = avatarImageCache.get(url);
    if (cached) return cached;
    const pending = loadImage(url);
    avatarImageCache.set(url, pending);
    try {
        const image = await pending;
        // Keep the cache bounded so long-running bot processes do not grow forever.
        if (avatarImageCache.size > 250) avatarImageCache.delete(avatarImageCache.keys().next().value);
        return image;
    } catch (error) {
        avatarImageCache.delete(url);
        throw error;
    }
}

async function profileCardBuffer({ user, participant, rank, participantCount, todayAttempt, attempts = [], rankingsHidden = false, nextRankPoints = null }) {
    // Roomier 1100x760 layout: clear hierarchy, generous gutters, readable stats.
    const width = 1100;
    const height = 760;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const p = participant || {};
    const today = todayAttempt || {};
    const answers = Array.isArray(today.answers) ? today.answers : [];
    const todayPoints = answers.reduce((sum, answer) => sum + (Number(answer.pointsDelta) || 0), 0);
    const todayBonus = Number(today.streakBonus) || 0;
    const totalBonus = Number(p.streakBonusTotal) || 0;
    const correct = Number(p.correct) || 0;
    const incorrect = Number(p.incorrect) || 0;
    const timedOut = attempts.reduce((sum, attempt) => sum + (Number(attempt.timedOut) || 0), 0);
    const points = Number(p.points) || 0;
    const streak = Number(p.currentStreak) || 0;
    const completed = Number(p.challengesCompleted) || 0;
    const name = String(user.globalName || user.username || 'Player').slice(0, 26);
    const rankText = rankingsHidden ? 'SEALED' : rank ? `#${rank}` : 'UNRANKED';
    const rankSub = rankingsHidden ? 'Rankings are hidden' : rank ? `of ${participantCount} players` : 'Play to enter the rankings';
    const nextText = rankingsHidden ? 'Rank currently hidden' : rank === 1 ? 'You are leading the leaderboard!' : nextRankPoints !== null && Number.isFinite(Number(nextRankPoints)) ? `${Math.max(0, Number(nextRankPoints) - points + 1).toLocaleString()} pts to next rank` : 'Keep playing to climb';

    // Bright, warm premium look; no blue stripe or narrow decorative bars.
    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, '#111318'); bg.addColorStop(0.55, '#171b22'); bg.addColorStop(1, '#101217');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
    const glow = ctx.createRadialGradient(900, 90, 5, 900, 90, 520);
    glow.addColorStop(0, 'rgba(242,198,93,0.10)'); glow.addColorStop(1, 'rgba(242,198,93,0)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, width, height);
    const warm = ctx.createRadialGradient(120, 690, 5, 120, 690, 380);
    warm.addColorStop(0, 'rgba(255,255,255,0.025)'); warm.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = warm; ctx.fillRect(0, 0, width, height);

    // Outer frame and spacious inner content area.
    ctx.fillStyle = 'rgba(25,29,37,0.99)'; roundedRect(ctx, 24, 24, 1052, 712, 28, true);
    ctx.strokeStyle = 'rgba(190,198,211,0.22)'; ctx.lineWidth = 2; roundedRect(ctx, 24, 24, 1052, 712, 28, false); ctx.stroke();

    // Header
    const ax = 68, ay = 66, as = 116;
    ctx.save(); ctx.beginPath(); ctx.arc(ax + as/2, ay + as/2, as/2 + 7, 0, Math.PI*2);
    ctx.strokeStyle = '#e9bd59'; ctx.lineWidth = 4; ctx.stroke();
    ctx.beginPath(); ctx.arc(ax + as/2, ay + as/2, as/2, 0, Math.PI*2); ctx.clip();
    try { const avatar = await getCachedAvatar(user); ctx.drawImage(avatar, ax, ay, as, as); }
    catch { ctx.fillStyle = '#252b36'; ctx.fillRect(ax, ay, as, as); ctx.fillStyle = '#ffffff'; ctx.font = 'bold 54px Sans'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(name[0].toUpperCase(), ax+as/2, ay+as/2); }
    ctx.restore();

    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f2f3f6'; ctx.font = 'bold 42px Sans'; ctx.fillText(name, 218, 112);
    ctx.fillStyle = '#aeb5c1'; ctx.font = 'bold 18px Sans'; ctx.fillText('🌍 WEEKLY WORLD QUIZ  •  PLAYER PROFILE', 220, 150);
    ctx.textAlign = 'right'; ctx.fillStyle = '#efc65e'; ctx.font = 'bold 16px Sans'; ctx.fillText('PLAYER OVERVIEW', 1028, 91);
    ctx.fillStyle = '#a3aab6'; ctx.font = '16px Sans'; ctx.fillText('Your progress at a glance', 1028, 119);

    // Three prominent headline metrics.
    drawCard(ctx, 68, 218, 300, 156, '🏆 WEEKLY RANK', rankText, '#efc65e', rankSub);
    drawCard(ctx, 400, 218, 300, 156, '✨ TOTAL POINTS', points.toLocaleString(), '#f1f2f5', 'Your accumulated weekly score');
    drawCard(ctx, 732, 218, 300, 156, '🔥 CURRENT STREAK', `${streak} ${streak === 1 ? 'DAY' : 'DAYS'}`, '#efc65e', 'Consecutive challenge days');

    // Performance panel — left; daily progress panel — right.
    panel(ctx, 68, 410, 464, 270, '📊 PERFORMANCE');
    panel(ctx, 556, 410, 476, 270, '🌟 TODAY & PROGRESS');
    drawMetric(ctx, 98, 482, '✅ Correct answers', correct, '#59c99a');
    drawMetric(ctx, 302, 482, '❌ Incorrect answers', incorrect, '#f07883');
    drawMetric(ctx, 98, 568, '⏰ Timed out', timedOut, '#e8b85b');
    drawMetric(ctx, 302, 568, '🎯 Challenges done', completed, '#f1f2f5');

    drawMetric(ctx, 586, 482, '⭐ Today’s points', `${todayPoints >= 0 ? '+' : ''}${todayPoints}`, '#59c99a');
    drawMetric(ctx, 814, 482, '🔥 Streak bonus', `+${todayBonus}`, '#efc65e');
    ctx.textAlign = 'left'; ctx.fillStyle = '#a5adba'; ctx.font = '16px Sans'; ctx.fillText('NEXT ASCENSION', 586, 572);
    ctx.fillStyle = '#f1f2f5'; ctx.font = 'bold 21px Sans'; ctx.fillText(nextText, 586, 606, 410);
    ctx.fillStyle = '#a5adba'; ctx.font = '15px Sans'; ctx.fillText(`🏅 Lifetime streak bonuses: +${totalBonus.toLocaleString()}`, 586, 645);

    // Footer note separated from content, not squeezed into the panels.
    ctx.textAlign = 'center'; ctx.fillStyle = '#929aa7'; ctx.font = '14px Sans';
    ctx.fillText('WORLD ADVENTURE CLUB  •  KEEP EXPLORING, KEEP CLIMBING', width/2, 710);

    // JPEG is substantially smaller/faster to encode and upload than a full-size PNG.
    return canvas.toBuffer('image/jpeg', { quality: 0.88, progressive: true });
}

function roundedRect(ctx, x, y, width, height, radius, fill = false) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
    if (fill) ctx.fill();
}

function panel(ctx, x, y, width, height, title) {
    ctx.fillStyle = 'rgba(30,35,44,0.98)'; roundedRect(ctx, x, y, width, height, 20, true);
    ctx.strokeStyle = 'rgba(164,174,191,0.20)'; ctx.lineWidth = 1.5; roundedRect(ctx, x, y, width, height, 20, false); ctx.stroke();
    ctx.textAlign = 'left'; ctx.fillStyle = '#dfe3ea'; ctx.font = 'bold 17px Sans'; ctx.fillText(title, x + 28, y + 38);
}

function drawCard(ctx, x, y, width, height, label, value, valueColor, subtitle = '') {
    ctx.fillStyle = 'rgba(34,40,51,0.99)'; roundedRect(ctx, x, y, width, height, 20, true);
    ctx.strokeStyle = 'rgba(164,174,191,0.22)'; ctx.lineWidth = 1.5; roundedRect(ctx, x, y, width, height, 20, false); ctx.stroke();
    ctx.textAlign = 'left'; ctx.fillStyle = '#dfe3ea'; ctx.font = 'bold 16px Sans'; ctx.fillText(label, x + 26, y + 38);
    ctx.fillStyle = valueColor; ctx.font = 'bold 38px Sans'; ctx.fillText(String(value), x + 26, y + 91, width - 52);
    ctx.fillStyle = '#a5adba'; ctx.font = '15px Sans'; ctx.fillText(subtitle, x + 26, y + 126, width - 52);
}

function drawMetric(ctx, x, y, label, value, valueColor) {
    ctx.textAlign = 'left'; ctx.fillStyle = '#b7bec9'; ctx.font = '16px Sans'; ctx.fillText(label, x, y);
    ctx.fillStyle = valueColor; ctx.font = 'bold 29px Sans'; ctx.fillText(String(value), x, y + 38);
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

function leaderboardEmbed(state, rows, participantCount, participatedToday = new Set()) {
    const end = Math.floor(state.endsAt / 1000);
    const status = state.status === 'active' ? '🟢 Active' : '🔴 Ended';
    const board = rows.slice(0, 10)
        .map((player, index) => {
            const marker = participatedToday.has(String(player.userId)) ? '🟢' : '🔴';
            return `${marker} **${index + 1}.** <@${player.userId}>`;
        })
        .join('\n') || 'No participants yet. Be the first to play!';

    return new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('🏆 WEEKLY WORLD QUIZ • TOP 10')
        .setDescription(
            `**Status:** ${status}\n**Competition ends:** <t:${end}:F>\n\n` +
            `${board}\n\n🟢 Participated today  •  🔴 Not participated yet`
        )
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
    profileCardBuffer, profileComponents, profileMenuEmbed, rulesGuideEmbed,
    rankingSealedEmbed, leaderboardSealedEmbed,
};

