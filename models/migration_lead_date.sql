-- Add lead_date column to leads table
-- Run in pgAdmin on your RDS database

ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_date TIMESTAMP DEFAULT NOW();

-- Backfill existing leads with their created_at date
UPDATE leads SET lead_date = created_at WHERE lead_date IS NULL;
