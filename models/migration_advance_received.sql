-- Add advance_received column to leads table
-- Tracks the advance amount collected once a lead is marked Won.
-- Run in pgAdmin on your RDS database

ALTER TABLE leads ADD COLUMN IF NOT EXISTS advance_received DECIMAL(12,2) DEFAULT 0;
