const googleCalendar = require('../src/googleCalendar');
const moment = require('moment-timezone');
const syncManager = require('../simple-sync-manager');

class CalendarSyncService {
    constructor(db) {
        this.db = db;
    }

    async syncAppointments() {
        try {
            // Use simple sync manager to prevent concurrent syncs
            if (!syncManager.start()) {
                return;
            }

            console.log('Starting calendar sync...');

            // Get all scheduled appointments from database
            const dbAppointments = await this.db.query(
                'SELECT * FROM appointments WHERE status = ? AND google_event_id IS NOT NULL',
                ['scheduled']
            );

            // Get all events from Google Calendar
            const calendarEvents = await googleCalendar.getUpcomingAppointments(30); // Next 30 days

            // Create maps for efficient lookup
            const dbAppointmentMap = new Map();
            const calendarEventMap = new Map();

            dbAppointments.forEach(appointment => {
                if (appointment.google_event_id) {
                    dbAppointmentMap.set(appointment.google_event_id, appointment);
                }
            });

            calendarEvents.forEach(event => {
                calendarEventMap.set(event.id, event);
            });

            // Find discrepancies
            const toCreateInCalendar = [];
            const toUpdateInCalendar = [];
            const toDeleteInCalendar = [];
            const toUpdateInDb = [];
            const toDeleteInDb = [];

            // Check database appointments against calendar
            for (const [eventId, dbAppointment] of dbAppointmentMap) {
                const calendarEvent = calendarEventMap.get(eventId);

                if (!calendarEvent) {
                    // Appointment exists in DB but not in calendar
                    console.log(`⚠️  Appointment ${dbAppointment.id} (${dbAppointment.patient_name}) has Google event ID ${dbAppointment.google_event_id} but event not found in calendar`);

                    // Be more conservative - only recreate if the appointment is recent (within last 24 hours)
                    // to avoid recreating events that might have been manually deleted or are outside the sync window
                    const appointmentDateTime = moment.tz(`${dbAppointment.appointment_date}T${dbAppointment.appointment_time}:00`, process.env.TIMEZONE || 'Asia/Kolkata');
                    const hoursSinceCreation = moment().diff(moment(dbAppointment.created_at), 'hours');

                    if (hoursSinceCreation <= 24) {
                        console.log(`🔄 Recreating recent appointment ${dbAppointment.id} in calendar`);
                        toCreateInCalendar.push(dbAppointment);
                    } else {
                        console.log(`⏰ Skipping old appointment ${dbAppointment.id} (created ${hoursSinceCreation} hours ago)`);
                    }
                } else {
                    // Check if details match - normalize both times to UTC for comparison
                    const timezone = process.env.TIMEZONE || 'Asia/Kolkata';

                    // Parse database datetime in the configured timezone
                    const dbDateTime = moment.tz(`${dbAppointment.appointment_date}T${dbAppointment.appointment_time}:00`, timezone);

                    // Parse Google Calendar datetime (already includes timezone info)
                    const calendarDateTime = moment(calendarEvent.start);

                    // Compare in UTC to avoid timezone issues
                    if (!dbDateTime.isSame(calendarDateTime)) {
                        // Details don't match - update calendar
                        toUpdateInCalendar.push({
                            dbAppointment,
                            calendarEvent
                        });
                    }
                }
            }

            // Check calendar events against database
            for (const [eventId, calendarEvent] of calendarEventMap) {
                const dbAppointment = dbAppointmentMap.get(eventId);

                if (!dbAppointment) {
                    // Event exists in calendar but not in database
                    // This might be manually created or from another system
                    // For now, we'll log it but not delete automatically
                    console.log(`Calendar event ${eventId} not found in database`);
                }
            }

            // Apply fixes
            await this.applySyncFixes(toCreateInCalendar, toUpdateInCalendar, toDeleteInCalendar, toUpdateInDb, toDeleteInDb);

            console.log('Calendar sync completed successfully');

        } catch (error) {
            console.error('Error during calendar sync:', error.message);
            throw error;
        } finally {
            // Always end the sync operation
            syncManager.stop();
        }
    }

    async applySyncFixes(toCreateInCalendar, toUpdateInCalendar, toDeleteInCalendar, toUpdateInDb, toDeleteInDb) {
        try {
            // Recreate missing calendar events
            for (const appointment of toCreateInCalendar) {
                console.log(`Recreating calendar event for appointment ${appointment.id}`);

                try {
                    const patient = await this.db.query(
                        'SELECT * FROM patients WHERE phone = ?',
                        [appointment.patient_phone]
                    );

                    const calendarEvent = await googleCalendar.createAppointment({
                        patientName: appointment.patient_name || (patient[0]?.name) || 'Patient',
                        patientPhone: appointment.patient_phone,
                        date: appointment.appointment_date,
                        time: appointment.appointment_time,
                        duration: appointment.duration_minutes
                    });

                    // Update database with new event ID
                    await this.db.run(
                        'UPDATE appointments SET google_event_id = ?, updated_at = datetime("now") WHERE id = ?',
                        [calendarEvent.eventId, appointment.id]
                    );

                } catch (error) {
                    console.error(`Failed to recreate calendar event for appointment ${appointment.id}:`, error.message);
                }
            }

            // Update mismatched calendar events
            for (const { dbAppointment, calendarEvent } of toUpdateInCalendar) {
                console.log(`Updating calendar event ${calendarEvent.id} for appointment ${dbAppointment.id}`);

                try {
                    const patient = await this.db.query(
                        'SELECT * FROM patients WHERE phone = ?',
                        [dbAppointment.patient_phone]
                    );

                    await googleCalendar.updateAppointment(calendarEvent.id, {
                        patientName: dbAppointment.patient_name || (patient[0]?.name) || 'Patient',
                        patientPhone: dbAppointment.patient_phone,
                        date: dbAppointment.appointment_date,
                        time: dbAppointment.appointment_time,
                        duration: dbAppointment.duration_minutes
                    });

                } catch (error) {
                    console.error(`Failed to update calendar event ${calendarEvent.id}:`, error.message);
                }
            }

            // Delete calendar events that shouldn't exist
            for (const eventId of toDeleteInCalendar) {
                console.log(`Deleting calendar event ${eventId}`);

                try {
                    await googleCalendar.cancelAppointment(eventId);
                } catch (error) {
                    console.error(`Failed to delete calendar event ${eventId}:`, error.message);
                }
            }

            // Update database records
            for (const appointment of toUpdateInDb) {
                console.log(`Updating database record for appointment ${appointment.id}`);

                try {
                    await this.db.run(
                        'UPDATE appointments SET updated_at = datetime("now") WHERE id = ?',
                        [appointment.id]
                    );
                } catch (error) {
                    console.error(`Failed to update database record ${appointment.id}:`, error.message);
                }
            }

            // Delete database records that shouldn't exist
            for (const appointment of toDeleteInDb) {
                console.log(`Deleting database record for appointment ${appointment.id}`);

                try {
                    await this.db.run(
                        'UPDATE appointments SET status = ?, updated_at = datetime("now") WHERE id = ?',
                        ['cancelled', appointment.id]
                    );
                } catch (error) {
                    console.error(`Failed to delete database record ${appointment.id}:`, error.message);
                }
            }

        } catch (error) {
            console.error('Error applying sync fixes:', error.message);
            throw error;
        }
    }

    async validateAppointmentData() {
        try {
            console.log('Validating appointment data...');

            // Check for appointments without Google event IDs
            const orphanedAppointments = await this.db.query(
                'SELECT * FROM appointments WHERE status = ? AND (google_event_id IS NULL OR google_event_id = "")',
                ['scheduled']
            );

            if (orphanedAppointments.length > 0) {
                console.log(`Found ${orphanedAppointments.length} appointments without Google event IDs`);

                for (const appointment of orphanedAppointments) {
                    try {
                        const patient = await this.db.query(
                            'SELECT * FROM patients WHERE phone = ?',
                            [appointment.patient_phone]
                        );

                        const calendarEvent = await googleCalendar.createAppointment({
                            patientName: appointment.patient_name || (patient[0]?.name) || 'Patient',
                            patientPhone: appointment.patient_phone,
                            date: appointment.appointment_date,
                            time: appointment.appointment_time,
                            duration: appointment.duration_minutes
                        });

                        await this.db.run(
                            'UPDATE appointments SET google_event_id = ?, updated_at = datetime("now") WHERE id = ?',
                            [calendarEvent.eventId, appointment.id]
                        );

                        console.log(`Created Google event for appointment ${appointment.id}`);

                    } catch (error) {
                        console.error(`Failed to create Google event for appointment ${appointment.id}:`, error.message);
                    }
                }
            }

            // Check for invalid date/time formats
            const invalidAppointments = await this.db.query(
                'SELECT * FROM appointments WHERE status = ? AND (appointment_date NOT LIKE "____-__-__" OR appointment_time NOT LIKE "__:__")',
                ['scheduled']
            );

            if (invalidAppointments.length > 0) {
                console.log(`Found ${invalidAppointments.length} appointments with invalid date/time formats`);

                for (const appointment of invalidAppointments) {
                    console.error(`Invalid appointment ${appointment.id}: date=${appointment.appointment_date}, time=${appointment.appointment_time}`);
                }
            }

            console.log('Appointment data validation completed');

        } catch (error) {
            console.error('Error validating appointment data:', error.message);
            throw error;
        }
    }

    async cleanupOldData() {
        try {
            console.log('Cleaning up old data...');

            // Mark old completed/cancelled appointments as archived (optional)
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

            const oldAppointments = await this.db.run(
                'UPDATE appointments SET status = ? WHERE status IN (?, ?) AND created_at < ?',
                ['archived', 'completed', 'cancelled', thirtyDaysAgo.toISOString()]
            );

            console.log(`Archived ${oldAppointments.changes} old appointments`);

            // Clean up old conversation states (older than 7 days)
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            const oldStates = await this.db.run(
                'DELETE FROM conversation_states WHERE updated_at < ?',
                [sevenDaysAgo.toISOString()]
            );

            console.log(`Cleaned up ${oldStates.changes} old conversation states`);

        } catch (error) {
            console.error('Error cleaning up old data:', error.message);
        }
    }

    async performFullSync() {
        try {
            // Use simple sync manager to prevent concurrent full syncs
            if (!syncManager.start()) {
                return;
            }

            console.log('Performing full calendar sync...');

            // Validate data integrity
            await this.validateAppointmentData();

            // Sync with Google Calendar
            await this.syncAppointments();

            // Retry failed calendar syncs from appointment bot
            await this.retryFailedAppointmentSyncs();

            // Clean up old data
            await this.cleanupOldData();

            console.log('Full sync completed successfully');

        } catch (error) {
            console.error('Error during full sync:', error.message);
            throw error;
        } finally {
            // Always end the sync operation
            syncManager.stop();
        }
    }

    async retryFailedAppointmentSyncs() {
        try {
            console.log('🔄 Retrying failed appointment syncs...');

            // Import appointment bot to call its retry method
            const AppointmentBot = require('../src/appointmentBot');

            // Get appointments that don't have Google event IDs and are scheduled
            const failedAppointments = await this.db.query(
                'SELECT * FROM appointments WHERE (google_event_id IS NULL OR google_event_id = "") AND status = ?',
                ['scheduled']
            );

            if (failedAppointments.length === 0) {
                console.log('✅ No failed appointments to retry sync for');
                return;
            }

            console.log(`Found ${failedAppointments.length} appointments that need Google Calendar sync`);

            let successCount = 0;
            let failureCount = 0;

            for (const appointment of failedAppointments) {
                try {
                    const patient = await this.db.query(
                        'SELECT * FROM patients WHERE phone = ?',
                        [appointment.patient_phone]
                    );

                    const timezone = process.env.TIMEZONE || 'Asia/Kolkata';
                    const startDateTime = moment.tz(`${appointment.appointment_date}T${appointment.appointment_time}:00`, timezone);
                    const endDateTime = startDateTime.clone().add(appointment.duration_minutes || 30, 'minutes');

                    const eventDetails = {
                        summary: `Appointment - ${appointment.patient_name || 'Patient'}`,
                        description: `Appointment with ${appointment.patient_name || 'Patient'} (${appointment.patient_phone})`,
                        start: {
                            dateTime: startDateTime.format(),
                            timeZone: timezone
                        },
                        end: {
                            dateTime: endDateTime.format(),
                            timeZone: timezone
                        }
                    };

                    const googleCalendar = require('../src/googleCalendar');
                    const eventId = await googleCalendar.createEvent(eventDetails);

                    // Update the appointment with the Google event ID
                    await this.db.run(
                        'UPDATE appointments SET google_event_id = ?, updated_at = datetime("now") WHERE id = ?',
                        [eventId, appointment.id]
                    );

                    console.log(`✅ Successfully synced appointment ${appointment.id} to Google Calendar: ${eventId}`);
                    successCount++;
                } catch (syncError) {
                    console.error(`❌ Still failed to sync appointment ${appointment.id}:`, syncError.message);
                    failureCount++;
                }
            }

            console.log(`✅ Retry sync completed: ${successCount} successful, ${failureCount} failed`);
        } catch (error) {
            console.error('❌ Error during retry sync:', error.message);
        }
    }
}

module.exports = CalendarSyncService;
