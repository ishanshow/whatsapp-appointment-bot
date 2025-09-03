#!/usr/bin/env node

/**
 * System Monitor
 * Regularly check and clean duplicates to prevent accumulation
 */

require('dotenv').config();
const maintenance = require('./maintenance');

async function monitorSystem() {
    console.log(`🔍 System Monitor - ${new Date().toISOString()}`);
    console.log('================================');

    try {
        // Check system status
        await maintenance.init();

        const dbDuplicates = await maintenance.checkDbDuplicates();
        const calendarDuplicates = await maintenance.checkCalendarDuplicates();

        console.log(`📊 Status: ${dbDuplicates.length} DB + ${calendarDuplicates.length} Calendar duplicates`);

        if (dbDuplicates.length > 0 || calendarDuplicates.length > 0) {
            console.log('🧹 Cleaning duplicates...');
            const dbCleaned = await maintenance.cleanDbDuplicates();
            const calendarCleaned = await maintenance.cleanCalendarDuplicates();
            console.log(`✅ Cleaned: ${dbCleaned} DB + ${calendarCleaned} Calendar duplicates`);
        } else {
            console.log('✅ System is clean');
        }

        await maintenance.close();

        // Schedule next check in 1 hour
        console.log('⏰ Next check in 1 hour');
        setTimeout(monitorSystem, 60 * 60 * 1000);

    } catch (error) {
        console.error('❌ Monitor error:', error.message);
        // Retry in 5 minutes on error
        setTimeout(monitorSystem, 5 * 60 * 1000);
    }
}

// Start monitoring if run directly
if (require.main === module) {
    console.log('🚀 Starting system monitor...');
    monitorSystem();
}

module.exports = monitorSystem;
