/**
 * Simple Sync Manager - Prevents duplicate sync operations
 * Simplified version with essential functionality only
 */

class SimpleSyncManager {
    constructor() {
        this.isRunning = false;
        this.lastRun = 0;
        this.minInterval = 5 * 60 * 1000; // 5 minutes
    }

    canRun() {
        const now = Date.now();
        const timeSinceLastRun = now - this.lastRun;

        if (this.isRunning) {
            console.log('⏳ Sync already running, skipping...');
            return false;
        }

        if (timeSinceLastRun < this.minInterval) {
            console.log(`⏰ Sync too frequent (${Math.round(timeSinceLastRun / 1000)}s ago), skipping...`);
            return false;
        }

        return true;
    }

    start() {
        if (!this.canRun()) return false;
        this.isRunning = true;
        this.lastRun = Date.now();
        return true;
    }

    stop() {
        this.isRunning = false;
    }

    /**
     * Force reset sync state (use with caution)
     */
    forceReset() {
        console.log('⚠️ Force resetting sync state');
        this.isRunning = false;
        this.lastRun = 0;
    }

    /**
     * Get status for monitoring
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            lastRun: this.lastRun,
            timeSinceLastRun: Date.now() - this.lastRun
        };
    }
}

// Export singleton instance
module.exports = new SimpleSyncManager();
