# WhatsApp Appointment Scheduling Bot

A comprehensive WhatsApp chatbot application for doctors to manage patient appointments with Google Calendar integration. Patients can schedule, reschedule, and cancel appointments directly through WhatsApp messages.

## Features

- 📱 **WhatsApp Integration**: Full WhatsApp chatbot interface using whatsapp-web.js (Free)
- 📅 **Google Calendar Sync**: Real-time synchronization with doctor's Google Calendar
- 🔄 **Appointment Management**: Schedule, reschedule, and cancel appointments
- ⚡ **Conflict Detection**: Automatic conflict resolution and prevention
- 🔄 **Auto Sync**: Periodic synchronization between database and Google Calendar
- 🔄 **Database Repopulation**: Restore database from Google Calendar when purged
- 🚫 **Slot Unavailability**: Booked slots automatically become unavailable to patients
- 📊 **Comprehensive Logging**: Detailed logging for debugging and monitoring
- 💾 **Database Storage**: SQLite database for appointment and patient data
- 🔒 **Secure**: Environment-based configuration and secure API handling
- 🛡️ **Error Handling**: Robust error handling and recovery mechanisms
- 🧪 **Integration Testing**: Built-in test suite for calendar sync verification

## Prerequisites

- Node.js (v14 or higher)
- WhatsApp account (personal WhatsApp)
- Google Cloud project with Calendar API enabled
- No additional API keys or costs required for WhatsApp

## Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd whatsapp-appointment-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp env.example .env
   ```

4. **WhatsApp Authentication Setup**
   ```bash
   npm run setup
   ```
   This will generate a QR code that you need to scan with your WhatsApp mobile app.

   Edit the `.env` file with your configuration:

   ```env
   # WhatsApp Configuration (Free - whatsapp-web.js)
   # No configuration needed - authentication via QR code

   # Google Calendar Configuration
   GOOGLE_CLIENT_ID=your_google_client_id
   GOOGLE_CLIENT_SECRET=your_google_client_secret
   GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
   GOOGLE_CALENDAR_ID=your_calendar_id@group.calendar.google.com
   GOOGLE_ACCESS_TOKEN=your_google_access_token
   GOOGLE_REFRESH_TOKEN=your_google_refresh_token

   # Database Configuration
   DATABASE_PATH=./database/appointments.db

   # Server Configuration
   PORT=3000
   NODE_ENV=development

   # Application Settings
   DOCTOR_NAME=Dr. Smith
   WORKING_HOURS_START=09:00
   WORKING_HOURS_END=17:00
   APPOINTMENT_DURATION_MINUTES=30
   MAX_ADVANCE_BOOKING_DAYS=30
   ```

## Setup Instructions

### 1. WhatsApp Setup (Free - whatsapp-web.js)

1. **No account creation needed** - uses your existing WhatsApp account
2. **No API keys required** - completely free solution
3. **QR Code Authentication**:
   - When you start the server, a QR code will appear in the terminal
   - Open WhatsApp on your phone
   - Go to Settings > Linked Devices
   - Tap "Link a Device"
   - Scan the QR code displayed in the terminal
4. **You're ready to go!** - no webhook configuration needed

### 2. Google Calendar Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable the Google Calendar API
4. Create OAuth 2.0 credentials
5. Set up the OAuth consent screen
6. Configure the redirect URI in your Google Cloud Console
7. Generate access and refresh tokens

### 3. Database Setup

The application automatically creates the SQLite database and tables when you start the server. No manual setup required.

## Usage

### Starting the Application

First, make sure you've completed the WhatsApp setup:

```bash
# Run WhatsApp authentication setup (first time only)
npm run setup
```

Then start the application:

```bash
# Development mode with auto-restart
npm run dev

# Production mode
npm start
```

**Note**: Keep your phone connected to maintain the WhatsApp Web session.

The server will start on port 3000 by default.

### Patient Interaction Flow

1. **Main Menu**: Patients receive a welcome message with options:
   - Schedule New Appointment
   - Reschedule Existing Appointment
   - Cancel Appointment
   - View My Appointments

2. **Scheduling Flow**:
   - Select available date
   - Choose time slot
   - Confirm appointment
   - Receive confirmation

3. **Rescheduling/Cancellation**:
   - View existing appointments
   - Select appointment to modify
   - Choose new date/time (for rescheduling)
   - Confirm changes

### Google Calendar Integration

The application automatically synchronizes with Google Calendar to ensure data consistency and prevent double-bookings.

#### Automatic Synchronization
- **On Startup**: The app performs a full sync when started
- **During Booking**: New appointments are immediately synced to Google Calendar
- **During Cancellation/Rescheduling**: Calendar events are updated accordingly
- **Real-time Sync**: Every time a user wants to schedule/reschedule, the system syncs with Google Calendar to show the latest available slots

#### Manual Repopulation (Database Recovery)

If your database is accidentally purged or corrupted, you can restore all appointments from Google Calendar:

```bash
# Restore database from Google Calendar
npm run repopulate
```

This command will:
- Pull all appointment events from your Google Calendar
- Convert them to database records
- Skip duplicates to avoid conflicts
- Provide a detailed summary of the restoration process

#### Testing Integration

Test the Google Calendar integration and booking flow:

```bash
# Run comprehensive integration tests
npm run test

# Alternative command
npm run test:calendar
```

The test suite verifies:
- ✅ Google Calendar authentication
- ✅ Slot availability checking
- ✅ Appointment booking and sync
- ✅ Automatic unavailability after booking
- ✅ Database repopulation capability
- ✅ Real-time sync during scheduling flow

### API Endpoints

- `GET /health` - Health check endpoint
- `POST /sync` - Manual calendar synchronization
- `GET /auth/google/callback` - Google OAuth callback (future use)

**Note**: WhatsApp messages are handled directly through whatsapp-web.js client, not via webhooks.

## Important Notes

### WhatsApp Web (whatsapp-web.js) Requirements:
- **Phone with WhatsApp**: You need a phone number with WhatsApp installed
- **Active WhatsApp session**: The WhatsApp Web session needs to stay active
- **QR Code scanning**: Initial setup requires scanning QR code on your phone
- **Internet connection**: Both the server and your phone need stable internet
- **Phone proximity**: Phone should be online and connected to scan QR code initially

### Limitations:
- Cannot send messages to yourself (business limitation)
- Requires phone to be online for the Web session to work
- WhatsApp may occasionally require re-authentication
- Not suitable for 24/7 server environments without active phone monitoring

### Advantages:
- **Completely FREE** - no API costs, no monthly fees
- **No API keys** - no complex authentication setup
- **Easy setup** - just scan QR code once
- **Full WhatsApp features** - supports text, emojis, formatting

## Synchronization

The application includes automatic synchronization features:

- **Periodic Sync**: Runs every 30 minutes to sync database with Google Calendar
- **Manual Sync**: POST to `/sync` endpoint to trigger immediate synchronization
- **Conflict Resolution**: Automatically detects and resolves discrepancies
- **Data Validation**: Validates appointment data integrity
- **Cleanup**: Removes old conversation states and archived appointments

## Logging

Comprehensive logging is implemented throughout the application:

- **File Logging**: Daily log files stored in `logs/` directory
- **Console Logging**: Real-time logging to console
- **Structured Logs**: JSON-formatted logs with context information
- **Log Levels**: ERROR, WARN, INFO, DEBUG (configurable via LOG_LEVEL env var)

Log files are automatically created daily and include:
- Incoming/outgoing WhatsApp messages
- Appointment creation, updates, and cancellations
- Calendar sync operations
- Error details with stack traces
- State transitions

## Project Structure

```
whatsapp-appointment-bot/
├── src/
│   ├── server.js              # Main Express server
│   ├── appointmentBot.js      # Core bot logic and conversation handling
│   ├── whatsappService.js     # WhatsApp Web (whatsapp-web.js) integration
│   └── googleCalendar.js      # Google Calendar API integration
├── database/
│   ├── init.js               # Database initialization and connection
│   └── schema.sql            # Database schema
├── config/                   # Configuration files (future use)
├── utils/                    # Utility functions (future use)
├── .env                      # Environment variables
├── package.json
└── README.md
```

## Database Schema

### Appointments Table
- `id` - Primary key
- `patient_phone` - Patient's WhatsApp number
- `patient_name` - Patient's name (optional)
- `appointment_date` - Date of appointment (YYYY-MM-DD)
- `appointment_time` - Time of appointment (HH:MM)
- `duration_minutes` - Appointment duration
- `status` - Appointment status (scheduled, cancelled, completed)
- `google_event_id` - Google Calendar event ID
- `created_at` / `updated_at` - Timestamps

### Patients Table
- `id` - Primary key
- `phone` - Patient's phone number
- `name` - Patient's name
- `email` - Patient's email (optional)
- `created_at` / `updated_at` - Timestamps

### Conversation States Table
- `id` - Primary key
- `phone` - Patient's phone number
- `state` - Current conversation state
- `context` - JSON context data
- `created_at` / `updated_at` - Timestamps

## Configuration Options

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `NODE_ENV` | Environment mode | development |
| `DATABASE_PATH` | SQLite database path | ./database/appointments.db |
| `TWILIO_ACCOUNT_SID` | Twilio account SID | - |
| `TWILIO_AUTH_TOKEN` | Twilio auth token | - |
| `TWILIO_WHATSAPP_NUMBER` | WhatsApp number from Twilio | - |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | - |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | - |
| `GOOGLE_CALENDAR_ID` | Google Calendar ID | - |
| `WORKING_HOURS_START` | Doctor's working hours start | 09:00 |
| `WORKING_HOURS_END` | Doctor's working hours end | 17:00 |
| `APPOINTMENT_DURATION_MINUTES` | Default appointment duration | 30 |
| `MAX_ADVANCE_BOOKING_DAYS` | Maximum days for advance booking | 30 |

## Security Considerations

- Store sensitive credentials in environment variables
- Use HTTPS in production
- Validate all incoming webhook requests
- Implement rate limiting for API endpoints
- Regularly rotate API keys and tokens

## Troubleshooting

### Common Issues

1. **Twilio webhook not receiving messages**
   - Check webhook URL is correctly configured
   - Ensure server is publicly accessible
   - Verify Twilio credentials

2. **Google Calendar authentication errors**
   - Check OAuth credentials are correct
   - Verify Calendar API is enabled
   - Ensure proper scopes are granted

3. **Database connection issues**
   - Check database file permissions
   - Verify database path in environment variables
   - Ensure SQLite is properly installed

### Logs

Check console logs for detailed error messages and debugging information.

## Future Enhancements

- [ ] Email notifications for appointments
- [ ] Patient registration and profile management
- [ ] Multi-doctor support
- [ ] Appointment reminders via WhatsApp
- [ ] Integration with EHR systems
- [ ] Analytics dashboard
- [ ] Voice call integration
- [ ] Multi-language support

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the ISC License - see the LICENSE file for details.

## Database Maintenance

For database management and purging operations, see the comprehensive guide:

📖 **[Database Maintenance Guide](DATABASE_MAINTENANCE.md)**

This guide covers:
- Various database purge options
- Backup and recovery procedures
- Database health monitoring
- Production maintenance best practices

## Support

For support and questions:
- Create an issue in the repository
- Check the troubleshooting section
- Review the database maintenance guide
- Review the Twilio and Google Calendar API documentation
