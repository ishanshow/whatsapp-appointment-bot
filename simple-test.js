#!/usr/bin/env node

/**
 * Simple Test Script - Quick verification of system health
 */

require('dotenv').config();
const googleCalendar = require('./src/googleCalendar');
const DatabaseManager = require('./database/init');

async function quickTest() {
    console.log('🧪 Running quick system test...');

    const db = new DatabaseManager(process.env.DATABASE_PATH || './database/appointments.db');
    await db.init();

    try {
        // Check database
        const appointments = await db.query('SELECT COUNT(*) as count FROM appointments WHERE status = ?', ['scheduled']);
        console.log(`✅ Database: ${appointments[0].count} scheduled appointments`);

        // Check calendar (if authenticated)
        try {
            await googleCalendar.authenticate();
            const events = await googleCalendar.getUpcomingAppointments(7);
            console.log(`✅ Calendar: ${events.length} events (next 7 days)`);

            // Quick duplicate check
            const timeSlots = {};
            events.forEach(event => {
                const date = event.start.split('T')[0];
                const time = event.start.split('T')[1].substring(0, 5);
                const key = `${date}_${time}`;
                if (!timeSlots[key]) timeSlots[key] = [];
                timeSlots[key].push(event);
            });

            const duplicates = Object.values(timeSlots).filter(slot => slot.length > 1).length;
            console.log(`✅ Duplicates: ${duplicates} time slots with multiples`);

            if (duplicates === 0) {
                console.log('🎉 System is clean!');
            } else {
                console.log('⚠️  Some duplicates found - run maintenance');
            }

        } catch (error) {
            console.log('⚠️  Calendar not accessible:', error.message);
        }

    } catch (error) {
        console.error('❌ Test failed:', error.message);
    } finally {
        await db.close();
    }
}

// CLI interface
if (require.main === module) {
    quickTest();
}
