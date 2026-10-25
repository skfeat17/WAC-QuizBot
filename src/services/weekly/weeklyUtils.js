// Shared helpers for competition dates, scoring, and question deduplication.
const DAY_MS = 24 * 60 * 60 * 1000;

function competitionDay(startedAt, now = Date.now()) {
    return Math.max(1, Math.floor((now - startedAt) / DAY_MS) + 1);
}

function utcDateKey(timestamp = Date.now()) {
    return new Date(timestamp).toISOString().slice(0, 10);
}

function formatRemaining(milliseconds) {
    if (milliseconds <= 0) return 'Ended';
    const seconds = Math.floor(milliseconds / 1000);
    return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// Correct answers score 0–100 based on speed. Incorrect answers are handled by weekly.js.
function scoreForAnswer(elapsedMs, limitMs = 15_000) {
    const remaining = Math.max(0, Math.min(1, 1 - elapsedMs / limitMs));
    return Math.round(100 * remaining);
}

function normalizeText(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

const hashQuestion = (question) => normalizeText(question);
const hashSubject = (subject) => normalizeText(subject);

module.exports = { competitionDay, utcDateKey, formatRemaining, scoreForAnswer, hashQuestion, hashSubject };
