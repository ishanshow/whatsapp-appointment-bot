#!/usr/bin/env node

/**
 * Clean Server Restart Script
 * Restarts the server without accumulating event listeners
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('🔄 Restarting WhatsApp Appointment Bot...\n');

// Kill any existing Node processes for this app
const killExisting = () => {
    return new Promise((resolve) => {
        const isWindows = process.platform === 'win32';
        const command = isWindows ? 'taskkill' : 'pkill';
        const args = isWindows
            ? ['/F', '/IM', 'node.exe', '/FI', 'WINDOWTITLE eq WhatsApp*']
            : ['-f', 'node.*appointment.*bot'];

        const killProcess = spawn(command, args, { stdio: 'inherit' });

        killProcess.on('close', (code) => {
            console.log(`🛑 Killed existing processes (exit code: ${code})`);
            resolve();
        });

        killProcess.on('error', () => {
            console.log('ℹ️ No existing processes found to kill');
            resolve();
        });

        // Timeout after 5 seconds
        setTimeout(() => {
            console.log('⏰ Kill timeout reached, proceeding...');
            resolve();
        }, 5000);
    });
};

// Start the server
const startServer = () => {
    console.log('🚀 Starting server...');

    const serverProcess = spawn('node', ['src/server.js'], {
        stdio: 'inherit',
        cwd: path.dirname(__filename),
        detached: false
    });

    serverProcess.on('close', (code) => {
        console.log(`\n📊 Server exited with code: ${code}`);
    });

    serverProcess.on('error', (error) => {
        console.error('❌ Failed to start server:', error.message);
    });

    // Handle graceful shutdown of this script
    process.on('SIGINT', () => {
        console.log('\n🛑 Shutting down restart script...');
        serverProcess.kill();
        process.exit(0);
    });

    return serverProcess;
};

// Main restart sequence
const main = async () => {
    try {
        await killExisting();

        // Wait a moment for processes to fully terminate
        await new Promise(resolve => setTimeout(resolve, 2000));

        startServer();

        console.log('\n✅ Server restart completed!');
        console.log('   Monitor for EventEmitter warnings in the logs.');
        console.log('   If you see memory leak warnings, the fixes need adjustment.');

    } catch (error) {
        console.error('❌ Restart failed:', error.message);
        process.exit(1);
    }
};

main();
