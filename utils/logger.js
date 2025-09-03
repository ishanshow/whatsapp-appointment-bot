const fs = require('fs');
const path = require('path');

class Logger {
    constructor(logLevel = 'info') {
        this.logLevel = logLevel;
        this.levels = {
            error: 0,
            warn: 1,
            info: 2,
            debug: 3
        };

        // Create logs directory if it doesn't exist
        this.logsDir = path.join(__dirname, '..', 'logs');
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
    }

    shouldLog(level) {
        return this.levels[level] <= this.levels[this.logLevel];
    }

    formatMessage(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const baseMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

        if (Object.keys(meta).length > 0) {
            return `${baseMessage} ${JSON.stringify(meta)}`;
        }

        return baseMessage;
    }

    writeToFile(message) {
        const logFile = path.join(this.logsDir, `${new Date().toISOString().split('T')[0]}.log`);
        fs.appendFileSync(logFile, message + '\n');
    }

    log(level, message, meta = {}) {
        if (!this.shouldLog(level)) return;

        const formattedMessage = this.formatMessage(level, message, meta);

        // Console logging
        if (level === 'error') {
            console.error(formattedMessage);
        } else if (level === 'warn') {
            console.warn(formattedMessage);
        } else {
            console.log(formattedMessage);
        }

        // File logging
        try {
            this.writeToFile(formattedMessage);
        } catch (error) {
            console.error('Failed to write to log file:', error.message);
        }
    }

    error(message, meta = {}) {
        this.log('error', message, meta);
    }

    warn(message, meta = {}) {
        this.log('warn', message, meta);
    }

    info(message, meta = {}) {
        this.log('info', message, meta);
    }

    debug(message, meta = {}) {
        this.log('debug', message, meta);
    }

    // Specialized logging methods
    logIncomingMessage(from, message) {
        this.info('Incoming WhatsApp message', { from, message: message.substring(0, 100) });
    }

    logOutgoingMessage(to, message) {
        this.info('Outgoing WhatsApp message', { to, message: message.substring(0, 100) });
    }

    logAppointmentCreated(appointmentId, patientPhone, date, time) {
        this.info('Appointment created', { appointmentId, patientPhone, date, time });
    }

    logAppointmentUpdated(appointmentId, changes) {
        this.info('Appointment updated', { appointmentId, changes });
    }

    logAppointmentCancelled(appointmentId, patientPhone) {
        this.info('Appointment cancelled', { appointmentId, patientPhone });
    }

    logCalendarSync(action, details) {
        this.info('Calendar sync action', { action, ...details });
    }

    logError(operation, error, context = {}) {
        this.error(`Error in ${operation}`, {
            error: error.message,
            stack: error.stack,
            ...context
        });
    }

    logStateTransition(phoneNumber, fromState, toState, context = {}) {
        this.debug('Conversation state transition', {
            phoneNumber,
            fromState,
            toState,
            context: JSON.stringify(context).substring(0, 200)
        });
    }
}

// Create singleton instance
const logger = new Logger(process.env.LOG_LEVEL || 'info');

module.exports = logger;
