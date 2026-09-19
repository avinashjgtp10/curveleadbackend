-- Platform-wide Super Admin settings — a single-row config table.
-- Run in pgAdmin / via psql on the curvelead database:
--   psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f models/migration_platform_settings.sql

CREATE TABLE IF NOT EXISTS platform_settings (
    id INT PRIMARY KEY DEFAULT 1,
    platform_name VARCHAR(120) NOT NULL DEFAULT 'CurveLead',
    support_email VARCHAR(200),
    default_trial_days INT NOT NULL DEFAULT 14,
    signup_enabled BOOLEAN NOT NULL DEFAULT true,
    maintenance_mode BOOLEAN NOT NULL DEFAULT false,
    maintenance_message TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT platform_settings_singleton CHECK (id = 1)
);

INSERT INTO platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
