-- Add Business Name and Address fields to leads, captured on lead creation.
-- Run in pgAdmin on your RDS database

ALTER TABLE leads ADD COLUMN IF NOT EXISTS business_name VARCHAR(200);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS address TEXT;
