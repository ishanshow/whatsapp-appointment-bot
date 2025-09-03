#!/usr/bin/env node

/**
 * Unified Maintenance Script
 * Handles all cleanup, sync, and maintenance operations
 */

require('dotenv').config();
const googleCalendar = require('./src/googleCalendar');
const DatabaseManager = require('./database/init');

class MaintenanceManager {
    constructor() {
        this.db = null;
    }

    async init() {
        this.db = new DatabaseManager(process.env.DATABASE_PATH || './database/appointments.db');
        await this.db.init();
    }

    async close() {
        if (this.db) await this.db.close();
    }

    // Check for duplicates in database
    async checkDbDuplicates() {
        const duplicates = await this.db.query(`
            SELECT patient_phone, appointment_date, appointment_time, COUNT(*) as count
            FROM appointments
            WHERE status IN ('scheduled', 'confirmed', 'pending')
            GROUP BY patient_phone, appointment_date, appointment_time
            HAVING COUNT(*) > 1
        `);

        return duplicates;
    }

    // Check for duplicates in Google Calendar
    async checkCalendarDuplicates() {
        try {
            await googleCalendar.authenticate();
            const events = await googleCalendar.getUpcomingAppointments(30);

            const timeSlots = {};
            events.forEach(event => {
                const date = event.start.split('T')[0];
                const time = event.start.split('T')[1].substring(0, 5);
                const key = `${date}_${time}`;

                if (!timeSlots[key]) timeSlots[key] = [];
                timeSlots[key].push(event);
            });

            const duplicates = [];
            Object.entries(timeSlots).forEach(([key, events]) => {
                if (events.length > 1) {
                    duplicates.push({ timeSlot: key, count: events.length, events });
                }
            });

            return duplicates;
        } catch (error) {
            console.error('Calendar check failed:', error.message);
            return [];
        }
    }

    // Clean database duplicates (keep oldest record)
    async cleanDbDuplicates() {
        const duplicates = await this.checkDbDuplicates();

        if (duplicates.length === 0) {
            console.log('✅ No database duplicates found');
            return 0;
        }

        console.log(`🗑️  Found ${duplicates.length} duplicate groups in database`);
        let totalDeleted = 0;

        for (const dup of duplicates) {
            const records = await this.db.query(
                'SELECT id FROM appointments WHERE patient_phone = ? AND appointment_date = ? AND appointment_time = ? ORDER BY created_at ASC',
                [dup.patient_phone, dup.appointment_date, dup.appointment_time]
            );

            // Keep first record, delete others
            const toDelete = records.slice(1);
            if (toDelete.length > 0) {
                const ids = toDelete.map(r => r.id);
                await this.db.run(`DELETE FROM appointments WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
                totalDeleted += toDelete.length;
                console.log(`   Deleted ${toDelete.length} duplicates for ${dup.patient_phone} ${dup.appointment_date} ${dup.appointment_time}`);
            }
        }

        console.log(`✅ Database cleanup complete: ${totalDeleted} duplicates removed`);
        return totalDeleted;
    }

    // Clean calendar duplicates
    async cleanCalendarDuplicates() {
        try {
            await googleCalendar.authenticate();
            const appointments = await this.db.query(
                'SELECT id, google_event_id FROM appointments WHERE status = ? AND google_event_id IS NOT NULL',
                ['scheduled']
            );

            const events = await googleCalendar.getUpcomingAppointments(30);

            // Create map of valid event IDs from database
            const validEventIds = new Set(appointments.map(a => a.google_event_id));

            // Group events by time slot
            const timeSlots = {};
            events.forEach(event => {
                const date = event.start.split('T')[0];
                const time = event.start.split('T')[1].substring(0, 5);
                const key = `${date}_${time}`;

                if (!timeSlots[key]) timeSlots[key] = [];
                timeSlots[key].push(event);
            });

            let totalDeleted = 0;

            for (const [timeSlot, slotEvents] of Object.entries(timeSlots)) {
                if (slotEvents.length <= 1) continue;

                console.log(`🔍 Processing ${timeSlot}: ${slotEvents.length} events`);

                // Find events that match database records
                const validEvents = slotEvents.filter(e => validEventIds.has(e.id));
                const invalidEvents = slotEvents.filter(e => !validEventIds.has(e.id));

                // Keep first valid event, delete others
                if (validEvents.length > 0) {
                    // Delete all invalid events
                    for (const event of invalidEvents) {
                        await googleCalendar.cancelAppointment(event.id);
                        totalDeleted++;
                    }

                    // If multiple valid events, keep only the first one
                    if (validEvents.length > 1) {
                        for (let i = 1; i < validEvents.length; i++) {
                            await googleCalendar.cancelAppointment(validEvents[i].id);
                            totalDeleted++;
                        }
                    }
                } else {
                    // No valid events, keep only the first one
                    for (let i = 1; i < slotEvents.length; i++) {
                        await googleCalendar.cancelAppointment(slotEvents[i].id);
                        totalDeleted++;
                    }
                }
            }

            console.log(`✅ Calendar cleanup complete: ${totalDeleted} duplicates removed`);
            return totalDeleted;

        } catch (error) {
            console.error('Calendar cleanup failed:', error.message);
            return 0;
        }
    }

    // Run full maintenance
    async runFullMaintenance() {
        console.log('🔧 Starting full maintenance...');

        try {
            await this.init();

            console.log('\n1️⃣ Checking database duplicates...');
            const dbDuplicates = await this.checkDbDuplicates();

            console.log('\n2️⃣ Checking calendar duplicates...');
            const calendarDuplicates = await this.checkCalendarDuplicates();

            console.log(`\n📊 Summary:`);
            console.log(`   Database duplicates: ${dbDuplicates.length}`);
            console.log(`   Calendar duplicates: ${calendarDuplicates.length}`);

            if (dbDuplicates.length === 0 && calendarDuplicates.length === 0) {
                console.log('✅ No maintenance needed - system is clean!');
                return;
            }

            if (dbDuplicates.length > 0) {
                console.log('\n🗑️  Cleaning database duplicates...');
                await this.cleanDbDuplicates();
            }

            if (calendarDuplicates.length > 0) {
                console.log('\n📅 Cleaning calendar duplicates...');
                await this.cleanCalendarDuplicates();
            }

            console.log('\n🎉 Maintenance completed successfully!');

        } catch (error) {
            console.error('❌ Maintenance failed:', error.message);
        } finally {
            await this.close();
        }
    }

    // Quick status check
    async status() {
        try {
            await this.init();

            const dbDuplicates = await this.checkDbDuplicates();
            const calendarDuplicates = await this.checkCalendarDuplicates();

            console.log('📊 System Status:');
            console.log(`   Database duplicates: ${dbDuplicates.length}`);
            console.log(`   Calendar duplicates: ${calendarDuplicates.length}`);

            const totalAppointments = await this.db.query('SELECT COUNT(*) as count FROM appointments WHERE status = ?', ['scheduled']);
            console.log(`   Total appointments: ${totalAppointments[0].count}`);

            if (dbDuplicates.length === 0 && calendarDuplicates.length === 0) {
                console.log('✅ System is clean!');
            } else {
                console.log('⚠️  Maintenance needed');
            }

        } catch (error) {
            console.error('Status check failed:', error.message);
        } finally {
            await this.close();
        }
    }
}

// CLI interface
const maintenance = new MaintenanceManager();
const command = process.argv[2];

switch (command) {
    case 'status':
        maintenance.status();
        break;
    case 'clean-db':
        maintenance.init().then(() => maintenance.cleanDbDuplicates()).then(() => maintenance.close());
        break;
    case 'clean-calendar':
        maintenance.init().then(() => maintenance.cleanCalendarDuplicates()).then(() => maintenance.close());
        break;
    case 'full':
    default:
        maintenance.runFullMaintenance();
        break;
}
