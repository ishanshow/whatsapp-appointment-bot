const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const moment = require('moment');
const logger = require('../utils/logger');
const EventEmitter = require('events');

class WhatsAppService {
    constructor() {
        this.client = null;
        this.isReady = false;
        this.messageHandler = null;
        this.currentQR = null;
        this.eventEmitter = new EventEmitter();
        this.initialize();
    }

    async initialize() {
        try {
            this.client = new Client({
                authStrategy: new LocalAuth({
                    clientId: "whatsapp-appointment-bot"
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-gpu',
                        '--disable-web-security',
                        '--disable-features=VizDisplayCompositor',
                        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    ]
                },
                webVersionCache: {
                    type: 'remote',
                    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
                },
                // Additional stability settings
                restartOnAuthFail: true,
                takeoverOnConflict: true,
                takeoverTimeoutMs: 3000
            });

            this.client.on('qr', (qr) => {
                console.log('\n🚀 WhatsApp QR Code:');
                console.log('Please scan this QR code with your WhatsApp mobile app:');
                qrcode.generate(qr, { small: true });
                console.log('\n📱 Make sure to scan the QR code within 45 seconds!\n');

                // Store and emit QR code for web interface
                this.currentQR = qr;
                this.eventEmitter.emit('qr', qr);
            });

            this.client.on('ready', () => {
                console.log('✅ WhatsApp client is ready!');
                this.isReady = true;
                logger.info('WhatsApp client connected and ready');
                console.log('📱 You can now send messages to test the bot!');
            });

            this.client.on('authenticated', () => {
                console.log('🔐 WhatsApp client authenticated successfully');
                logger.info('WhatsApp client authenticated');

                // Emit authentication event and clear QR code
                this.currentQR = null;
                this.eventEmitter.emit('authenticated');
            });

            this.client.on('ready', () => {
                console.log('✅ WhatsApp client is ready!');
                this.isReady = true;
                logger.info('WhatsApp client connected and ready');
                console.log('📱 You can now send messages to test the bot!');

                // Emit ready event
                this.eventEmitter.emit('ready');
            });

            this.client.on('loading_screen', (percent, message) => {
                console.log(`⏳ Loading WhatsApp Web: ${percent}% - ${message}`);
            });

            this.client.on('auth_failure', (msg) => {
                console.error('❌ WhatsApp authentication failed:', msg);
                logger.error('WhatsApp authentication failed', { message: msg });

                // Emit error event
                this.eventEmitter.emit('auth_failure', msg);
            });

            this.client.on('disconnected', (reason) => {
                console.log('🔌 WhatsApp client disconnected:', reason);
                logger.warn('WhatsApp client disconnected', { reason });
                this.isReady = false;

                // Emit disconnected event
                this.eventEmitter.emit('disconnected', reason);

                // Attempt to reconnect after disconnection
                setTimeout(() => {
                    if (!this.isReady) {
                        console.log('🔄 Attempting to reconnect WhatsApp client...');
                        this.client.initialize().catch(error => {
                            console.error('❌ Failed to reconnect WhatsApp client:', error.message);
                        });
                    }
                }, 5000); // Wait 5 seconds before reconnecting
            });

            this.client.on('message', async (message) => {
                try {
                    console.log(`📨 Received message: "${message.body}" from ${message.from}`);
                    if (this.messageHandler) {
                        await this.messageHandler(message.from, message.body, message);
                        console.log(`✅ Message handler executed successfully`);
                    } else {
                        console.log(`⚠️ No message handler set`);
                    }
                } catch (error) {
                    console.error(`❌ Error in message handler:`, error.message);
                }
            });

            console.log('🔄 Initializing WhatsApp client...');
            await this.client.initialize();

        } catch (error) {
            logger.logError('WhatsApp initialization', error);
            console.error('❌ Failed to initialize WhatsApp client:', error.message);
        }
    }

    setMessageHandler(handler) {
        this.messageHandler = handler;
    }

    getEventEmitter() {
        return this.eventEmitter;
    }

    async checkConnectionHealth() {
        try {
            if (!this.client || !this.isReady) {
                return false;
            }

            // Try to get the current state
            const state = await this.client.getState();
            return state === 'CONNECTED';
        } catch (error) {
            console.log('⚠️ Connection health check failed:', error.message);
            this.isReady = false;
            return false;
        }
    }

    async ensureConnection() {
        const isHealthy = await this.checkConnectionHealth();
        if (!isHealthy && this.client) {
            console.log('🔄 Connection unhealthy, attempting to reconnect...');
            try {
                await this.client.initialize();
                // Wait for ready state
                let attempts = 0;
                while (!this.isReady && attempts < 10) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    attempts++;
                }
                return this.isReady;
            } catch (error) {
                console.error('❌ Failed to ensure connection:', error.message);
                return false;
            }
        }
        return true;
    }

    async sendMessage(to, message, retryCount = 0) {
        try {
            // Ensure connection is healthy before sending
            if (!this.isReady) {
                console.log('⚠️ WhatsApp client not ready, checking connection...');
                const connected = await this.ensureConnection();
                if (!connected) {
                    throw new Error('WhatsApp client is not ready');
                }
            }

            // Format phone number (remove any whatsapp: prefix and ensure proper format)
            let phoneNumber = to.replace('whatsapp:', '').replace('+', '');
            // Only add @c.us if it's not already present
            if (!phoneNumber.includes('@c.us')) {
                // If it's a 10-digit number, add country code 91 (India)
                if (phoneNumber.length === 10 && /^\d{10}$/.test(phoneNumber)) {
                    phoneNumber = '91' + phoneNumber;
                }
                phoneNumber = phoneNumber + '@c.us';
            }

            console.log(`📤 Attempting to send message to ${phoneNumber}: "${message.substring(0, 50)}..."`);

            const response = await this.client.sendMessage(phoneNumber, message);
            logger.logOutgoingMessage(phoneNumber, message);
            console.log(`✅ Message sent successfully to ${phoneNumber}`);
            return response;
        } catch (error) {
            console.error(`❌ Failed to send message (attempt ${retryCount + 1}):`, error.message);
            logger.logError('sendMessage', error, { to, message: message.substring(0, 100), retryCount });

            // Enhanced retry logic for common Puppeteer errors
            if (retryCount < 2 && (
                error.message.includes('Evaluation failed') ||
                error.message.includes('Session closed') ||
                error.message.includes('Target closed') ||
                error.message.includes('Protocol error') ||
                error.message.includes('Connection lost')
            )) {
                console.log(`🔄 Retrying message send (attempt ${retryCount + 1}/3)...`);

                // For evaluation errors, try to refresh the page first
                if (error.message.includes('Evaluation failed')) {
                    try {
                        console.log('🔧 Attempting to refresh WhatsApp Web page...');
                        await this.client.pupPage.reload({ waitUntil: 'networkidle0' });
                        await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for page to load
                    } catch (refreshError) {
                        console.log('⚠️ Page refresh failed, proceeding with retry anyway');
                    }
                }

                await new Promise(resolve => setTimeout(resolve, 2000 * (retryCount + 1))); // Exponential backoff
                return this.sendMessage(to, message, retryCount + 1);
            }

            throw error;
        }
    }

    async sendInteractiveMessage(to, message, options) {
        try {
            let interactiveMessage = `${message}\n\n`;

            options.forEach((option, index) => {
                interactiveMessage += `${index + 1}. ${option.text}\n`;
            });

            interactiveMessage += `\nReply with the number of your choice.`;

            return await this.sendMessage(to, interactiveMessage);
        } catch (error) {
            console.error('Error sending interactive message:', error.message);
            throw error;
        }
    }

    async sendAppointmentConfirmation(to, appointmentData) {
        try {
            const { date, time, duration } = appointmentData;
            const formattedDate = moment(date).format('dddd, MMMM Do YYYY');
            const message = `✅ *Appointment Confirmed!*\n\n📅 Date: ${formattedDate}\n⏰ Time: ${time}\n⏱️ Duration: ${duration} minutes\n\nThank you for booking with us! We'll send you a reminder before your appointment.`;

            return await this.sendMessage(to, message);
        } catch (error) {
            console.error('Error sending confirmation:', error.message);
            throw error;
        }
    }

    async sendAppointmentCancelled(to, appointmentData) {
        try {
            const { date, time } = appointmentData;
            const formattedDate = moment(date).format('dddd, MMMM Do YYYY');
            const message = `❌ *Appointment Cancelled*\n\n📅 Date: ${formattedDate}\n⏰ Time: ${time}\n\nYour appointment has been successfully cancelled. You can book a new appointment anytime.`;

            return await this.sendMessage(to, message);
        } catch (error) {
            console.error('Error sending cancellation message:', error.message);
            throw error;
        }
    }

    async sendAppointmentRescheduled(to, oldAppointment, newAppointment) {
        try {
            const oldDate = moment(oldAppointment.date).format('dddd, MMMM Do YYYY');
            const newDate = moment(newAppointment.date).format('dddd, MMMM Do YYYY');

            const message = `🔄 *Appointment Rescheduled*\n\n📅 *Previous:* ${oldDate} at ${oldAppointment.time}\n📅 *New:* ${newDate} at ${newAppointment.time}\n\nYour appointment has been successfully rescheduled.`;

            return await this.sendMessage(to, message);
        } catch (error) {
            console.error('Error sending reschedule message:', error.message);
            throw error;
        }
    }

    async sendAvailableDates(to, dates) {
        try {
            let message = `📅 *Available Dates*\n\nPlease select a date for your appointment:\n\n`;

            dates.forEach((date, index) => {
                const formattedDate = moment(date).format('dddd, MMM Do');
                message += `${index + 1}. ${formattedDate}\n`;
            });

            message += `\n${dates.length + 1}. Go Back to Main Menu\n\nReply with the number of your choice.`;

            return await this.sendMessage(to, message);
        } catch (error) {
            console.error('Error sending available dates:', error.message);
            throw error;
        }
    }

    async sendAvailableSlots(to, date, slots) {
        try {
            const formattedDate = moment(date).format('dddd, MMMM Do YYYY');
            let message = `⏰ *Available Time Slots for ${formattedDate}*\n\nPlease select a time slot:\n\n`;

            slots.forEach((slot, index) => {
                message += `${index + 1}. ${slot.start} - ${slot.end}\n`;
            });

            message += `\n${slots.length + 1}. Choose Different Date\n${slots.length + 2}. Go Back to Main Menu\n\nReply with the number of your choice.`;

            return await this.sendMessage(to, message);
        } catch (error) {
            console.error('Error sending available slots:', error.message);
            throw error;
        }
    }

    async sendMainMenu(to, patientName = '') {
        try {
            const greeting = patientName ? `Hello ${patientName}! ` : 'Hello! ';
            const message = `${greeting}How can I help you today?\n\n1. 📅 Schedule New Appointment\n2. 🔄 Reschedule Existing Appointment\n3. ❌ Cancel Appointment\n4. 📋 View My Appointments\n\nReply with the number of your choice.`;

            return await this.sendMessage(to, message);
        } catch (error) {
            console.error('Error sending main menu:', error.message);
            throw error;
        }
    }

    async sendMainMenuWithoutGreeting(to, patientName = '') {
        try {
            const greeting = patientName ? `Welcome back ${patientName}!` : 'Welcome back!';
            const message = `${greeting}\n\n1. 📅 Schedule New Appointment\n2. 🔄 Reschedule Existing Appointment\n3. ❌ Cancel Appointment\n4. 📋 View My Appointments\n\nReply with the number of your choice.`;

            return await this.sendMessage(to, message);
        } catch (error) {
            console.error('Error sending main menu without greeting:', error.message);
            throw error;
        }
    }

    async sendErrorMessage(to, errorType) {
        try {
            const errorMessages = {
                'invalid_choice': '❌ Invalid choice. Please reply with a valid number from the options provided.',
                'no_appointments': '📭 You don\'t have any upcoming appointments.',
                'appointment_not_found': '❌ Appointment not found. Please check your appointment details.',
                'conflict': '⚠️ Sorry, this time slot is no longer available. Please choose another slot.',
                'system_error': '🔧 Sorry, we\'re experiencing technical difficulties. Please try again later.',
                'invalid_name': '❌ Please enter a valid name (2-50 characters, letters, spaces, hyphens, apostrophes, and periods only).'
            };

            const message = errorMessages[errorType] || '❌ An error occurred. Please try again.';
            return await this.sendMessage(to, message);
        } catch (error) {
            console.error('Error sending error message:', error.message);
            throw error;
        }
    }

    async sendConfirmationRequest(to, appointmentData) {
        try {
            const { date, time, duration } = appointmentData;
            const formattedDate = moment(date).format('dddd, MMMM Do YYYY');

            const message = `📋 *Appointment Details*\n\n📅 Date: ${formattedDate}\n⏰ Time: ${time}\n⏱️ Duration: ${duration} minutes\n\nWould you like to confirm this appointment?\n\n1. ✅ Yes, Confirm\n2. ❌ No, Cancel\n3. 🔄 Choose Different Time\n\nReply with the number of your choice.`;

            return await this.sendMessage(to, message);
        } catch (error) {
            console.error('Error sending confirmation request:', error.message);
            throw error;
        }
    }

    async sendNameCollectionRequest(to) {
        try {
            const message = `👋 *Welcome to our Appointment System!*\n\nTo get started, please tell us your name so we can personalize your experience.\n\n📝 *Please reply with your full name:*`;

            return await this.sendMessage(to, message);
        } catch (error) {
            console.error('Error sending name collection request:', error.message);
            throw error;
        }
    }

    async sendNameConfirmation(to, name) {
        try {
            const message = `✅ *Name Saved Successfully!*\n\nHello ${name}! Your name has been saved to our system.\n\nYou can now use all our appointment services.`;

            return await this.sendMessage(to, message);
        } catch (error) {
            console.error('Error sending name confirmation:', error.message);
            throw error;
        }
    }


}

module.exports = new WhatsAppService();
