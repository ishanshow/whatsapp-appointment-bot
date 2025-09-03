const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const appointmentBot = require('./appointmentBot');
const DatabaseManager = require('../database/init');
const CalendarSyncService = require('../utils/calendarSync');
const logger = require('../utils/logger');
const whatsappService = require('./whatsappService');
const syncManager = require('../simple-sync-manager');

const app = express();
const PORT = process.env.PORT || 3000;

// Helper function to save tokens to .env file
async function saveTokensToEnv(envPath, tokens) {
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

// Middleware
app.use(helmet());
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Simple QR Code endpoint - displays QR code in plain text
app.get('/qr', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');

    if (isAuthenticated) {
        res.send(`
🚀 WhatsApp Authentication Status
================================

✅ AUTHENTICATION SUCCESSFUL!

Your WhatsApp bot is now connected and ready to use.

📱 You can now send messages to test the bot functionality.

🔄 To reconnect or generate a new QR code, restart the server.

================================
        `);
        return;
    }

    if (currentQR) {
        // Generate ASCII QR code like the terminal does
        const qrcode = require('qrcode-terminal');
        let qrOutput = '';

        // Capture the QR code output
        const originalWrite = process.stdout.write;
        process.stdout.write = (chunk) => {
            qrOutput += chunk.toString();
        };

        qrcode.generate(currentQR, { small: true });

        // Restore original stdout
        process.stdout.write = originalWrite;

        res.send(`
🚀 WhatsApp QR Code Authentication
==================================

📱 Please scan this QR code with your WhatsApp mobile app:

${qrOutput}

📋 Instructions:
1. Open WhatsApp on your phone
2. Go to Settings → Linked Devices
3. Tap "Link a Device"
4. Scan the QR code above

⏰ Make sure to scan within 45 seconds!

🔄 Refresh this page if the QR code expires.

==================================
        `);
    } else {
        res.send(`
🚀 WhatsApp Authentication Status
==================================

🔄 Generating QR code...

Please wait while we initialize the WhatsApp connection.

🔄 Refresh this page in a few seconds.

==================================
        `);
    }
});

// Global variables for QR state
let currentQR = null;
let isAuthenticated = false;

// Function to update server QR state
function updateQRState(qr = null, authenticated = null) {
    if (qr !== null) {
        currentQR = qr;
    }
    if (authenticated !== null) {
        isAuthenticated = authenticated;
    }
    console.log(`🔄 QR State updated - QR: ${currentQR ? 'Available' : 'None'}, Auth: ${isAuthenticated ? 'Yes' : 'No'}`);
}

// Export the update function for WhatsApp service to use
global.updateQRState = updateQRState;

// Google Calendar authentication health check
app.get('/health/calendar', async (req, res) => {
    try {
        const googleCalendar = require('./googleCalendar');

        // Test authentication and token validity
        await googleCalendar.ensureValidTokens();

        const hasAccessToken = !!process.env.GOOGLE_ACCESS_TOKEN;
        const hasRefreshToken = !!process.env.GOOGLE_REFRESH_TOKEN;

        res.json({
            status: 'OK',
            google_auth: {
                authenticated: googleCalendar.isAuthenticated,
                has_access_token: hasAccessToken,
                has_refresh_token: hasRefreshToken,
                calendar_id: process.env.GOOGLE_CALENDAR_ID
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'ERROR',
            google_auth: {
                authenticated: false,
                error: error.message,
                has_access_token: !!process.env.GOOGLE_ACCESS_TOKEN,
                has_refresh_token: !!process.env.GOOGLE_REFRESH_TOKEN
            },
            timestamp: new Date().toISOString()
        });
    }
});

// Manual sync endpoint
// app.post('/sync', async (req, res) => {
//     try {
//         await calendarSync.performFullSync();
//         res.json({ status: 'Sync completed successfully' });
//     } catch (error) {
//         console.error('Manual sync failed:', error.message);
//         res.status(500).json({ error: 'Sync failed', message: error.message });
//     }
// });

// Set up WhatsApp message handler
whatsappService.setMessageHandler(async (from, message, fullMessage) => {
    try {
        logger.logIncomingMessage(from, message);

        // Process the message through our bot
        await appointmentBot.handleIncomingMessage(from, message, fullMessage);

    } catch (error) {
        logger.logError('whatsapp_message_handler', error, { from, message });
    }
});

// Initialize QR state based on current WhatsApp state
async function initializeQRState() {
    const currentState = whatsappService.getCurrentState();

    // Check if WhatsApp is actually authenticated
    try {
        const authenticated = await whatsappService.isAuthenticated();
        console.log(`🔍 WhatsApp authentication state: ${authenticated ? 'Authenticated' : 'Not authenticated'}`);

        // Update server state using the global function
        updateQRState(currentState.currentQR, authenticated);
    } catch (error) {
        console.log('⚠️ Could not determine WhatsApp authentication state:', error.message);
        updateQRState(currentState.currentQR, currentState.isReady);
    }
}

// WhatsApp will update the global state variables directly

// Google OAuth initiation
app.get('/auth/google', (req, res) => {
    try {
        const { google } = require('googleapis');

        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );

        const scopes = [
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/calendar.events'
        ];

        const authorizationUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: scopes,
            include_granted_scopes: true,
            prompt: 'consent' // Force consent screen to ensure refresh token
        });

        res.redirect(authorizationUrl);
    } catch (error) {
        console.error('Error initiating Google OAuth:', error.message);
        res.status(500).send('Error initiating Google OAuth. Check your credentials.');
    }
});

// Google OAuth callback
app.get('/auth/google/callback', async (req, res) => {
    try {
        const { google } = require('googleapis');
        const fs = require('fs');
        const path = require('path');

        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );

        const { code } = req.query;

        if (!code) {
            return res.status(400).send('Authorization code not provided.');
        }

        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Save tokens to .env file
        const envPath = path.join(__dirname, '..', '.env');
        await saveTokensToEnv(envPath, tokens);

        res.send(`
            <h1>✅ Google Calendar Connected Successfully!</h1>
            <p>Your access and refresh tokens have been saved to the .env file.</p>
            <p>You can now:</p>
            <ul>
                <li>Restart your server: <code>npm start</code></li>
                <li>Test appointment booking via WhatsApp</li>
            </ul>
            <p><a href="http://localhost:3000/health">← Back to Health Check</a></p>
        `);

    } catch (error) {
        console.error('Error handling Google OAuth callback:', error.message);
        res.status(500).send(`Error: ${error.message}`);
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Global variables for database and sync service
let db = null;
let calendarSync = null;
let syncIntervals = []; // Store interval IDs for cleanup

// Initialize the application
async function startServer() {
    try {
        // Initialize database
        db = new DatabaseManager(process.env.DATABASE_PATH);
        await db.init();

        // Initialize calendar sync service
        calendarSync = new CalendarSyncService(db);

        // Initialize the appointment bot
        await appointmentBot.init();

        // Initialize QR state
        await initializeQRState();

        // Start the server
        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📱 WhatsApp: Connected via whatsapp-web.js (QR code authentication)`);
            console.log(`❤️  Health check: http://localhost:${PORT}/health`);
            console.log(`📅 Calendar auth health: http://localhost:${PORT}/health/calendar`);
            console.log(`📱 QR Code: http://localhost:${PORT}/qr (plain text)`);

            console.log('\n📱 WhatsApp Setup (Free - whatsapp-web.js):');
            console.log('1. QR code will be displayed in the terminal below');
            console.log('2. OR visit: http://localhost:3000/qr for plain text QR code');
            console.log('3. Open WhatsApp on your phone and go to Settings > Linked Devices');
            console.log('4. Tap "Link a Device" and scan the QR code');
            console.log('5. Once connected, you can send messages to your WhatsApp number to test');

            console.log('\n📅 Google Calendar Authentication:');
            console.log('1. Visit: http://localhost:3000/auth/google');
            console.log('2. Complete the OAuth flow to get both access and refresh tokens');
            console.log('3. Check authentication status: http://localhost:3000/health/calendar');
            console.log('4. Tokens are automatically refreshed and saved to .env file');

            console.log('\n🔧 Setting up automated sync processes...');

            // Set up WhatsApp connection health check (every 5 minutes)
            const whatsappHealthInterval = setInterval(async () => {
                try {
                    const isHealthy = await whatsappService.checkConnectionHealth();
                    if (!isHealthy) {
                        console.log('🔄 WhatsApp connection unhealthy, attempting recovery...');
                        await whatsappService.ensureConnection();
                    }
                } catch (error) {
                    console.error('WhatsApp health check failed:', error.message);
                }
            }, 5 * 60 * 1000); // 5 minutes
            syncIntervals.push(whatsappHealthInterval);

            // Set up periodic sync (every 30 minutes, but skip if recent sync occurred)
            const periodicSyncInterval = setInterval(async () => {
                try {
                    console.log('⏰ Periodic sync interval triggered');
                    console.log('   Sync manager status:', JSON.stringify(syncManager.getStatus(), null, 2));

                    // Use simple sync manager to check and start sync
                    if (!syncManager.start()) {
                        console.log('   ⏳ Periodic sync skipped (blocked by sync manager)');
                        return;
                    }

                    console.log('🚀 Running scheduled calendar sync...');
                    const syncStartTime = Date.now();

                    await calendarSync.performFullSync();

                    const syncDuration = Date.now() - syncStartTime;
                    console.log(`✅ Scheduled calendar sync completed in ${syncDuration}ms`);
                    console.log('   Sync manager status:', JSON.stringify(syncManager.getStatus(), null, 2));

                    syncManager.stop();
                } catch (error) {
                    console.error('❌ Scheduled sync failed:', error.message);
                    console.log('   Sync manager status:', JSON.stringify(syncManager.getStatus(), null, 2));
                    syncManager.stop();
                }
            }, 30 * 60 * 1000); // 30 minutes
            syncIntervals.push(periodicSyncInterval);

            // Set up periodic token refresh check (every 45 minutes)
            const tokenRefreshInterval = setInterval(async () => {
                try {
                    const googleCalendar = require('./googleCalendar');
                    await googleCalendar.ensureValidTokens();
                    console.log('✅ Google Calendar tokens validated/refreshed');
                } catch (error) {
                    console.error('❌ Google Calendar token refresh check failed:', error.message);
                }
            }, 45 * 60 * 1000); // 45 minutes
            syncIntervals.push(tokenRefreshInterval);

            console.log(`✅ Automated sync processes configured:`);
            console.log(`   📱 WhatsApp health check: Every 5 minutes`);
            console.log(`   🔄 Calendar sync: Every 30 minutes`);
            console.log(`   🔑 Token refresh: Every 45 minutes`);
            console.log(`   📊 Total background intervals: ${syncIntervals.length}`);

            // Perform initial sync after a longer delay to ensure everything is ready
            setTimeout(async () => {
                try {
                    console.log('🕐 Running initial calendar sync...');
                    console.log('   Sync manager status:', JSON.stringify(syncManager.getStatus(), null, 2));

                    // Use simple sync manager
                    if (!syncManager.start()) {
                        console.log('⏰ Initial sync skipped (recent sync detected)');
                        return;
                    }

                    console.log('🚀 Starting initial calendar sync...');
                    const startTime = Date.now();

                    await calendarSync.performFullSync();

                    const duration = Date.now() - startTime;
                    console.log(`✅ Initial calendar sync completed in ${duration}ms`);
                    console.log('   Sync manager status:', JSON.stringify(syncManager.getStatus(), null, 2));

                    syncManager.stop();
                } catch (error) {
                    console.error('❌ Initial sync failed:', error.message);
                    console.log('   Sync manager status:', JSON.stringify(syncManager.getStatus(), null, 2));
                    syncManager.stop();
                }
            }, 15000); // Wait 15 seconds for everything to be ready
        });

    } catch (error) {
        console.error('Failed to start server:', error.message);
        process.exit(1);
    }
}

// Increase max listeners to prevent memory leak warnings during development
process.setMaxListeners(20);

// Graceful shutdown handlers
const gracefulShutdown = async (signal) => {
    console.log(`${signal} received, shutting down gracefully...`);

    try {
        // Close database connections if needed
        if (global.dbConnection) {
            await global.dbConnection.close();
        }

        // Close WhatsApp connection gracefully
        if (whatsappService && whatsappService.client) {
            console.log('Closing WhatsApp connection...');
            await whatsappService.client.destroy();
        }

        // Clear all intervals to prevent memory leaks
        console.log(`Clearing ${syncIntervals.length} background intervals...`);
        syncIntervals.forEach(interval => {
            if (interval) clearInterval(interval);
        });

        console.log('Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        console.error('Error during graceful shutdown:', error.message);
        process.exit(1);
    }
};

// Remove existing listeners to prevent accumulation
process.removeAllListeners('SIGTERM');
process.removeAllListeners('SIGINT');

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start the server
startServer();

module.exports = app;
