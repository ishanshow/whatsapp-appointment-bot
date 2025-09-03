# Database Maintenance Guide

## Overview

This guide covers various methods to purge/clean the WhatsApp Appointment Bot database. The bot uses SQLite as its database backend with three main tables:

- **appointments**: Stores appointment data
- **patients**: Stores patient information
- **conversation_states**: Stores WhatsApp conversation states

## Database Purge Options

### Automated Script (Recommended)

Use the provided `purge-database.js` script for safe database operations:

```bash
# Clear all appointments only (keeps patients)
node purge-database.js clear-appointments

# Clear all patients and their appointments
node purge-database.js clear-patients

# Clear conversation states only
node purge-database.js clear-conversations

# Clear all data but keep table structure
node purge-database.js clear-all

# Drop and recreate all tables (fresh start)
node purge-database.js drop-recreate

# Completely delete database file
node purge-database.js delete-file
```

### Manual SQLite Commands

For direct database access using SQLite CLI:

```bash
# Connect to database
sqlite3 database/appointments.db

# Clear appointments only
DELETE FROM appointments;

# Clear all patients and related data
DELETE FROM appointments;
DELETE FROM patients;
DELETE FROM conversation_states;

# Reset auto-increment counters
DELETE FROM sqlite_sequence;

# Exit SQLite
.quit
```

### Manual File Deletion

```bash
# Delete the entire database file
rm database/appointments.db

# Note: Database will be recreated automatically on next server start
```

## When to Use Each Option

| Option | Use Case | What It Does | Data Loss |
|--------|----------|--------------|-----------|
| `clear-appointments` | Reset schedule | Removes all appointments, keeps patient records | Appointments only |
| `clear-patients` | Fresh patient list | Removes all patients and their appointments | All patient data |
| `clear-conversations` | Fix stuck chats | Clears conversation states, keeps data | Chat states only |
| `clear-all` | Development testing | Clears all data but preserves table structure | All data |
| `drop-recreate` | Schema changes | Completely rebuilds database with new schema | All data + structure |
| `delete-file` | Nuclear option | Complete fresh start, deletes database file | Everything |

## Database Schema

### Appointments Table
```sql
CREATE TABLE appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_phone TEXT NOT NULL,
    patient_name TEXT,
    appointment_date TEXT NOT NULL,
    appointment_time TEXT NOT NULL,
    duration_minutes INTEGER DEFAULT 30,
    status TEXT DEFAULT 'scheduled',
    google_event_id TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
);
```

### Patients Table
```sql
CREATE TABLE patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    name TEXT,
    email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Conversation States Table
```sql
CREATE TABLE conversation_states (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    state TEXT NOT NULL,
    context TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(phone)
);
```

## Best Practices

### Before Purging
1. **Always backup** your database before any purge operation
2. **Check Google Calendar** - purging local data won't delete Google Calendar events
3. **Inform stakeholders** if purging production data

### Backup Commands
```bash
# Create backup
cp database/appointments.db database/backup_$(date +%Y%m%d_%H%M%S).db

# List backups
ls -la database/backup_*.db
```

### Safe Purge Workflow
```bash
# 1. Create backup
cp database/appointments.db database/backup_before_purge.db

# 2. Stop the server
# (stop your Node.js server process)

# 3. Purge database
node purge-database.js clear-all

# 4. Restart server
npm start

# 5. Verify everything works
# Test appointment booking flow
```

## Recovery Options

### Restore from Backup
```bash
# Stop server first
cp database/backup_filename.db database/appointments.db
# Restart server
```

### Partial Data Recovery
If you need to recover specific data:

```sql
-- Recover patients from backup
ATTACH DATABASE 'database/backup.db' AS backup;
INSERT OR IGNORE INTO patients SELECT * FROM backup.patients;
DETACH DATABASE backup;
```

## Monitoring Database Health

### Check Database Statistics
```bash
# Connect to database
sqlite3 database/appointments.db

# Check table sizes
SELECT 'appointments' as table_name, COUNT(*) as count FROM appointments
UNION ALL
SELECT 'patients', COUNT(*) FROM patients
UNION ALL
SELECT 'conversations', COUNT(*) FROM conversation_states;

# Check database file size
.quit
ls -lh database/appointments.db
```

### Database Maintenance
```sql
-- Vacuum database to reduce file size
VACUUM;

-- Rebuild indexes
REINDEX;

-- Check for corruption
PRAGMA integrity_check;
```

## Troubleshooting

### Common Issues

**Database locked error:**
- Stop the server before purging
- Close all SQLite connections
- Check for running processes

**Permission denied:**
- Ensure proper file permissions
- Run with appropriate user privileges

**Foreign key constraints:**
- Some purge options handle this automatically
- Use `clear-all` or `drop-recreate` for complex relationships

### Recovery from Corruption
```bash
# If database is corrupted
rm database/appointments.db
# Restart server to recreate fresh database
npm start
```

## Production Considerations

### Automated Backups
Set up automated backups in production:

```bash
# Add to crontab for daily backups
0 2 * * * cp /path/to/appointments.db /path/to/backups/appointments_$(date +\%Y\%m\%d).db
```

### Monitoring
Monitor database growth and set up alerts:

```bash
# Check database size daily
du -h database/appointments.db

# Alert if database grows too large
if [ $(stat -f%z database/appointments.db) -gt 1000000000 ]; then
    echo "Database larger than 1GB, consider cleanup"
fi
```

## Support

For issues with database purging:
1. Check server logs for error messages
2. Verify file permissions
3. Ensure server is stopped before file operations
4. Test with development environment first

---

**Last Updated:** $(date)
**Database Version:** SQLite
**Bot Version:** WhatsApp Appointment Bot v1.0.0
