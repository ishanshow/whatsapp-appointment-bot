const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Helper function to save tokens to .env file
function saveTokensToEnv(envPath, tokens) {
    let envContent = '';

    try {
        envContent = fs.readFileSync(envPath, 'utf8');
    } catch (error) {
        // .env file doesn't exist, create it
        envContent = '';
    }

    // Remove existing token lines
    const lines = envContent.split('\n').filter(line =>
        !line.startsWith('GOOGLE_ACCESS_TOKEN=') &&
        !line.startsWith('GOOGLE_REFRESH_TOKEN=')
    );

    // Add new tokens
    lines.push(`GOOGLE_ACCESS_TOKEN=${tokens.access_token}`);
    if (tokens.refresh_token) {
        lines.push(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    }

    fs.writeFileSync(envPath, lines.join('\n'));
    console.log('✅ Tokens saved to .env file');
}

class GoogleCalendarService {
    constructor() {
        this.calendar = null;
        this.calendarId = process.env.GOOGLE_CALENDAR_ID;
        this.isAuthenticated = false;
        this.oauth2Client = null;

        // Initialize OAuth client if credentials are available
        if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
            this.oauth2Client = new google.auth.OAuth2(
                process.env.GOOGLE_CLIENT_ID,
                process.env.GOOGLE_CLIENT_SECRET,
                process.env.GOOGLE_REDIRECT_URI
            );
        }
    }

    async authenticate() {
        try {
            const credentials = {
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: process.env.GOOGLE_REDIRECT_URI
            };

            if (!credentials.client_id || !credentials.client_secret) {
                console.error('❌ Google OAuth credentials not configured');
                throw new Error('Google Calendar credentials not found. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env file');
            }

            // Initialize OAuth client if not already done
            if (!this.oauth2Client) {
                this.oauth2Client = new google.auth.OAuth2(
                    credentials.client_id,
                    credentials.client_secret,
                    credentials.redirect_uri
                );
            }

            // Get tokens from environment variables
            const tokens = {
                access_token: process.env.GOOGLE_ACCESS_TOKEN,
                refresh_token: process.env.GOOGLE_REFRESH_TOKEN
            };

            if (!tokens.access_token) {
                console.error('❌ No Google Calendar access token found');
                console.log('🔗 Please complete Google OAuth setup:');
                console.log('1. Visit: http://localhost:3000/auth/google');
                console.log('2. Complete the OAuth flow');
                console.log('3. Tokens will be saved automatically');
                throw new Error('Google Calendar tokens not found. Please complete OAuth setup at http://localhost:3000/auth/google');
            }

            console.log('Setting Google Calendar credentials...');
            this.oauth2Client.setCredentials({
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token
            });

            // Verify credentials were set properly
            if (!this.oauth2Client.credentials || !this.oauth2Client.credentials.access_token) {
                throw new Error('Failed to set OAuth credentials');
            }

            // Set up automatic token refresh with improved error handling
            this.oauth2Client.on('tokens', (newTokens) => {
                console.log('🔄 Google OAuth tokens refreshed');
                if (newTokens.refresh_token) {
                    console.log('📝 New refresh token received');
                }

                // Save refreshed tokens to .env file with better error handling
                try {
                    const envPath = path.join(__dirname, '..', '.env');
                    saveTokensToEnv(envPath, {
                        access_token: newTokens.access_token || this.oauth2Client.credentials.access_token,
                        refresh_token: newTokens.refresh_token || this.oauth2Client.credentials.refresh_token
                    });
                    console.log('💾 Tokens saved to .env file');
                } catch (saveError) {
                    console.error('❌ Failed to save refreshed tokens:', saveError.message);
                }
            });

            // Test the connection and handle token refresh
            try {
                await this.testConnection();
                this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
                this.isAuthenticated = true;
                console.log('✅ Google Calendar authenticated successfully');
                console.log('Calendar ID:', this.calendarId);
            } catch (testError) {
                console.error('❌ Token test failed:', testError.message);

                // Check if we can refresh the token
                if (this.canRefreshTokens(testError) && tokens.refresh_token) {
                    console.log('🔄 Attempting to refresh tokens...');
                    try {
                        const newTokens = await this.oauth2Client.refreshAccessToken();
                        console.log('✅ Tokens refreshed successfully');

                        // Save new tokens to .env file
                        if (newTokens.credentials.access_token) {
                            console.log('🔄 New access token obtained');
                            const envPath = path.join(__dirname, '..', '.env');
                            await saveTokensToEnv(envPath, {
                                access_token: newTokens.credentials.access_token,
                                refresh_token: newTokens.credentials.refresh_token || tokens.refresh_token
                            });

                            // Update credentials
                            this.oauth2Client.setCredentials(newTokens.credentials);
                        }

                        // Test connection again with refreshed tokens
                        await this.testConnection();
                        this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
                        this.isAuthenticated = true;
                        console.log('✅ Google Calendar authenticated successfully after refresh');
                        console.log('Calendar ID:', this.calendarId);
                    } catch (refreshError) {
                        console.error('❌ Token refresh failed:', refreshError.message);
                        throw new Error(`Google Calendar authentication failed: ${refreshError.message}. Please re-authorize at http://localhost:3000/auth/google`);
                    }
                } else {
                    // If we can't refresh or don't have refresh token, re-auth required
                    throw new Error(`Google Calendar authentication failed: ${testError.message}. Please re-authorize at http://localhost:3000/auth/google`);
                }
            }
        } catch (error) {
            console.error('Google Calendar authentication failed:', error.message);
            this.isAuthenticated = false;
            throw error;
        }
    }

    /**
     * Check if the error indicates tokens can be refreshed
     */
    canRefreshTokens(error) {
        const refreshableErrors = [
            'invalid_grant',
            'invalid_token',
            'access_denied',
            'token_expired',
            'Access token expired',
            'OAuth client not initialized',
            'Access token not available',
            'Token validation failed'
        ];

        return refreshableErrors.some(err =>
            error.message && error.message.includes(err)
        );
    }

    async testConnection() {
        try {
            // Check if OAuth client and credentials are properly initialized
            if (!this.oauth2Client) {
                throw new Error('OAuth client not initialized');
            }

            if (!this.oauth2Client.credentials || !this.oauth2Client.credentials.access_token) {
                throw new Error('Access token not available');
            }

            // Try to make a simple Calendar API call to test if tokens are valid
            // If this succeeds, tokens are valid. If it fails, tokens need refresh/re-auth
            try {
                // Initialize calendar API if not already done
                if (!this.calendar) {
                    this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
                }

                // Make a simple API call to test token validity
                await this.calendar.calendarList.list({ maxResults: 1 });

                // If we get here, tokens are valid
                // Return a mock token info object with current timestamp
                return {
                    expires_in: 3600, // Assume 1 hour remaining (will be checked by expiry logic)
                    issued_at: Math.floor(Date.now() / 1000),
                    scope: 'https://www.googleapis.com/auth/calendar'
                };
            } catch (apiError) {
                // If the API call fails, it might be due to invalid tokens
                console.warn('⚠️ Calendar API test failed, tokens may need refresh:', apiError.message);
                throw new Error(`Token validation failed: ${apiError.message}`);
            }
        } catch (error) {
            console.error('❌ Token validation error details:', error);
            throw new Error(`Token validation failed: ${error.message}`);
        }
    }

    /**
     * Proactively check and refresh tokens before they expire
     */
    async ensureValidTokens() {
        try {
            // First, ensure we're authenticated and have valid credentials
            if (!this.isAuthenticated || !this.oauth2Client || !this.oauth2Client.credentials) {
                console.log('🔐 Re-authenticating Google Calendar...');
                await this.authenticate();
                return;
            }

            // Test current tokens
            const tokenInfo = await this.testConnection();

            // Check if token is close to expiring (within 5 minutes)
            if (tokenInfo && typeof tokenInfo === 'object' && tokenInfo.expires_in && tokenInfo.expires_in < 300) { // 5 minutes
                console.log('🔄 Token expires soon, refreshing proactively...');
                await this.refreshTokens();
            } else if (!tokenInfo || typeof tokenInfo !== 'object') {
                console.warn('⚠️ Unexpected token info format, refreshing tokens to be safe...');
                await this.refreshTokens();
            }
        } catch (error) {
            console.error('❌ Token validation failed:', error.message);

            // Check if this is a recoverable error
            if (this.canRefreshTokens(error) && process.env.GOOGLE_REFRESH_TOKEN) {
                console.log('🔄 Attempting token refresh...');
                try {
                    await this.refreshTokens();
                } catch (refreshError) {
                    console.error('❌ Token refresh failed:', refreshError.message);
                    // If refresh fails, force re-authentication
                    this.isAuthenticated = false;
                    throw new Error('Token refresh failed. Please re-authenticate at http://localhost:3000/auth/google');
                }
            } else if (error.message.includes('OAuth client not initialized') ||
                       error.message.includes('Access token not available')) {
                // Force re-authentication for initialization errors
                console.log('🔐 Re-initializing OAuth client...');
                this.isAuthenticated = false;
                await this.authenticate();
            } else {
                throw error;
            }
        }
    }

    /**
     * Force refresh access token
     */
    async refreshTokens() {
        try {
            if (!process.env.GOOGLE_REFRESH_TOKEN) {
                throw new Error('No refresh token available');
            }

            if (!this.oauth2Client) {
                throw new Error('OAuth client not initialized');
            }

            console.log('🔄 Refreshing Google OAuth tokens...');
            const newTokens = await this.oauth2Client.refreshAccessToken();

            if (newTokens.credentials && newTokens.credentials.access_token) {
                // Update credentials
                this.oauth2Client.setCredentials(newTokens.credentials);

                // Save to .env file
                const envPath = path.join(__dirname, '..', '.env');
                await saveTokensToEnv(envPath, {
                    access_token: newTokens.credentials.access_token,
                    refresh_token: newTokens.credentials.refresh_token || process.env.GOOGLE_REFRESH_TOKEN
                });

                console.log('✅ Tokens refreshed and saved successfully');
                return newTokens.credentials;
            } else {
                throw new Error('No access token received from refresh');
            }
        } catch (error) {
            console.error('❌ Token refresh failed:', error.message);
            throw error;
        }
    }

    async getAvailableSlots(date, workingHoursStart = '09:00', workingHoursEnd = '17:00', appointmentDuration = 30) {
        try {
            await this.ensureValidTokens();

            const timezone = process.env.TIMEZONE || 'Asia/Kolkata';

            // Create dates in local timezone
            const startOfDay = new Date(`${date}T${workingHoursStart}:00`);
            const endOfDay = new Date(`${date}T${workingHoursEnd}:00`);

            // Get existing events for the day
            const events = await this.calendar.events.list({
                calendarId: this.calendarId,
                timeMin: startOfDay.toISOString(),
                timeMax: endOfDay.toISOString(),
                singleEvents: true,
                orderBy: 'startTime',
                timeZone: timezone
            });

            const busySlots = events.data.items.map(event => ({
                start: new Date(event.start.dateTime || event.start.date),
                end: new Date(event.end.dateTime || event.end.date)
            }));

            // Generate available slots
            const availableSlots = [];
            let currentTime = new Date(startOfDay);

            while (currentTime < endOfDay) {
                const slotEnd = new Date(currentTime.getTime() + appointmentDuration * 60000);

                if (slotEnd > endOfDay) break;

                // Check if slot conflicts with any existing events
                const isAvailable = !busySlots.some(busy => {
                    return (currentTime < busy.end && slotEnd > busy.start);
                });

                if (isAvailable) {
                    availableSlots.push({
                        start: currentTime.toTimeString().slice(0, 5),
                        end: slotEnd.toTimeString().slice(0, 5),
                        datetime: currentTime.toISOString()
                    });
                }

                currentTime = new Date(currentTime.getTime() + appointmentDuration * 60000);
            }

            return availableSlots;
        } catch (error) {
            console.error('Error getting available slots:', error.message);
            throw error;
        }
    }

    async createEvent(eventData) {
        try {
            await this.ensureValidTokens();

            console.log('📅 Creating Google Calendar event:', eventData);

            // Ensure timezone is set properly if not already specified
            if (eventData.start && !eventData.start.timeZone) {
                const timezone = process.env.TIMEZONE || 'Asia/Kolkata';
                if (eventData.start) eventData.start.timeZone = timezone;
                if (eventData.end) eventData.end.timeZone = timezone;
            }

            const response = await this.calendar.events.insert({
                calendarId: this.calendarId,
                resource: eventData
            });

            console.log('✅ Google Calendar event created successfully:', response.data.id);
            return response.data.id;
        } catch (error) {
            console.error('❌ Failed to create Google Calendar event:', error.message);
            console.error('Error details:', error.response?.data || error);
            throw error;
        }
    }

    async deleteEvent(eventId) {
        try {
            await this.ensureValidTokens();

            console.log('🗑️ Deleting Google Calendar event:', eventId);

            await this.calendar.events.delete({
                calendarId: this.calendarId,
                eventId: eventId
            });

            console.log('✅ Google Calendar event deleted successfully:', eventId);
        } catch (error) {
            console.error('❌ Failed to delete Google Calendar event:', error.message);
            console.error('Error details:', error.response?.data || error);
            throw error;
        }
    }

    async createAppointment(appointmentData) {
        try {
            await this.ensureValidTokens();

            const { patientName, patientPhone, date, time, duration = 30, notes = '' } = appointmentData;
            const timezone = process.env.TIMEZONE || 'Asia/Calcutta';

            // Format phone number for calendar invite (add country code if it's 10 digits)
            let formattedPhone = patientPhone;
            if (patientPhone.length === 10 && /^\d{10}$/.test(patientPhone)) {
                formattedPhone = '91' + patientPhone;
            }

            // Create datetime in local timezone
            const startDateTime = new Date(`${date}T${time}:00`);
            const endDateTime = new Date(startDateTime.getTime() + duration * 60000);

            const event = {
                summary: `Appointment: ${patientName}`,
                description: `Patient: ${patientName}\nPhone: ${formattedPhone}\nNotes: ${notes}`,
                start: {
                    dateTime: startDateTime.toISOString(),
                    timeZone: timezone
                },
                end: {
                    dateTime: endDateTime.toISOString(),
                    timeZone: timezone
                },
                attendees: [
                    { email: formattedPhone + '@whatsapp.com' } // Optional: send calendar invite
                ]
            };

            const response = await this.calendar.events.insert({
                calendarId: this.calendarId,
                resource: event
            });

            return {
                eventId: response.data.id,
                htmlLink: response.data.htmlLink
            };
        } catch (error) {
            console.error('Error creating appointment:', error.message);
            throw error;
        }
    }

    async updateAppointment(eventId, appointmentData) {
        try {
            await this.ensureValidTokens();

            const { patientName, patientPhone, date, time, duration = 30, notes = '' } = appointmentData;
            const timezone = process.env.TIMEZONE || 'Asia/Kolkata';

            // Format phone number for calendar description (add country code if it's 10 digits)
            let formattedPhone = patientPhone;
            if (patientPhone.length === 10 && /^\d{10}$/.test(patientPhone)) {
                formattedPhone = '91' + patientPhone;
            }

            const startDateTime = new Date(`${date}T${time}:00`);
            const endDateTime = new Date(startDateTime.getTime() + duration * 60000);

            const event = {
                summary: `Appointment: ${patientName}`,
                description: `Patient: ${patientName}\nPhone: ${formattedPhone}\nNotes: ${notes}`,
                start: {
                    dateTime: startDateTime.toISOString(),
                    timeZone: timezone
                },
                end: {
                    dateTime: endDateTime.toISOString(),
                    timeZone: timezone
                }
            };

            const response = await this.calendar.events.update({
                calendarId: this.calendarId,
                eventId: eventId,
                resource: event
            });

            return {
                eventId: response.data.id,
                htmlLink: response.data.htmlLink
            };
        } catch (error) {
            console.error('Error updating appointment:', error.message);
            throw error;
        }
    }

    async cancelAppointment(eventId) {
        try {
            await this.ensureValidTokens();

            await this.calendar.events.delete({
                calendarId: this.calendarId,
                eventId: eventId
            });

            return true;
        } catch (error) {
            console.error('Error cancelling appointment:', error.message);
            throw error;
        }
    }

    async getUpcomingAppointments(days = 7) {
        try {
            await this.ensureValidTokens();

            // Look back 1 day to catch appointments from earlier today
            const past = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
            const future = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

            const events = await this.calendar.events.list({
                calendarId: this.calendarId,
                timeMin: past.toISOString(),
                timeMax: future.toISOString(),
                singleEvents: true,
                orderBy: 'startTime'
            });

            return events.data.items.map(event => ({
                id: event.id,
                title: event.summary,
                start: event.start.dateTime || event.start.date,
                end: event.end.dateTime || event.end.date,
                description: event.description
            }));
        } catch (error) {
            console.error('Error getting upcoming appointments:', error.message);
            throw error;
        }
    }

    async checkConflicts(date, time, duration = 30) {
        try {
            await this.ensureValidTokens();

            const startDateTime = new Date(`${date}T${time}:00`);
            const endDateTime = new Date(startDateTime.getTime() + duration * 60000);

            const events = await this.calendar.events.list({
                calendarId: this.calendarId,
                timeMin: startDateTime.toISOString(),
                timeMax: endDateTime.toISOString(),
                singleEvents: true
            });

            return events.data.items.length > 0;
        } catch (error) {
            console.error('Error checking conflicts:', error.message);
            return false;
        }
    }

    /**
     * Pull all Google Calendar events and convert to appointment data format
     * This is used for repopulating the database from Google Calendar
     */
    async getAllCalendarEvents(timeMin = null, timeMax = null) {
        try {
            await this.ensureValidTokens();

            // Default to last 90 days to future events
            const defaultTimeMin = timeMin || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
            const defaultTimeMax = timeMax || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

            console.log('🔄 Pulling Google Calendar events from', defaultTimeMin, 'to', defaultTimeMax);

            const events = await this.calendar.events.list({
                calendarId: this.calendarId,
                timeMin: defaultTimeMin,
                timeMax: defaultTimeMax,
                singleEvents: true,
                orderBy: 'startTime',
                maxResults: 2500 // Google Calendar API limit
            });

            console.log(`📅 Found ${events.data.items.length} events in Google Calendar`);

            // Convert Google Calendar events to appointment format
            const appointments = events.data.items
                .filter(event => {
                    // Filter out cancelled events and events without proper timing
                    return event.status !== 'cancelled' &&
                           (event.start.dateTime || event.start.date) &&
                           (event.end.dateTime || event.end.date);
                })
                .map(event => {
                    // Extract patient information from event description
                    const description = event.description || '';
                    const patientPhoneMatch = description.match(/Phone:\s*(\+?\d+)/);
                    const patientNameMatch = description.match(/Patient:\s*([^\n]+)/) ||
                                           description.match(/Appointment:\s*([^\n]+)/) ||
                                           event.summary.match(/Appointment:\s*(.+)/);

                    // Parse date and time
                    const startDateTime = event.start.dateTime || event.start.date;
                    const endDateTime = event.end.dateTime || event.end.date;

                    const date = startDateTime.includes('T') ?
                        startDateTime.split('T')[0] :
                        startDateTime;

                    const time = startDateTime.includes('T') ?
                        startDateTime.split('T')[1].substring(0, 5) :
                        '00:00'; // All-day events default to 00:00

                    // Calculate duration in minutes
                    const startTime = new Date(startDateTime);
                    const endTime = new Date(endDateTime);
                    const durationMinutes = Math.round((endTime - startTime) / (1000 * 60));

                    return {
                        google_event_id: event.id,
                        patient_name: patientNameMatch ? patientNameMatch[1].trim() : 'Unknown Patient',
                        patient_phone: patientPhoneMatch ? patientPhoneMatch[1].trim() : null,
                        appointment_date: date,
                        appointment_time: time,
                        duration_minutes: durationMinutes,
                        status: 'scheduled',
                        notes: description,
                        created_at: event.created,
                        updated_at: event.updated
                    };
                });

            console.log(`✅ Converted ${appointments.length} Google Calendar events to appointments`);
            return appointments;
        } catch (error) {
            console.error('❌ Error pulling Google Calendar events:', error.message);
            throw error;
        }
    }

    /**
     * Get all future appointments from Google Calendar (for availability checking)
     */
    async getFutureCalendarEvents() {
        try {
            await this.ensureValidTokens();

            const now = new Date();
            const future = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // Next year

            return await this.getAllCalendarEvents(now.toISOString(), future.toISOString());
        } catch (error) {
            console.error('❌ Error getting future calendar events:', error.message);
            throw error;
        }
    }
}

module.exports = new GoogleCalendarService();
