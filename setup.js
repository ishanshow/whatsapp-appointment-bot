#!/usr/bin/env node

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const readline = require('readline');

console.log('🚀 WhatsApp Appointment Bot Setup');
console.log('===================================\n');

console.log('This setup will help you authenticate your WhatsApp account with the bot.\n');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.question('Are you ready to scan the QR code? (y/n): ', (answer) => {
    if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
        console.log('\n🔄 Initializing WhatsApp client...\n');

        const client = new Client({
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
                    '--single-process',
                    '--disable-gpu'
                ]
            }
        });

        client.on('qr', (qr) => {
            console.log('\n📱 Please scan this QR code with your WhatsApp mobile app:');
            console.log('1. Open WhatsApp on your phone');
            console.log('2. Go to Settings > Linked Devices');
            console.log('3. Tap "Link a Device"');
            console.log('4. Scan the QR code below:\n');
            qrcode.generate(qr, { small: true });
            console.log('\n⏳ Waiting for authentication... (45 seconds timeout)');
        });

        client.on('ready', () => {
            console.log('\n✅ WhatsApp authentication successful!');
            console.log('🎉 You can now run "npm start" to launch the appointment bot.');
            console.log('📝 Remember to keep your phone connected to maintain the WhatsApp Web session.');
            client.destroy();
            rl.close();
        });

        client.on('auth_failure', (msg) => {
            console.error('\n❌ Authentication failed:', msg);
            console.log('💡 Try running the setup again.');
            client.destroy();
            rl.close();
        });

        client.on('disconnected', (reason) => {
            console.log('\n🔌 WhatsApp disconnected:', reason);
            rl.close();
        });

        client.initialize();

        // Set timeout for QR code
        setTimeout(() => {
            console.log('\n⏰ QR code timeout reached. Please try again.');
            client.destroy();
            rl.close();
        }, 45000);

    } else {
        console.log('Setup cancelled. Run this script again when ready.');
        rl.close();
    }
});
