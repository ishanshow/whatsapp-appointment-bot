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

// QR Code endpoint - serves HTML page for QR scanning
app.get('/qr', (req, res) => {
    const qrHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp QR Code Authentication</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #25D366, #128C7E);
            margin: 0;
            padding: 0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .container {
            background: white;
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.1);
            text-align: center;
            max-width: 400px;
            width: 90%;
        }
        .logo {
            width: 80px;
            height: 80px;
            background: #25D366;
            border-radius: 20px;
            margin: 0 auto 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 36px;
            color: white;
        }
        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 24px;
        }
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 16px;
        }
        .qr-container {
            margin: 30px 0;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 15px;
            border: 2px dashed #e9ecef;
        }
        .qr-placeholder {
            color: #666;
            font-size: 16px;
            margin-bottom: 20px;
        }
        #qr-code {
            max-width: 100%;
            height: auto;
            border-radius: 10px;
            display: none;
        }
        .status {
            margin-top: 20px;
            padding: 15px;
            border-radius: 10px;
            font-weight: 500;
        }
        .status.loading {
            background: #fff3cd;
            color: #856404;
            border: 1px solid #ffeaa7;
        }
        .status.success {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }
        .status.error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
        }
        .instructions {
            background: #e3f2fd;
            padding: 20px;
            border-radius: 10px;
            margin-top: 20px;
            text-align: left;
        }
        .instructions h3 {
            margin-top: 0;
            color: #1976d2;
        }
        .instructions ol {
            margin: 10px 0 0 20px;
            padding: 0;
        }
        .instructions li {
            margin-bottom: 8px;
            color: #333;
        }
        .refresh-btn {
            background: #25D366;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 25px;
            cursor: pointer;
            font-size: 16px;
            margin-top: 20px;
            transition: background 0.3s;
        }
        .refresh-btn:hover {
            background: #128C7E;
        }
        .refresh-btn:disabled {
            background: #ccc;
            cursor: not-allowed;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">📱</div>
        <h1>WhatsApp Authentication</h1>
        <p class="subtitle">Scan the QR code with your WhatsApp mobile app</p>

        <div class="qr-container">
            <div id="qr-status" class="qr-placeholder">Generating QR code...</div>
            <img id="qr-code" alt="QR Code" />
        </div>

        <div id="status-message" class="status loading">
            🔄 Initializing WhatsApp connection...
        </div>

        <div class="instructions">
            <h3>📋 Instructions:</h3>
            <ol>
                <li>Open WhatsApp on your phone</li>
                <li>Go to Settings → Linked Devices</li>
                <li>Tap "Link a Device"</li>
                <li>Scan the QR code above</li>
            </ol>
        </div>

        <button id="refresh-btn" class="refresh-btn" onclick="refreshQR()">🔄 Refresh QR Code</button>
    </div>

    <script>
        let eventSource = null;
        let isAuthenticated = false;

        function initEventSource() {
            if (eventSource) {
                eventSource.close();
            }

            eventSource = new EventSource('/qr/events');

            eventSource.onmessage = function(event) {
                const data = JSON.parse(event.data);

                if (data.type === 'qr') {
                    displayQRCode(data.qr);
                } else if (data.type === 'authenticated') {
                    showAuthenticated();
                } else if (data.type === 'error') {
                    showError(data.message);
                } else if (data.type === 'ready') {
                    updateStatus('✅ WhatsApp is ready! You can close this page.', 'success');
                }
            };

            eventSource.onerror = function() {
                console.log('EventSource error, retrying in 3 seconds...');
                setTimeout(initEventSource, 3000);
            };
        }

        function displayQRCode(qrData) {
            const qrImage = document.getElementById('qr-code');
            const qrStatus = document.getElementById('qr-status');
            const statusMessage = document.getElementById('status-message');

            if (qrData) {
                // Generate QR code image URL using a QR code service
                qrImage.src = \`https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=\${encodeURIComponent(qrData)}\`;
                qrImage.style.display = 'block';
                qrStatus.style.display = 'none';
                statusMessage.textContent = '📱 Scan the QR code with WhatsApp';
                statusMessage.className = 'status';
                document.getElementById('refresh-btn').disabled = false;
            } else {
                qrImage.style.display = 'none';
                qrStatus.textContent = 'Generating QR code...';
                qrStatus.style.display = 'block';
                statusMessage.textContent = '🔄 Generating QR code...';
                statusMessage.className = 'status loading';
            }
        }

        function showAuthenticated() {
            isAuthenticated = true;
            const statusMessage = document.getElementById('status-message');
            statusMessage.textContent = '✅ Authentication successful! WhatsApp is connecting...';
            statusMessage.className = 'status success';
            document.getElementById('refresh-btn').disabled = true;

            // Close the page after successful authentication
            setTimeout(() => {
                window.close();
            }, 3000);
        }

        function showError(message) {
            const statusMessage = document.getElementById('status-message');
            statusMessage.textContent = \`❌ \${message}\`;
            statusMessage.className = 'status error';
            document.getElementById('refresh-btn').disabled = false;
        }

        function updateStatus(message, type = '') {
            const statusMessage = document.getElementById('status-message');
            statusMessage.textContent = message;
            if (type) {
                statusMessage.className = \`status \${type}\`;
            }
        }

        function refreshQR() {
            if (isAuthenticated) return;

            document.getElementById('refresh-btn').disabled = true;
            updateStatus('🔄 Refreshing QR code...', 'loading');

            fetch('/qr/refresh', { method: 'POST' })
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        updateStatus('🔄 Generating new QR code...', 'loading');
                    } else {
                        showError(data.message || 'Failed to refresh QR code');
                    }
                })
                .catch(error => {
                    showError('Failed to refresh QR code');
                    console.error('Refresh error:', error);
                })
                .finally(() => {
                    setTimeout(() => {
                        document.getElementById('refresh-btn').disabled = false;
                    }, 2000);
                });
        }

        // Initialize when page loads
        window.onload = function() {
            initEventSource();
        };

        // Cleanup on page unload
        window.onbeforeunload = function() {
            if (eventSource) {
                eventSource.close();
            }
        };
    </script>
</body>
</html>`;
    res.send(qrHtml);
});

// Server-Sent Events endpoint for QR code updates
let qrClients = [];
let currentQR = null;
let isAuthenticated = false;

app.get('/qr/events', (req, res) => {
    // Set headers for Server-Sent Events
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control',
    });

    // Send current state if available
    if (currentQR && !isAuthenticated) {
        res.write(`data: ${JSON.stringify({ type: 'qr', qr: currentQR })}\n\n`);
    } else if (isAuthenticated) {
        res.write(`data: ${JSON.stringify({ type: 'authenticated' })}\n\n`);
    }

    // Add this client to the list
    qrClients.push(res);

    // Remove client when connection closes
    req.on('close', () => {
        qrClients = qrClients.filter(client => client !== res);
    });
});

// Function to broadcast QR updates to all clients
function broadcastQRUpdate(type, data = null) {
    const message = JSON.stringify({ type, ...data });
    qrClients.forEach(client => {
        try {
            client.write(`data: ${message}\n\n`);
        } catch (error) {
            // Remove broken clients
            qrClients = qrClients.filter(c => c !== client);
        }
    });
}

// QR refresh endpoint
app.post('/qr/refresh', (req, res) => {
    try {
        if (isAuthenticated) {
            return res.json({ success: false, message: 'Already authenticated' });
        }

        // Reset QR state
        currentQR = null;
        broadcastQRUpdate('qr', { qr: null });

        // Trigger QR regeneration by reinitializing WhatsApp client
        const whatsappService = require('./whatsappService');
        if (whatsappService.client && !whatsappService.isReady) {
            console.log('🔄 Refreshing QR code...');
            whatsappService.client.initialize().catch(error => {
                console.error('❌ Failed to refresh QR code:', error.message);
            });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error refreshing QR code:', error.message);
        res.status(500).json({ success: false, message: 'Failed to refresh QR code' });
    }
});

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

// Set up WhatsApp event listeners for QR broadcasting
const whatsappEmitter = whatsappService.getEventEmitter();
whatsappEmitter.on('qr', (qr) => {
    currentQR = qr;
    isAuthenticated = false;
    broadcastQRUpdate('qr', { qr });
});

whatsappEmitter.on('authenticated', () => {
    isAuthenticated = true;
    currentQR = null;
    broadcastQRUpdate('authenticated');
});

whatsappEmitter.on('ready', () => {
    broadcastQRUpdate('ready');
});

whatsappEmitter.on('auth_failure', (msg) => {
    broadcastQRUpdate('error', { message: `Authentication failed: ${msg}` });
});

whatsappEmitter.on('disconnected', (reason) => {
    isAuthenticated = false;
    broadcastQRUpdate('error', { message: `Disconnected: ${reason}` });
});

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

        // Start the server
        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📱 WhatsApp: Connected via whatsapp-web.js (QR code authentication)`);
            console.log(`❤️  Health check: http://localhost:${PORT}/health`);
            console.log(`📅 Calendar auth health: http://localhost:${PORT}/health/calendar`);
            console.log(`📱 QR Code interface: http://localhost:${PORT}/qr`);

            console.log('\n📱 WhatsApp Setup (Free - whatsapp-web.js):');
            console.log('1. Visit: http://localhost:3000/qr to see the QR code in your browser');
            console.log('2. OR, a QR code will also be displayed in the terminal below');
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
