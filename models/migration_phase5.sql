-- ============================================
-- Phase 5 Migration - Run in pgAdmin
-- ============================================

-- Staff Time Tracking
CREATE TABLE IF NOT EXISTS staff_time_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff_profiles(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    check_in TIME,
    check_out TIME,
    late_by_minutes INT DEFAULT 0,
    auto_status VARCHAR(15),              -- present, half_day, absent (auto-calculated)
    final_status VARCHAR(15),             -- admin can override
    notes TEXT,
    marked_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(staff_id, date)
);

CREATE INDEX IF NOT EXISTS idx_staff_time_logs ON staff_time_logs(tenant_id, staff_id, date);

-- Staff Incentives
CREATE TABLE IF NOT EXISTS staff_incentives (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff_profiles(id) ON DELETE CASCADE,
    month INT NOT NULL,
    year INT NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    reason TEXT NOT NULL,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_staff_incentives ON staff_incentives(tenant_id, staff_id, month, year);

-- Add shift_start_time and grace_period to staff_profiles
ALTER TABLE staff_profiles ADD COLUMN IF NOT EXISTS shift_start_time TIME DEFAULT '10:00:00';

-- Add academy settings to tenants table
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS grace_period_minutes INT DEFAULT 15;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS financial_year_start INT DEFAULT 4; -- April
