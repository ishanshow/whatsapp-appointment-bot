const DatabaseManager = require('../database/init');
const googleCalendar = require('./googleCalendar');
const whatsappService = require('./whatsappService');
const moment = require('moment');
require('moment-timezone');
const syncManager = require('../simple-sync-manager');
const logger = require('../utils/logger');

class AppointmentBot {
    constructor() {
        this.db = null;
        this.states = {
            MAIN_MENU: 'main_menu',
            COLLECTING_NAME: 'collecting_name',
            SELECTING_DATE: 'selecting_date',
            SELECTING_TIME: 'selecting_time',
            CONFIRMING_APPOINTMENT: 'confirming_appointment',
            VIEWING_APPOINTMENTS: 'viewing_appointments',
            SELECTING_APPOINTMENT_TO_RESCHEDULE: 'selecting_appointment_to_reschedule',
            SELECTING_APPOINTMENT_TO_CANCEL: 'selecting_appointment_to_cancel',
            RESCHEDULING_DATE: 'rescheduling_date',
            RESCHEDULING_TIME: 'rescheduling_time',
            CONFIRMING_RESCHEDULE: 'confirming_reschedule',
            CONFIRMING_CANCELLATION: 'confirming_cancellation'
        };
    }

    // Utility function to clean phone numbers: remove country code and @c.us suffix
    cleanPhoneNumber(phoneNumber) {
        if (!phoneNumber) return phoneNumber;

        // Remove @c.us suffix if present
        let cleaned = phoneNumber.replace('@c.us', '');

        // Remove whatsapp: prefix if present
        cleaned = cleaned.replace('whatsapp:', '');

        // Remove country code (first 2 digits) if the number is longer than 10 digits
        if (cleaned.length > 10) {
            cleaned = cleaned.substring(2);
        }

        // Ensure it's exactly 10 digits
        if (cleaned.length === 10 && /^\d{10}$/.test(cleaned)) {
            return cleaned;
        }

        // If not 10 digits, return original for debugging
        console.warn(`⚠️ Phone number cleaning failed for: ${phoneNumber} -> ${cleaned}`);
        return phoneNumber;
    }

    async init() {
        this.db = new DatabaseManager(process.env.DATABASE_PATH);
        await this.db.init();

        // Initialize Google Calendar
        try {
            await googleCalendar.authenticate();
            console.log('Google Calendar integration initialized');

            // Don't run sync immediately during initialization
            // Let the server's scheduled sync handle this
            console.log('Sync will be handled by scheduled server intervals');
        } catch (error) {
            console.error('Google Calendar initialization failed:', error.message);
            console.log('Continuing without Google Calendar integration');
            console.log('Note: Slot availability checking will use fallback method');
        }

        console.log('Appointment Bot initialized');
    }

    async syncExistingAppointments() {
        try {
            console.log('🔄 Syncing existing appointments to Google Calendar...');

            // Get appointments that don't have Google event IDs
            const appointmentsToSync = await this.db.query(
                'SELECT * FROM appointments WHERE google_event_id IS NULL AND status = ?',
                ['scheduled']
            );

            console.log(`Found ${appointmentsToSync.length} appointments to sync`);

            for (const appointment of appointmentsToSync) {
                try {
                    // Clean phone number when reading from database
                    const cleanedPhone = this.cleanPhoneNumber(appointment.patient_phone);
                    const patient = await this.getOrCreatePatient(cleanedPhone);

                    const timezone = process.env.TIMEZONE || 'Asia/Kolkata';
                    const startDateTime = moment.tz(`${appointment.appointment_date}T${appointment.appointment_time}:00`, timezone);
                    const endDateTime = startDateTime.clone().add(appointment.duration_minutes, 'minutes');

                    const eventDetails = {
                        summary: `Appointment - ${appointment.patient_name || 'Patient'}`,
                        description: `Patient: ${appointment.patient_name || 'Patient'}\nPhone: ${appointment.patient_phone}\nNotes: ${appointment.notes || ''}`,
                        start: {
                            dateTime: startDateTime.format(),
                            timeZone: timezone
                        },
                        end: {
                            dateTime: endDateTime.format(),
                            timeZone: timezone
                        }
                    };

                    const eventId = await googleCalendar.createEvent(eventDetails);

                    // Update the appointment with the Google event ID
                    await this.updateAppointment(appointment.id, {
                        google_event_id: eventId,
                        updated_at: new Date().toISOString()
                    });

                    console.log(`✅ Synced appointment ${appointment.id} to Google Calendar: ${eventId}`);
                } catch (syncError) {
                    console.error(`❌ Failed to sync appointment ${appointment.id}:`, syncError.message);
                    // Continue with next appointment even if this one fails
                }
            }

            console.log('✅ Existing appointments sync completed');
        } catch (error) {
            console.error('❌ Error syncing existing appointments:', error.message);
        }
    }

    /**
     * Repopulate database from Google Calendar
     * This method pulls all events from Google Calendar and creates corresponding appointments
     * Useful when database is purged and needs to be restored from calendar
     */
    async repopulateFromCalendar() {
        try {
            console.log('🔄 Starting database repopulation from Google Calendar...');

            // Get all calendar events
            const calendarAppointments = await googleCalendar.getAllCalendarEvents();
            console.log(`📅 Found ${calendarAppointments.length} appointments in Google Calendar`);

            let successCount = 0;
            let skipCount = 0;
            let errorCount = 0;

            for (const calendarAppointment of calendarAppointments) {
                try {
                    // Check if this appointment already exists in database
                    const existingAppointments = await this.db.query(
                        'SELECT * FROM appointments WHERE google_event_id = ?',
                        [calendarAppointment.google_event_id]
                    );

                    if (existingAppointments.length > 0) {
                        console.log(`⏭️ Skipping existing appointment with Google Event ID: ${calendarAppointment.google_event_id}`);
                        skipCount++;
                        continue;
                    }

                    // Clean phone number if present
                    let cleanedPhone = null;
                    if (calendarAppointment.patient_phone) {
                        cleanedPhone = this.cleanPhoneNumber(calendarAppointment.patient_phone);
                    }

                    // Create or update patient record if we have phone number
                    if (cleanedPhone) {
                        await this.getOrCreatePatient(cleanedPhone);

                        // Update patient name if we have it and it's different
                        if (calendarAppointment.patient_name && calendarAppointment.patient_name !== 'Unknown Patient') {
                            await this.updatePatientName(cleanedPhone, calendarAppointment.patient_name);
                        }
                    }

                    // Insert appointment into database
                    await this.db.run(
                        `INSERT OR IGNORE INTO appointments
                         (patient_phone, patient_name, appointment_date, appointment_time,
                          duration_minutes, google_event_id, status, notes, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            cleanedPhone,
                            calendarAppointment.patient_name,
                            calendarAppointment.appointment_date,
                            calendarAppointment.appointment_time,
                            calendarAppointment.duration_minutes,
                            calendarAppointment.google_event_id,
                            calendarAppointment.status,
                            calendarAppointment.notes,
                            calendarAppointment.created_at,
                            calendarAppointment.updated_at
                        ]
                    );

                    successCount++;
                    console.log(`✅ Imported appointment: ${calendarAppointment.appointment_date} ${calendarAppointment.appointment_time} - ${calendarAppointment.patient_name}`);
                } catch (appointmentError) {
                    console.error(`❌ Failed to import appointment:`, appointmentError.message);
                    errorCount++;
                }
            }

            console.log(`✅ Database repopulation completed:`);
            console.log(`   📊 Successfully imported: ${successCount}`);
            console.log(`   ⏭️ Skipped (already exists): ${skipCount}`);
            console.log(`   ❌ Failed: ${errorCount}`);

            return {
                success: successCount,
                skipped: skipCount,
                errors: errorCount
            };
        } catch (error) {
            console.error('❌ Error during database repopulation:', error.message);
            throw error;
        }
    }

    /**
     * Sync both ways: push database appointments to calendar AND pull calendar events to database
     * This ensures complete synchronization
     */
    async fullSync() {
        try {
            // Use simple sync manager to prevent concurrent syncs
            if (!syncManager.start()) {
                return { success: 0, skipped: 0, errors: 0 };
            }

            console.log('🔄 Starting full synchronization...');

            // First, sync existing database appointments to Google Calendar
            await this.syncExistingAppointments();

            // Then, repopulate database from Google Calendar (this will add any missing appointments)
            const repopulationResult = await this.repopulateFromCalendar();

            console.log('✅ Full synchronization completed');
            return repopulationResult;
        } catch (error) {
            console.error('❌ Error during full synchronization:', error.message);
            throw error;
        } finally {
            // Always end the sync operation
            syncManager.stop();
        }
    }

    async retryCalendarSyncForFailedAppointments() {
        try {
            console.log('🔄 Retrying Google Calendar sync for failed appointments...');

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
                    // Clean phone number when reading from database
                    const cleanedPhone = this.cleanPhoneNumber(appointment.patient_phone);
                    const patient = await this.getOrCreatePatient(cleanedPhone);

                    const timezone = process.env.TIMEZONE || 'Asia/Kolkata';
                    const startDateTime = moment.tz(`${appointment.appointment_date}T${appointment.appointment_time}:00`, timezone);
                    const endDateTime = startDateTime.clone().add(appointment.duration_minutes, 'minutes');

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

                    const eventId = await googleCalendar.createEvent(eventDetails);

                    // Update the appointment with the Google event ID
                    await this.updateAppointment(appointment.id, {
                        google_event_id: eventId,
                        updated_at: new Date().toISOString()
                    });

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

    async handleIncomingMessage(from, message, fullMessage = null) {
        try {
            // Clean phone number (remove whatsapp: prefix, country code, and @c.us suffix)
            const phoneNumber = this.cleanPhoneNumber(from);

            logger.logIncomingMessage(phoneNumber, message);

            // Get or create conversation state
            let state = await this.getConversationState(phoneNumber);

            if (!state) {
                // New conversation after completion - user sent a message, respond with initial message
                console.log(`📨 New message from ${phoneNumber} after conversation completion: "${message}"`);
                const patient = await this.getOrCreatePatient(phoneNumber);

                // Always ensure patient has a name - this is mandatory
                if (!patient.name) {
                    // Try to get name from WhatsApp contact info first
                    let whatsappName = null;
                    if (fullMessage && fullMessage._data && fullMessage._data.notifyName) {
                        whatsappName = fullMessage._data.notifyName;
                        console.log(`📱 Got WhatsApp contact name: ${whatsappName}`);
                    }

                    if (whatsappName && whatsappName.length >= 2 && whatsappName.length <= 50 && /^[a-zA-Z\s\-'\.]+$/.test(whatsappName)) {
                        // Use WhatsApp contact name automatically
                        await this.updatePatientName(phoneNumber, whatsappName);
                        console.log(`✅ Auto-saved WhatsApp contact name: ${whatsappName} for ${phoneNumber}`);

                        // Send just the menu options without the "how can I help you today" greeting
                        await whatsappService.sendMainMenuWithoutGreeting(phoneNumber, whatsappName);
                        // Go to main menu state
                        state = {
                            phone: phoneNumber,
                            state: this.states.MAIN_MENU,
                            context: {}
                        };
                        await this.saveConversationState(state);
                        logger.logStateTransition(phoneNumber, 'new', this.states.MAIN_MENU);
                        return;
                    } else {
                        // No valid WhatsApp name - collect name manually (mandatory)
                        state = {
                            phone: phoneNumber,
                            state: this.states.COLLECTING_NAME,
                            context: {}
                        };
                        await this.saveConversationState(state);
                        logger.logStateTransition(phoneNumber, 'new', this.states.COLLECTING_NAME);
                        await whatsappService.sendNameCollectionRequest(phoneNumber);
                        return;
                    }
                } else {
                    // Existing patient with name - send just menu options without "how can I help you today"
                    await whatsappService.sendMainMenuWithoutGreeting(phoneNumber, patient.name);
                    // Go to main menu state
                    state = {
                        phone: phoneNumber,
                        state: this.states.MAIN_MENU,
                        context: {}
                    };
                    await this.saveConversationState(state);
                    logger.logStateTransition(phoneNumber, 'new', this.states.MAIN_MENU);
                    return;
                }
            }

            // Handle message based on current state
            await this.processMessage(phoneNumber, message.trim(), state);

        } catch (error) {
            logger.logError('handleIncomingMessage', error, { from, message });
            await whatsappService.sendErrorMessage(from, 'system_error');
        }
    }

    async handleInvalidInput(phoneNumber, message, state) {
        console.log(`📝 Invalid input received: "${message}" in state: ${state.state}`);

        switch (state.state) {
            case this.states.MAIN_MENU:
                await whatsappService.sendMessage(phoneNumber, 'Please select a valid option (1-4) from the menu:');
                await whatsappService.sendMainMenu(phoneNumber, state.context?.patientName || 'Patient');
                break;

            case this.states.SELECTING_DATE:
                await whatsappService.sendMessage(phoneNumber, 'Please enter a valid date number from the list:');
                if (state.context?.availableDates) {
                    await whatsappService.sendAvailableDates(phoneNumber, state.context.availableDates);
                }
                break;

            case this.states.SELECTING_TIME:
                await whatsappService.sendMessage(phoneNumber, 'Please enter a valid time slot number from the list:');
                if (state.context?.selectedDate && state.context?.availableSlots) {
                    await whatsappService.sendAvailableSlots(phoneNumber, state.context.selectedDate, state.context.availableSlots);
                }
                break;

            case this.states.CONFIRMING_APPOINTMENT:
                await whatsappService.sendMessage(phoneNumber, 'Please reply with 1 to confirm or 2 to cancel:');
                if (state.context?.appointmentData) {
                    await whatsappService.sendAppointmentConfirmation(phoneNumber, state.context.appointmentData);
                }
                break;

            default:
                await whatsappService.sendMessage(phoneNumber, 'Please send a valid number corresponding to your choice.');
                break;
        }
    }

    async processMessage(phoneNumber, message, state) {
        const choice = parseInt(message);

        // Validate choice input - handle NaN and invalid numbers
        if (isNaN(choice) || choice <= 0) {
            await this.handleInvalidInput(phoneNumber, message, state);
            return;
        }

        switch (state.state) {
            case this.states.MAIN_MENU:
                await this.handleMainMenu(phoneNumber, choice);
                break;

            case this.states.SELECTING_DATE:
                await this.handleDateSelection(phoneNumber, choice, state);
                break;

            case this.states.SELECTING_TIME:
                await this.handleTimeSelection(phoneNumber, choice, state);
                break;

            case this.states.CONFIRMING_APPOINTMENT:
                await this.handleAppointmentConfirmation(phoneNumber, choice, state);
                break;

            case this.states.VIEWING_APPOINTMENTS:
                await this.handleViewAppointments(phoneNumber, choice, state);
                break;

            case this.states.SELECTING_APPOINTMENT_TO_RESCHEDULE:
                await this.handleAppointmentSelectionForReschedule(phoneNumber, choice, state);
                break;

            case this.states.SELECTING_APPOINTMENT_TO_CANCEL:
                await this.handleAppointmentSelectionForCancel(phoneNumber, choice, state);
                break;

            case this.states.RESCHEDULING_DATE:
                await this.handleRescheduleDateSelection(phoneNumber, choice, state);
                break;

            case this.states.RESCHEDULING_TIME:
                await this.handleRescheduleTimeSelection(phoneNumber, choice, state);
                break;

            case this.states.CONFIRMING_RESCHEDULE:
                await this.handleRescheduleConfirmation(phoneNumber, choice, state);
                break;

            case this.states.CONFIRMING_CANCELLATION:
                await this.handleCancellationConfirmation(phoneNumber, choice, state);
                break;

            case this.states.COLLECTING_NAME:
                await this.handleNameCollection(phoneNumber, message, state);
                break;

            default:
                const patient = await this.getOrCreatePatient(phoneNumber);
                await whatsappService.sendMainMenu(phoneNumber, patient.name);
        }
    }

    async handleMainMenu(phoneNumber, choice) {
        switch (choice) {
            case 1: // Schedule new appointment
                await this.startSchedulingFlow(phoneNumber);
                break;

            case 2: // Reschedule appointment
                await this.startReschedulingFlow(phoneNumber);
                break;

            case 3: // Cancel appointment
                await this.startCancellationFlow(phoneNumber);
                break;

            case 4: // View appointments
                await this.showUserAppointments(phoneNumber);
                break;

            default:
                await whatsappService.sendErrorMessage(phoneNumber, 'invalid_choice');
                const patient = await this.getOrCreatePatient(phoneNumber);
                await whatsappService.sendMainMenu(phoneNumber, patient.name);
        }
    }

    async startSchedulingFlow(phoneNumber) {
        try {
            // Sync with Google Calendar to get latest availability
            console.log('🔄 Syncing with Google Calendar for latest availability...');
            await whatsappService.sendMessage(phoneNumber, '🔄 *Syncing with calendar for latest availability...*');

            try {
                // Perform a quick sync to get latest calendar data
                await googleCalendar.getFutureCalendarEvents();
                console.log('✅ Calendar sync completed');
            } catch (syncError) {
                console.warn('⚠️ Calendar sync failed, continuing with cached data:', syncError.message);
            }

            const availableDates = await this.getAvailableDates();
            if (availableDates.length === 0) {
                await whatsappService.sendMessage(phoneNumber, 'Sorry, no dates are available for booking at this time. Please try again later.');
                const patient = await this.getOrCreatePatient(phoneNumber);
                await whatsappService.sendMainMenu(phoneNumber, patient.name);
                return;
            }

            await this.updateConversationState(phoneNumber, this.states.SELECTING_DATE, {
                availableDates: availableDates
            });

            await whatsappService.sendAvailableDates(phoneNumber, availableDates);
        } catch (error) {
            console.error('Error starting scheduling flow:', error.message);
            await whatsappService.sendErrorMessage(phoneNumber, 'system_error');
        }
    }

    async handleDateSelection(phoneNumber, choice, state) {
        const availableDates = state.context?.availableDates;

        // Check if availableDates exists and is an array
        if (!availableDates || !Array.isArray(availableDates)) {
            console.error('Available dates not found in conversation state');
            await whatsappService.sendErrorMessage(phoneNumber, 'system_error');
            await this.resetToMainMenu(phoneNumber);
            return;
        }

        const selectedIndex = choice - 1;

        if (selectedIndex < 0 || selectedIndex >= availableDates.length) {
            await whatsappService.sendErrorMessage(phoneNumber, 'invalid_choice');
            await whatsappService.sendAvailableDates(phoneNumber, availableDates);
            return;
        }

        const selectedDate = availableDates[selectedIndex];
        console.log('📅 Selected date:', selectedDate);

        // Sync with Google Calendar to get latest slots for this date
        console.log('🔄 Syncing calendar for latest slots on selected date...');
        await whatsappService.sendMessage(phoneNumber, '🔄 *Checking latest availability for this date...*');

        try {
            // Quick sync to ensure we have latest data for this specific date
            await googleCalendar.getFutureCalendarEvents();
            console.log('✅ Date-specific sync completed');
        } catch (syncError) {
            console.warn('⚠️ Date sync failed, continuing with cached data:', syncError.message);
        }

        const availableSlots = await this.getAvailableSlots(selectedDate);

        if (availableSlots.length === 0) {
            await whatsappService.sendMessage(phoneNumber, `No time slots available for ${moment(selectedDate).format('MMMM Do')}. Please choose another date.`);
            await whatsappService.sendAvailableDates(phoneNumber, availableDates);
            return;
        }

        console.log('⏰ Available slots for selected date:', availableSlots.length);

        await this.updateConversationState(phoneNumber, this.states.SELECTING_TIME, {
            selectedDate: selectedDate,
            availableSlots: availableSlots,
            availableDates: availableDates
        });

        await whatsappService.sendAvailableSlots(phoneNumber, selectedDate, availableSlots);
    }

    async handleTimeSelection(phoneNumber, choice, state) {
        // Safety check for required context
        if (!state.context || !state.context.availableSlots || !Array.isArray(state.context.availableSlots)) {
            await whatsappService.sendMessage(phoneNumber, 'Sorry, there was an issue with your time selection. Please start over.');
            await this.resetToMainMenu(phoneNumber);
            return;
        }

        const availableSlots = state.context.availableSlots;
        const availableDates = state.context.availableDates;
        const selectedDate = state.context.selectedDate;

        const selectedIndex = choice - 1;

        if (choice === availableSlots.length + 1) {
            // Choose different date
            await this.updateConversationState(phoneNumber, this.states.SELECTING_DATE, {
                availableDates: availableDates
            });
            await whatsappService.sendAvailableDates(phoneNumber, availableDates);
            return;
        }

        if (choice === availableSlots.length + 2) {
            // Go back to main menu
            await this.resetToMainMenu(phoneNumber);
            return;
        }

        if (selectedIndex < 0 || selectedIndex >= availableSlots.length || !availableSlots[selectedIndex]) {
            await whatsappService.sendErrorMessage(phoneNumber, 'invalid_choice');
            await whatsappService.sendAvailableSlots(phoneNumber, selectedDate, availableSlots);
            return;
        }

        const selectedSlot = availableSlots[selectedIndex];
        const appointmentData = {
            date: selectedDate,
            time: selectedSlot.start,
            duration: parseInt(process.env.APPOINTMENT_DURATION_MINUTES) || 30
        };

        console.log('⏰ Selected time slot:', selectedSlot);
        console.log('📅 Created appointment data:', appointmentData);

        await this.updateConversationState(phoneNumber, this.states.CONFIRMING_APPOINTMENT, {
            appointmentData: appointmentData,
            selectedSlot: selectedSlot,
            selectedDate: selectedDate,
            availableSlots: availableSlots,
            availableDates: availableDates
        });

        await whatsappService.sendConfirmationRequest(phoneNumber, appointmentData);
    }

    async handleAppointmentConfirmation(phoneNumber, choice, state) {
        console.log('📋 Handling appointment confirmation, state context:', JSON.stringify(state.context, null, 2));

        const appointmentData = state.context?.appointmentData;
        const selectedSlot = state.context?.selectedSlot;
        const availableSlots = state.context?.availableSlots;
        const availableDates = state.context?.availableDates;
        const selectedDate = state.context?.selectedDate;

        // Validate that we have the required data
        if (!appointmentData) {
            console.error('No appointment data found in conversation state');
            await whatsappService.sendErrorMessage(phoneNumber, 'system_error');
            await this.resetToMainMenu(phoneNumber);
            return;
        }

        switch (choice) {
            case 1: // Confirm appointment
                await this.confirmAppointment(phoneNumber, appointmentData);
                break;

            case 2: // Cancel
                await whatsappService.sendMessage(phoneNumber, 'Appointment booking cancelled.');
                await this.resetToMainMenu(phoneNumber);
                break;

            case 3: // Choose different time
                await this.updateConversationState(phoneNumber, this.states.SELECTING_TIME, {
                    selectedDate: selectedDate,
                    availableSlots: availableSlots,
                    availableDates: availableDates
                });
                await whatsappService.sendAvailableSlots(phoneNumber, selectedDate, availableSlots);
                break;

            default:
                await whatsappService.sendErrorMessage(phoneNumber, 'invalid_choice');
                await whatsappService.sendConfirmationRequest(phoneNumber, appointmentData);
        }
    }

    async confirmAppointment(phoneNumber, appointmentData) {
        try {
            console.log('📅 Confirming appointment:', appointmentData);

            // Validate appointment data
            if (!appointmentData || !appointmentData.date || !appointmentData.time) {
                console.error('Invalid appointment data:', appointmentData);
                await whatsappService.sendErrorMessage(phoneNumber, 'system_error');
                // Clear conversation state even on validation error to complete the conversation
                await this.clearConversationState(phoneNumber);
                return;
            }

            // Get patient info
            const patient = await this.getOrCreatePatient(phoneNumber);

            // Create appointment in database first (or get existing one)
            const appointmentResult = await this.saveAppointment({
                patient_phone: phoneNumber,
                patient_name: patient.name,
                appointment_date: appointmentData.date,
                appointment_time: appointmentData.time,
                duration_minutes: appointmentData.duration,
                google_event_id: null, // Will be updated after calendar event creation
                status: 'scheduled'
            });

            // If appointment already existed, check if it has a Google Calendar event
            let googleEventId = null;
            if (appointmentResult.existed) {
                // Get the existing appointment to check if it has a Google event ID
                const existingAppointment = await this.db.query(
                    'SELECT google_event_id FROM appointments WHERE id = ?',
                    [appointmentResult.id]
                );

                if (existingAppointment.length > 0 && existingAppointment[0].google_event_id) {
                    console.log('📅 Appointment already exists with Google Calendar event:', existingAppointment[0].google_event_id);
                    googleEventId = existingAppointment[0].google_event_id;
                }
            }

            // Create Google Calendar event only if we don't have one
            if (!googleEventId) {
                try {
                    const timezone = process.env.TIMEZONE || 'Asia/Kolkata';
                    const startDateTime = moment.tz(`${appointmentData.date}T${appointmentData.time}:00`, timezone);
                    const endDateTime = startDateTime.clone().add(appointmentData.duration, 'minutes');

                    const eventDetails = {
                        summary: `Appointment - ${patient.name || 'Patient'}`,
                        description: `Appointment with ${patient.name || 'Patient'} (${phoneNumber})`,
                        start: {
                            dateTime: startDateTime.format(),
                            timeZone: timezone
                        },
                        end: {
                            dateTime: endDateTime.format(),
                            timeZone: timezone
                        }
                    };

                    googleEventId = await googleCalendar.createEvent(eventDetails);
                    console.log('✅ Google Calendar event created:', googleEventId);

                    // Update appointment with Google event ID if created successfully
                    await this.updateAppointment(appointmentResult.id, {
                        google_event_id: googleEventId,
                        updated_at: new Date().toISOString()
                    });
                } catch (calendarError) {
                    console.error('❌ Failed to create Google Calendar event:', calendarError.message);
                    console.log('📝 Appointment saved to database without Google Calendar sync');
                    // Continue without calendar integration if it fails
                }
            }

            logger.logAppointmentCreated(appointmentResult.id, phoneNumber, appointmentData.date, appointmentData.time);
            await whatsappService.sendAppointmentConfirmation(phoneNumber, appointmentData);
            // Clear conversation state to complete the conversation
            await this.clearConversationState(phoneNumber);

        } catch (error) {
            console.error('Error confirming appointment:', error.message);
            await whatsappService.sendErrorMessage(phoneNumber, 'system_error');
            // Clear conversation state even on error to complete the conversation
            await this.clearConversationState(phoneNumber);
        }
    }

    async startReschedulingFlow(phoneNumber) {
        try {
            const appointments = await this.getUserAppointments(phoneNumber, 'scheduled');

            if (appointments.length === 0) {
                await whatsappService.sendErrorMessage(phoneNumber, 'no_appointments');
                await this.resetToMainMenu(phoneNumber);
                return;
            }

            let message = '📋 *Your Upcoming Appointments*\n\n';
            appointments.forEach((appointment, index) => {
                const date = moment(appointment.appointment_date).format('MMM Do, YYYY');
                message += `${index + 1}. ${date} at ${appointment.appointment_time}\n`;
            });
            message += `\n${appointments.length + 1}. Go Back to Main Menu\n\nWhich appointment would you like to reschedule?`;

            await this.updateConversationState(phoneNumber, this.states.SELECTING_APPOINTMENT_TO_RESCHEDULE, {
                appointments: appointments
            });

            await whatsappService.sendMessage(phoneNumber, message);

        } catch (error) {
            console.error('Error starting rescheduling flow:', error.message);
            await whatsappService.sendErrorMessage(phoneNumber, 'system_error');
        }
    }

    async startCancellationFlow(phoneNumber) {
        try {
            const appointments = await this.getUserAppointments(phoneNumber, 'scheduled');

            if (appointments.length === 0) {
                await whatsappService.sendErrorMessage(phoneNumber, 'no_appointments');
                await this.resetToMainMenu(phoneNumber);
                return;
            }

            let message = '📋 *Your Upcoming Appointments*\n\n';
            appointments.forEach((appointment, index) => {
                const date = moment(appointment.appointment_date).format('MMM Do, YYYY');
                message += `${index + 1}. ${date} at ${appointment.appointment_time}\n`;
            });
            message += `\n${appointments.length + 1}. Go Back to Main Menu\n\nWhich appointment would you like to cancel?`;

            await this.updateConversationState(phoneNumber, this.states.SELECTING_APPOINTMENT_TO_CANCEL, {
                appointments: appointments
            });

            await whatsappService.sendMessage(phoneNumber, message);

        } catch (error) {
            console.error('Error starting cancellation flow:', error.message);
            await whatsappService.sendErrorMessage(phoneNumber, 'system_error');
        }
    }



    async showUserAppointments(phoneNumber) {
        try {
            const appointments = await this.getUserAppointments(phoneNumber);

            if (appointments.length === 0) {
                await whatsappService.sendErrorMessage(phoneNumber, 'no_appointments');
                await this.resetToMainMenu(phoneNumber);
                return;
            }

            let message = '📋 *Your Appointments*\n\n';
            appointments.forEach((appointment, index) => {
                const date = moment(appointment.appointment_date).format('MMM Do, YYYY');
                const status = appointment.status === 'scheduled' ? '✅' : '❌';
                message += `${status} ${date} at ${appointment.appointment_time} (${appointment.status})\n`;
            });

            message += '\n1. Go Back to Main Menu';
            await this.updateConversationState(phoneNumber, this.states.VIEWING_APPOINTMENTS, {
                appointments: appointments
            });

            await whatsappService.sendMessage(phoneNumber, message);

        } catch (error) {
            console.error('Error showing appointments:', error.message);
            await whatsappService.sendErrorMessage(phoneNumber, 'system_error');
        }
    }

    // Database helper methods
    async getConversationState(phoneNumber) {
        try {
            const states = await this.db.query(
                'SELECT * FROM conversation_states WHERE phone = ?',
                [phoneNumber]
            );
            if (states.length > 0) {
                const state = states[0];
                // Parse the context JSON string back to object
                if (state.context && typeof state.context === 'string') {
                    try {
                        state.context = JSON.parse(state.context);
                    } catch (parseError) {
                        console.error('Error parsing conversation context:', parseError.message);
                        state.context = {};
                    }
                } else if (!state.context) {
                    state.context = {};
                }
                return state;
            }
            return null;
        } catch (error) {
            console.error('Error getting conversation state:', error.message);
            return null;
        }
    }

    async saveConversationState(state) {
        try {
            await this.db.run(
                `INSERT OR REPLACE INTO conversation_states (phone, state, context, updated_at)
                 VALUES (?, ?, ?, datetime('now'))`,
                [state.phone, state.state, JSON.stringify(state.context || {})]
            );
        } catch (error) {
            console.error('Error saving conversation state:', error.message);
        }
    }

    async updateConversationState(phoneNumber, newState, context = {}) {
        await this.saveConversationState({
            phone: phoneNumber,
            state: newState,
            context: context
        });
    }

    async resetToMainMenu(phoneNumber) {
        await this.updateConversationState(phoneNumber, this.states.MAIN_MENU, {});
        const patient = await this.getOrCreatePatient(phoneNumber);
        await whatsappService.sendMainMenu(phoneNumber, patient.name);
    }

    async clearConversationState(phoneNumber) {
        try {
            await this.db.run(
                'DELETE FROM conversation_states WHERE phone = ?',
                [phoneNumber]
            );
            logger.logStateTransition(phoneNumber, 'any', 'cleared');
        } catch (error) {
            console.error('Error clearing conversation state:', error.message);
        }
    }

    async getOrCreatePatient(phoneNumber) {
        try {
            let patients = await this.db.query(
                'SELECT * FROM patients WHERE phone = ?',
                [phoneNumber]
            );

            if (patients.length === 0) {
                await this.db.run(
                    'INSERT INTO patients (phone) VALUES (?)',
                    [phoneNumber]
                );
                patients = await this.db.query(
                    'SELECT * FROM patients WHERE phone = ?',
                    [phoneNumber]
                );
            }

            return patients[0];
        } catch (error) {
            console.error('Error getting/creating patient:', error.message);
            return { phone: phoneNumber, name: null };
        }
    }

    async saveAppointment(appointmentData) {
        try {
            // First, check if an appointment already exists for this patient at this date/time
            const existingAppointment = await this.db.query(
                'SELECT id FROM appointments WHERE patient_phone = ? AND appointment_date = ? AND appointment_time = ? AND status IN (?, ?, ?)',
                [
                    appointmentData.patient_phone,
                    appointmentData.appointment_date,
                    appointmentData.appointment_time,
                    'scheduled',
                    'confirmed',
                    'pending'
                ]
            );

            if (existingAppointment.length > 0) {
                console.log(`⚠️  Appointment already exists for ${appointmentData.patient_phone} on ${appointmentData.appointment_date} at ${appointmentData.appointment_time} (ID: ${existingAppointment[0].id})`);
                return { id: existingAppointment[0].id, existed: true };
            }

            const result = await this.db.run(
                `INSERT INTO appointments
                 (patient_phone, patient_name, appointment_date, appointment_time,
                  duration_minutes, google_event_id, status, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
                [
                    appointmentData.patient_phone,
                    appointmentData.patient_name,
                    appointmentData.appointment_date,
                    appointmentData.appointment_time,
                    appointmentData.duration_minutes,
                    appointmentData.google_event_id,
                    appointmentData.status
                ]
            );
            return { id: result.id, existed: false };
        } catch (error) {
            console.error('Error saving appointment:', error.message);
            throw error;
        }
    }

    async updateAppointment(appointmentId, updateData) {
        try {
            const fields = [];
            const values = [];

            Object.keys(updateData).forEach(key => {
                fields.push(`${key} = ?`);
                values.push(updateData[key]);
            });

            values.push(appointmentId);

            await this.db.run(
                `UPDATE appointments SET ${fields.join(', ')} WHERE id = ?`,
                values
            );
        } catch (error) {
            console.error('Error updating appointment:', error.message);
            throw error;
        }
    }

    async getUserAppointments(phoneNumber, status = null) {
        try {
            let query = 'SELECT * FROM appointments WHERE patient_phone = ?';
            let params = [phoneNumber];

            if (status) {
                query += ' AND status = ?';
                params.push(status);
            }

            query += ' ORDER BY appointment_date ASC, appointment_time ASC';

            return await this.db.query(query, params);
        } catch (error) {
            console.error('Error getting user appointments:', error.message);
            return [];
        }
    }

    async getAvailableDates() {
        const dates = [];
        const today = moment().startOf('day');
        const maxAdvanceDays = parseInt(process.env.MAX_ADVANCE_BOOKING_DAYS) || 30;

        for (let i = 0; i < maxAdvanceDays; i++) {
            const date = today.clone().add(i, 'days');

            // Skip weekends if doctor doesn't work weekends
            if (date.day() === 0 || date.day() === 6) continue; // Skip Sunday and Saturday

            dates.push(date.format('YYYY-MM-DD'));
        }

        return dates;
    }

    async getAvailableSlots(date) {
        try {
            console.log('⏰ Getting available slots for date:', date);

            // Use Google Calendar to get truly available slots
            const availableSlots = await googleCalendar.getAvailableSlots(
                date,
                process.env.WORKING_HOURS_START || '09:00',
                process.env.WORKING_HOURS_END || '17:00',
                parseInt(process.env.APPOINTMENT_DURATION_MINUTES) || 30
            );

            console.log(`✅ Found ${availableSlots.length} available slots using Google Calendar`);
            return availableSlots;
        } catch (error) {
            console.error('❌ Error getting available slots from Google Calendar:', error.message);
            console.log('🔄 Falling back to basic slot generation...');

            // Fallback to basic slot generation if Google Calendar fails
            try {
                return await this.generateBasicSlots(date);
            } catch (fallbackError) {
                console.error('❌ Fallback slot generation also failed:', fallbackError.message);
                return [];
            }
        }
    }

    /**
     * Generate basic time slots without checking Google Calendar
     * Used as fallback when Google Calendar integration fails
     */
    async generateBasicSlots(date) {
        const workingHoursStart = process.env.WORKING_HOURS_START || '09:00';
        const workingHoursEnd = process.env.WORKING_HOURS_END || '17:00';
        const duration = parseInt(process.env.APPOINTMENT_DURATION_MINUTES) || 30;

        const slots = [];
        const [startHour, startMin] = workingHoursStart.split(':').map(Number);
        const [endHour, endMin] = workingHoursEnd.split(':').map(Number);

        let currentHour = startHour;
        let currentMin = startMin;

        while (currentHour < endHour || (currentHour === endHour && currentMin < endMin)) {
            const startTime = `${currentHour.toString().padStart(2, '0')}:${currentMin.toString().padStart(2, '0')}`;

            // Calculate end time
            let endMinCalc = currentMin + duration;
            let endHourCalc = currentHour;
            while (endMinCalc >= 60) {
                endMinCalc -= 60;
                endHourCalc += 1;
            }
            const endTime = `${endHourCalc.toString().padStart(2, '0')}:${endMinCalc.toString().padStart(2, '0')}`;

            // Only add if end time is within working hours
            if (endHourCalc < endHour || (endHourCalc === endHour && endMinCalc <= endMin)) {
                slots.push({
                    start: startTime,
                    end: endTime,
                    datetime: `${date}T${startTime}:00`
                });
            }

            // Move to next slot
            currentMin += duration;
            if (currentMin >= 60) {
                currentMin -= 60;
                currentHour += 1;
            }
        }

        return slots;
    }

    // Placeholder methods for rescheduling and cancellation - to be implemented
    async handleAppointmentSelectionForReschedule(phoneNumber, choice, state) {
        const appointments = state.context.appointments;
        const selectedIndex = choice - 1;

        if (choice === appointments.length + 1) {
            // Go back to main menu
            await this.resetToMainMenu(phoneNumber);
            return;
        }

        if (selectedIndex < 0 || selectedIndex >= appointments.length) {
            await whatsappService.sendErrorMessage(phoneNumber, 'invalid_choice');
            await this.startReschedulingFlow(phoneNumber);
            return;
        }

        const selectedAppointment = appointments[selectedIndex];
        const availableDates = await this.getAvailableDates();

        await this.updateConversationState(phoneNumber, this.states.RESCHEDULING_DATE, {
            selectedAppointment: selectedAppointment,
            availableDates: availableDates,
            originalAppointment: selectedAppointment
        });

        await whatsappService.sendAvailableDates(phoneNumber, availableDates);
    }

    async handleAppointmentSelectionForCancel(phoneNumber, choice, state) {
        const appointments = state.context.appointments;
        const selectedIndex = choice - 1;

        if (choice === appointments.length + 1) {
            // Go back to main menu
            await this.resetToMainMenu(phoneNumber);
            return;
        }

        if (selectedIndex < 0 || selectedIndex >= appointments.length) {
            await whatsappService.sendErrorMessage(phoneNumber, 'invalid_choice');
            await this.startCancellationFlow(phoneNumber);
            return;
        }

        const selectedAppointment = appointments[selectedIndex];
        const appointmentDate = moment(selectedAppointment.appointment_date).format('dddd, MMMM Do YYYY');

        await this.updateConversationState(phoneNumber, this.states.CONFIRMING_CANCELLATION, {
            selectedAppointment: selectedAppointment,
            appointments: appointments
        });

        const message = `❌ *Cancel Appointment*\n\n📅 Date: ${appointmentDate}\n⏰ Time: ${selectedAppointment.appointment_time}\n\nAre you sure you want to cancel this appointment?\n\n1. ✅ Yes, Cancel Appointment\n2. ❌ No, Keep Appointment\n\nReply with the number of your choice.`;

        await whatsappService.sendMessage(phoneNumber, message);
    }

    async handleRescheduleDateSelection(phoneNumber, choice, state) {
        const availableDates = state.context.availableDates;
        const originalAppointment = state.context.originalAppointment;
        const selectedIndex = choice - 1;

        if (selectedIndex < 0 || selectedIndex >= availableDates.length) {
            await whatsappService.sendErrorMessage(phoneNumber, 'invalid_choice');
            await whatsappService.sendAvailableDates(phoneNumber, availableDates);
            return;
        }

        const selectedDate = availableDates[selectedIndex];

        // Sync with Google Calendar to get latest slots for rescheduling
        console.log('🔄 Syncing calendar for latest slots during rescheduling...');
        await whatsappService.sendMessage(phoneNumber, '🔄 *Checking latest availability for rescheduling...*');

        try {
            // Quick sync to ensure we have latest data for this specific date
            await googleCalendar.getFutureCalendarEvents();
            console.log('✅ Reschedule date-specific sync completed');
        } catch (syncError) {
            console.warn('⚠️ Reschedule sync failed, continuing with cached data:', syncError.message);
        }

        const availableSlots = await this.getAvailableSlots(selectedDate);

        if (availableSlots.length === 0) {
            await whatsappService.sendMessage(phoneNumber, `No time slots available for ${moment(selectedDate).format('MMMM Do')}. Please choose another date.`);
            await whatsappService.sendAvailableDates(phoneNumber, availableDates);
            return;
        }

        await this.updateConversationState(phoneNumber, this.states.RESCHEDULING_TIME, {
            selectedDate: selectedDate,
            availableSlots: availableSlots,
            availableDates: availableDates,
            originalAppointment: originalAppointment
        });

        await whatsappService.sendAvailableSlots(phoneNumber, selectedDate, availableSlots);
    }

    async handleRescheduleTimeSelection(phoneNumber, choice, state) {
        const availableSlots = state.context.availableSlots;
        const availableDates = state.context.availableDates;
        const selectedDate = state.context.selectedDate;
        const originalAppointment = state.context.originalAppointment;
        const selectedIndex = choice - 1;

        if (choice === availableSlots.length + 1) {
            // Choose different date
            await this.updateConversationState(phoneNumber, this.states.RESCHEDULING_DATE, {
                availableDates: availableDates,
                originalAppointment: originalAppointment
            });
            await whatsappService.sendAvailableDates(phoneNumber, availableDates);
            return;
        }

        if (choice === availableSlots.length + 2) {
            // Go back to main menu
            await this.resetToMainMenu(phoneNumber);
            return;
        }

        if (selectedIndex < 0 || selectedIndex >= availableSlots.length) {
            await whatsappService.sendErrorMessage(phoneNumber, 'invalid_choice');
            await whatsappService.sendAvailableSlots(phoneNumber, selectedDate, availableSlots);
            return;
        }

        const selectedSlot = availableSlots[selectedIndex];
        const newAppointmentData = {
            date: selectedDate,
            time: selectedSlot.start,
            duration: parseInt(process.env.APPOINTMENT_DURATION_MINUTES) || 30
        };

        await this.updateConversationState(phoneNumber, this.states.CONFIRMING_RESCHEDULE, {
            newAppointmentData: newAppointmentData,
            selectedSlot: selectedSlot,
            selectedDate: selectedDate,
            availableSlots: availableSlots,
            availableDates: availableDates,
            originalAppointment: originalAppointment
        });

        const originalDate = moment(originalAppointment.appointment_date).format('dddd, MMMM Do YYYY');
        const newDate = moment(selectedDate).format('dddd, MMMM Do YYYY');

        let message = `🔄 *Reschedule Appointment*\n\n📅 *Current:* ${originalDate} at ${originalAppointment.appointment_time}\n📅 *New:* ${newDate} at ${selectedSlot.start}\n\nWould you like to confirm this rescheduling?\n\n1. ✅ Yes, Reschedule\n2. ❌ No, Keep Original\n3. 🔄 Choose Different Time\n\nReply with the number of your choice.`;

        await whatsappService.sendMessage(phoneNumber, message);
    }

    async handleRescheduleConfirmation(phoneNumber, choice, state) {
        const newAppointmentData = state.context.newAppointmentData;
        const originalAppointment = state.context.originalAppointment;
        const availableSlots = state.context.availableSlots;
        const availableDates = state.context.availableDates;
        const selectedDate = state.context.selectedDate;

        switch (choice) {
            case 1: // Confirm reschedule
                await this.confirmReschedule(phoneNumber, originalAppointment, newAppointmentData);
                break;

            case 2: // Keep original
                await whatsappService.sendMessage(phoneNumber, 'Appointment rescheduling cancelled. Your original appointment remains unchanged.');
                await this.resetToMainMenu(phoneNumber);
                break;

            case 3: // Choose different time
                await this.updateConversationState(phoneNumber, this.states.RESCHEDULING_TIME, {
                    selectedDate: selectedDate,
                    availableSlots: availableSlots,
                    availableDates: availableDates,
                    originalAppointment: originalAppointment
                });
                await whatsappService.sendAvailableSlots(phoneNumber, selectedDate, availableSlots);
                break;

            default:
                await whatsappService.sendErrorMessage(phoneNumber, 'invalid_choice');
                const originalDate = moment(originalAppointment.appointment_date).format('dddd, MMMM Do YYYY');
                const newDate = moment(selectedDate).format('dddd, MMMM Do YYYY');
                let message = `🔄 *Reschedule Appointment*\n\n📅 *Current:* ${originalDate} at ${originalAppointment.appointment_time}\n📅 *New:* ${newDate} at ${newAppointmentData.time}\n\nWould you like to confirm this rescheduling?\n\n1. ✅ Yes, Reschedule\n2. ❌ No, Keep Original\n3. 🔄 Choose Different Time\n\nReply with the number of your choice.`;
                await whatsappService.sendMessage(phoneNumber, message);
        }
    }

    async handleCancellationConfirmation(phoneNumber, choice, state) {
        const selectedAppointment = state.context.selectedAppointment;
        const appointments = state.context.appointments;

        switch (choice) {
            case 1: // Confirm cancellation
                await this.confirmCancellation(phoneNumber, selectedAppointment);
                break;

            case 2: // Keep appointment
                await whatsappService.sendMessage(phoneNumber, 'Appointment cancellation cancelled. Your appointment remains scheduled.');
                await this.resetToMainMenu(phoneNumber);
                break;

            default:
                await whatsappService.sendErrorMessage(phoneNumber, 'invalid_choice');
                const appointmentDate = moment(selectedAppointment.appointment_date).format('dddd, MMMM Do YYYY');
                const message = `❌ *Cancel Appointment*\n\n📅 Date: ${appointmentDate}\n⏰ Time: ${selectedAppointment.appointment_time}\n\nAre you sure you want to cancel this appointment?\n\n1. ✅ Yes, Cancel Appointment\n2. ❌ No, Keep Appointment\n\nReply with the number of your choice.`;
                await whatsappService.sendMessage(phoneNumber, message);
        }
    }

    async confirmCancellation(phoneNumber, appointment) {
        try {
            console.log('❌ Cancelling appointment:', appointment.id);

            // Cancel Google Calendar event if it exists
            if (appointment.google_event_id) {
                try {
                    await googleCalendar.deleteEvent(appointment.google_event_id);
                    console.log('✅ Google Calendar event cancelled:', appointment.google_event_id);
                } catch (calendarError) {
                    console.error('❌ Failed to cancel Google Calendar event:', calendarError.message);
                }
            }

            // Update database
            await this.updateAppointment(appointment.id, {
                status: 'cancelled',
                updated_at: new Date().toISOString()
            });

            await whatsappService.sendAppointmentCancelled(phoneNumber, appointment);
            // Clear conversation state to complete the conversation
            await this.clearConversationState(phoneNumber);

        } catch (error) {
            console.error('Error confirming cancellation:', error.message);
            await whatsappService.sendErrorMessage(phoneNumber, 'system_error');
            // Clear conversation state even on error to complete the conversation
            await this.clearConversationState(phoneNumber);
        }
    }

    async confirmReschedule(phoneNumber, originalAppointment, newAppointmentData) {
        try {
            console.log('🔄 Rescheduling appointment:', originalAppointment.id);

            // Update Google Calendar event
            let newGoogleEventId = null;
            const patient = await this.getOrCreatePatient(phoneNumber);

            if (originalAppointment.google_event_id) {
                // Delete old event
                try {
                    await googleCalendar.deleteEvent(originalAppointment.google_event_id);
                    console.log('✅ Old Google Calendar event deleted:', originalAppointment.google_event_id);
                } catch (deleteError) {
                    console.error('❌ Failed to delete old Google Calendar event:', deleteError.message);
                }
            }

            // Create new event
            try {
                const timezone = process.env.TIMEZONE || 'Asia/Kolkata';
                const startDateTime = moment.tz(`${newAppointmentData.date}T${newAppointmentData.time}:00`, timezone);
                const endDateTime = startDateTime.clone().add(newAppointmentData.duration, 'minutes');

                const eventDetails = {
                    summary: `Appointment - ${patient.name || 'Patient'}`,
                    description: `Appointment with ${patient.name || 'Patient'} (${phoneNumber})`,
                    start: {
                        dateTime: startDateTime.format(),
                        timeZone: timezone
                    },
                    end: {
                        dateTime: endDateTime.format(),
                        timeZone: timezone
                    }
                };

                newGoogleEventId = await googleCalendar.createEvent(eventDetails);
                console.log('✅ New Google Calendar event created:', newGoogleEventId);
            } catch (createError) {
                console.error('❌ Failed to create new Google Calendar event:', createError.message);
            }

            // Update database
            await this.updateAppointment(originalAppointment.id, {
                appointment_date: newAppointmentData.date,
                appointment_time: newAppointmentData.time,
                duration_minutes: newAppointmentData.duration,
                google_event_id: newGoogleEventId,
                updated_at: new Date().toISOString()
            });

            await whatsappService.sendAppointmentRescheduled(phoneNumber, originalAppointment, newAppointmentData);
            // Clear conversation state to complete the conversation
            await this.clearConversationState(phoneNumber);

        } catch (error) {
            console.error('Error confirming reschedule:', error.message);
            await whatsappService.sendErrorMessage(phoneNumber, 'system_error');
            // Clear conversation state even on error to complete the conversation
            await this.clearConversationState(phoneNumber);
        }
    }

    async handleViewAppointments(phoneNumber, choice, state) {
        if (choice === 1) {
            await this.resetToMainMenu(phoneNumber);
        } else {
            await whatsappService.sendErrorMessage(phoneNumber, 'invalid_choice');
            await this.showUserAppointments(phoneNumber);
        }
    }

    async handleNameCollection(phoneNumber, message, state) {
        try {
            const name = message.trim();

            // Validate name (basic validation)
            if (name.length < 2 || name.length > 50 || !/^[a-zA-Z\s\-'\.]+$/.test(name)) {
                await whatsappService.sendErrorMessage(phoneNumber, 'invalid_name');
                await whatsappService.sendNameCollectionRequest(phoneNumber);
                return;
            }

            // Update patient name in database
            await this.updatePatientName(phoneNumber, name);

            // Move to main menu
            await this.updateConversationState(phoneNumber, this.states.MAIN_MENU, {});
            logger.logStateTransition(phoneNumber, this.states.COLLECTING_NAME, this.states.MAIN_MENU);

            await whatsappService.sendNameConfirmation(phoneNumber, name);
            await whatsappService.sendMainMenu(phoneNumber, name);

        } catch (error) {
            console.error('Error handling name collection:', error.message);
            await whatsappService.sendErrorMessage(phoneNumber, 'system_error');
        }
    }

    async updatePatientName(phoneNumber, name) {
        try {
            await this.db.run(
                'UPDATE patients SET name = ?, updated_at = datetime("now") WHERE phone = ?',
                [name, phoneNumber]
            );
        } catch (error) {
            console.error('Error updating patient name:', error.message);
            throw error;
        }
    }
}

module.exports = new AppointmentBot();
