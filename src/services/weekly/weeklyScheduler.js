// Marks the event ended at its seven-day deadline without deleting any scores.
const { getState, setState } = require('./weeklyRedis');

let schedulerTimer = null;
let activeRecovery = null;
let activeClient = null;
let schedulerTickRunning = false;

async function checkCompetitionDeadline() {
    try {
        const state = await getState();
        if (!state || state.status !== 'active' || Date.now() < state.endsAt) return;
        state.status = 'ended';
        state.endedAt = Date.now();
        state.endReason = 'deadline';
        await setState(state);
        console.log('[weekly] The seven-day event ended. Scores and question history remain saved until /weekly action:end.');
    } catch (error) {
        console.error('[weekly] deadline check failed:', error.message || error);
    }
}

function startWeeklyScheduler(client = null, recoverExpired = null) {
    activeClient = client || activeClient;
    activeRecovery = recoverExpired || activeRecovery;
    if (schedulerTimer) return;
    const tick = async () => {
        if (schedulerTickRunning) return;
        schedulerTickRunning = true;
        try {
            await checkCompetitionDeadline();
            if (activeClient && activeRecovery) await activeRecovery(activeClient);
        } catch (error) {
            console.error('[weekly] scheduler tick failed:', error.message || error);
        } finally {
            schedulerTickRunning = false;
        }
    };
    tick();
    schedulerTimer = setInterval(tick, 10 * 1000);
    schedulerTimer.unref?.();
}

async function finalizeWeekly() {
    const state = await getState();
    if (!state || state.status !== 'active') return { ended: false };
    state.status = 'ended';
    state.endedAt = Date.now();
    state.endReason = 'admin';
    await setState(state);
    return { ended: true };
}

module.exports = { startWeeklyScheduler, finalizeWeekly };
