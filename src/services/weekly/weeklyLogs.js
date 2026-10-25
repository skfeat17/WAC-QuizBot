'use strict';

const PREFIX = '[WEEKLY]';

function timestamp() {
    return new Date().toLocaleString('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
    });
}
function formatUser(user) {
    if (!user) return 'Unknown user';
    return user.globalName || user.username || user.tag || 'Unknown';
}

function write(level, event, details = '') {
    const message = `${PREFIX} [${timestamp()}] ${event}${details ? ` | ${details}` : ''}`;
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    method(message);
}

function action(event, details = '') {
    write('info', event, details);
}

function blocked(user, reason, details = '') {
    write('warn', `🚫 BLOCKED: ${formatUser(user)} | ${reason}`, details);
}

function question(user, questionNumber, totalQuestions, questionText, attemptId) {
    const safeText = String(questionText || 'Unknown question').replace(/\s+/g, ' ').slice(0, 240);
    write('info', `📋 QUESTION ${questionNumber}/${totalQuestions}: ${formatUser(user)}`, `attempt=${attemptId || 'unknown'} | ${safeText}`);
}

function answer(user, questionNumber, choice, correct, pointsDelta, elapsedMs, attemptId) {
    write(correct ? 'info' : 'warn', `${correct ? '✅ CORRECT' : '❌ INCORRECT'}: ${formatUser(user)}`, `attempt=${attemptId || 'unknown'} | question=${questionNumber} | choice=${choice ?? 'timeout'} | points=${pointsDelta} | elapsed=${Math.max(0, Number(elapsedMs) || 0)}ms`);
}

function timeout(user, questionNumber, attemptId) {
    write('warn', `⏰ TIMEOUT: ${formatUser(user)}`, `attempt=${attemptId || 'unknown'} | question=${questionNumber}`);
}

function error(event, error, details = '') {
    const message = error?.stack || error?.message || String(error || 'Unknown error');
    write('error', `❗ ${event}`, `${details ? `${details} | ` : ''}${message}`);
}

module.exports = { action, blocked, question, answer, timeout, error, formatUser };
