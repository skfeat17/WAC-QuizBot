function calculatePoints({ correct, elapsedMs, timerMs }) {
    if (!correct) return 0;

    const total = Math.max(1, Number(timerMs));
    const elapsed = Math.min(
        total,
        Math.max(0, Number(elapsedMs))
    );

    /*
     * Precise speed scoring:
     * - Correct answer: 0.01-1000.00 points
     * - 1000.00 = effectively instant
     * - 0.01 = answered at the end of the timer
     * - Every millisecond affects the calculation
     * - Score is stored/displayed to 2 decimal places
     *
     * Example with a 15-second timer:
     *   0 ms       -> 1000 pts
     *   3000 ms    -> 800.00 pts
     *   7500 ms    -> 500.00 pts
     *   12000 ms   -> 200.00 pts
     *   1234 ms    -> 917.73 pts
     *   15000 ms   -> 0.01 pts
     */
    const remainingRatio = (total - elapsed) / total;
    const points = Number(
        (1000 * remainingRatio).toFixed(2)
    );

    return Math.max(0.01, Math.min(1000, points));
}

function rankPlayers(players) {
    return [...players]
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;

            if (a.totalAnswerMs !== b.totalAnswerMs) {
                return a.totalAnswerMs - b.totalAnswerMs;
            }

            if (a.lastAnswerAt !== b.lastAnswerAt) {
                return a.lastAnswerAt - b.lastAnswerAt;
            }

            return String(a.id).localeCompare(String(b.id));
        })
        .map((player, index) => ({
            ...player,
            rank: index + 1,
        }));
}

module.exports = {
    calculatePoints,
    rankPlayers,
};
