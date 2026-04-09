-- ============================================
-- CurveLead - Complete Database Schema
-- Multi-tenant SaaS for Academy Management
-- ============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- 1. TENANT & AUTH TABLES
-- ============================================

-- Subscription Plans
CREATE TABLE plans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(50) NOT NULL,              -- Basic, Pro, Premium
    price DECIMAL(10,2) NOT NULL,           -- Monthly price in INR
    max_leads INT DEFAULT 100,
    max_students INT DEFAULT 50,
    max_staff INT DEFAULT 2,
    max_courses INT DEFAULT 5,
    has_expense_tracking BOOLEAN DEFAULT FALSE,
    has_salary_management BOOLEAN DEFAULT FALSE,
    has_fee_reminders BOOLEAN DEFAULT FALSE,
    has_advanced_reports BOOLEAN DEFAULT FALSE,
    has_meta_ads BOOLEAN DEFAULT FALSE,
    has_pdf_receipts BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default plans
INSERT INTO plans (name, price, max_leads, max_students, max_staff, max_courses, has_expense_tracking, has_salary_management, has_fee_reminders, has_advanced_reports, has_meta_ads, has_pdf_receipts) VALUES
('Basic', 500.00, 100, 50, 2, 5, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE),
('Pro', 1000.00, 500, 200, 5, 15, TRUE, FALSE, TRUE, TRUE, FALSE, TRUE),
('Premium', 2000.00, -1, -1, 15, -1, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE);
-- -1 means unlimited

-- Tenants (Academies)
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,             -- Academy name
    slug VARCHAR(100) UNIQUE NOT NULL,      -- URL-friendly name
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    academy_type VARCHAR(50),               -- Beauty, IT, Coaching, Vocational, Other
    logo_url VARCHAR(500),
    plan_id UUID REFERENCES plans(id),
    subscription_status VARCHAR(20) DEFAULT 'trial', -- trial, active, past_due, cancelled, suspended
    trial_ends_at TIMESTAMP,
    razorpay_subscription_id VARCHAR(255),
    razorpay_customer_id VARCHAR(255),
    meta_page_access_token TEXT,
    meta_app_id VARCHAR(255),
    meta_webhook_verify_token VARCHAR(255),
    lead_auto_assign BOOLEAN DEFAULT TRUE,
    lead_auto_assign_type VARCHAR(20) DEFAULT 'round_robin', -- round_robin, default
    default_assignee_id UUID,
    auto_followup_minutes INT DEFAULT 60,   -- Auto follow-up delay for Meta leads
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Users (Academy Admins & Staff)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'staff', -- super_admin, admin, staff
    is_active BOOLEAN DEFAULT TRUE,
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(email, tenant_id)
);

-- ============================================
-- 2. LEAD MANAGEMENT TABLES
-- ============================================

-- Leads
CREATE TABLE leads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(255),
    location VARCHAR(255),
    source VARCHAR(50) NOT NULL,            -- meta_lead_form, meta_whatsapp, walkin, phone, referral, other
    source_detail VARCHAR(255),             -- Campaign name, referral name, etc.
    course_interest_id UUID,                -- FK to courses
    stage VARCHAR(20) DEFAULT 'new',        -- new, contacted, interested, enrolled, dropped
    assigned_to UUID REFERENCES users(id),
    meta_lead_id VARCHAR(255),              -- Meta's lead ID
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_leads_tenant ON leads(tenant_id);
CREATE INDEX idx_leads_stage ON leads(tenant_id, stage);
CREATE INDEX idx_leads_assigned ON leads(tenant_id, assigned_to);

-- Lead Follow-ups
CREATE TABLE lead_followups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
    notes TEXT NOT NULL,
    followup_type VARCHAR(20),              -- call, whatsapp, visit, other
    outcome VARCHAR(50),                    -- not_picked, interested, callback, visited, not_interested
    next_followup_at TIMESTAMP,
    whatsapp_log TEXT,                      -- What was sent/received on WhatsApp
    is_completed BOOLEAN DEFAULT FALSE,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_followups_lead ON lead_followups(lead_id);
CREATE INDEX idx_followups_next ON lead_followups(tenant_id, next_followup_at);

-- ============================================
-- 3. COURSE & BATCH TABLES
-- ============================================

-- Courses
CREATE TABLE courses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    duration_value INT,                     -- Number
    duration_unit VARCHAR(10) DEFAULT 'months', -- days, months
    fee_amount DECIMAL(10,2) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_courses_tenant ON courses(tenant_id);

-- Add FK for leads.course_interest_id
ALTER TABLE leads ADD CONSTRAINT fk_leads_course FOREIGN KEY (course_interest_id) REFERENCES courses(id);

-- Batches
CREATE TABLE batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    trainer_name VARCHAR(255),
    start_date DATE,
    end_date DATE,
    capacity INT DEFAULT 20,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_batches_tenant ON batches(tenant_id);

-- ============================================
-- 4. STUDENT MANAGEMENT TABLES
-- ============================================

-- Students (created when lead → enrolled)
CREATE TABLE students (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES leads(id),      -- Link back to original lead
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(255),
    address TEXT,
    photo_url VARCHAR(500),
    course_id UUID REFERENCES courses(id),
    batch_id UUID REFERENCES batches(id),
    enrollment_date DATE DEFAULT CURRENT_DATE,
    expected_completion DATE,
    certificate_status VARCHAR(20) DEFAULT 'not_issued', -- not_issued, issued, sent
    certificate_issued_date DATE,
    status VARCHAR(20) DEFAULT 'active',    -- active, completed, dropped
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_students_tenant ON students(tenant_id);
CREATE INDEX idx_students_batch ON students(tenant_id, batch_id);

-- Attendance
CREATE TABLE attendance (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    student_id UUID REFERENCES students(id) ON DELETE CASCADE,
    batch_id UUID REFERENCES batches(id),
    date DATE NOT NULL,
    status VARCHAR(10) NOT NULL,            -- present, absent, late
    marked_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, date)
);

CREATE INDEX idx_attendance_date ON attendance(tenant_id, date);
CREATE INDEX idx_attendance_student ON attendance(student_id, date);

-- ============================================
-- 5. FEE & REVENUE TABLES
-- ============================================

-- Fee Structure per student
CREATE TABLE student_fees (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    student_id UUID REFERENCES students(id) ON DELETE CASCADE,
    total_fee DECIMAL(10,2) NOT NULL,
    discount DECIMAL(10,2) DEFAULT 0,
    net_fee DECIMAL(10,2) NOT NULL,         -- total_fee - discount
    payment_type VARCHAR(20) NOT NULL,      -- full, installment
    total_installments INT DEFAULT 1,
    amount_paid DECIMAL(10,2) DEFAULT 0,
    balance DECIMAL(10,2),                  -- net_fee - amount_paid
    status VARCHAR(20) DEFAULT 'pending',   -- pending, partial, paid, overdue
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_student_fees_tenant ON student_fees(tenant_id);

-- Installment Schedule
CREATE TABLE fee_installments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    student_fee_id UUID REFERENCES student_fees(id) ON DELETE CASCADE,
    installment_number INT NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    due_date DATE NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',   -- pending, paid, overdue
    paid_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_installments_due ON fee_installments(tenant_id, due_date, status);

-- Payments
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    student_id UUID REFERENCES students(id) ON DELETE CASCADE,
    student_fee_id UUID REFERENCES student_fees(id),
    installment_id UUID REFERENCES fee_installments(id),
    amount DECIMAL(10,2) NOT NULL,
    payment_date DATE NOT NULL,
    payment_mode VARCHAR(20) NOT NULL,      -- cash, upi, bank_transfer
    receipt_number VARCHAR(50),
    notes TEXT,
    received_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_payments_tenant ON payments(tenant_id);
CREATE INDEX idx_payments_student ON payments(student_id);

-- Fee Reminders
CREATE TABLE fee_reminders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    student_id UUID REFERENCES students(id) ON DELETE CASCADE,
    student_fee_id UUID REFERENCES student_fees(id),
    installment_id UUID REFERENCES fee_installments(id),
    reminder_type VARCHAR(20) NOT NULL,     -- auto, manual
    status VARCHAR(20) DEFAULT 'pending',   -- pending, called, paid, promised
    promised_date DATE,
    actioned_by UUID REFERENCES users(id),
    actioned_at TIMESTAMP,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_reminders_tenant ON fee_reminders(tenant_id, status);

-- ============================================
-- 6. EXPENSE MANAGEMENT TABLES
-- ============================================

-- Expense Categories
CREATE TABLE expense_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,             -- Rent, Utilities, Products, Marketing, Misc
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Expenses
CREATE TABLE expenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    category_id UUID REFERENCES expense_categories(id),
    description TEXT,
    amount DECIMAL(10,2) NOT NULL,
    expense_date DATE NOT NULL,
    payment_mode VARCHAR(20),               -- cash, upi, bank_transfer
    receipt_url VARCHAR(500),               -- Uploaded receipt/bill
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_expenses_tenant ON expenses(tenant_id);
CREATE INDEX idx_expenses_date ON expenses(tenant_id, expense_date);

-- ============================================
-- 7. SALARY MANAGEMENT TABLES
-- ============================================

-- Staff Members (extends users for salary tracking)
CREATE TABLE staff_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),      -- Optional link to user account
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    role VARCHAR(100),                      -- Trainer, Receptionist, etc.
    join_date DATE,
    base_salary DECIMAL(10,2) NOT NULL,
    deduction_per_day DECIMAL(10,2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',    -- active, inactive
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_staff_tenant ON staff_profiles(tenant_id);

-- Staff Attendance
CREATE TABLE staff_attendance (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff_profiles(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    status VARCHAR(10) NOT NULL,            -- present, absent, half_day, leave
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(staff_id, date)
);

CREATE INDEX idx_staff_attendance_date ON staff_attendance(tenant_id, date);

-- Salary Records
CREATE TABLE salary_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff_profiles(id) ON DELETE CASCADE,
    month INT NOT NULL,                     -- 1-12
    year INT NOT NULL,
    working_days INT NOT NULL,
    days_present INT NOT NULL,
    days_absent INT NOT NULL,
    base_salary DECIMAL(10,2) NOT NULL,
    deductions DECIMAL(10,2) DEFAULT 0,
    bonus DECIMAL(10,2) DEFAULT 0,
    net_salary DECIMAL(10,2) NOT NULL,
    payment_status VARCHAR(20) DEFAULT 'pending', -- pending, paid
    payment_date DATE,
    payment_mode VARCHAR(20),
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(staff_id, month, year)
);

CREATE INDEX idx_salary_tenant ON salary_records(tenant_id);

-- ============================================
-- 8. SUBSCRIPTION & BILLING TABLES
-- ============================================

-- Subscription History
CREATE TABLE subscription_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    plan_id UUID REFERENCES plans(id),
    action VARCHAR(20) NOT NULL,            -- created, upgraded, downgraded, renewed, cancelled
    razorpay_payment_id VARCHAR(255),
    amount DECIMAL(10,2),
    status VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Invoices
CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    plan_id UUID REFERENCES plans(id),
    invoice_number VARCHAR(50) UNIQUE,
    amount DECIMAL(10,2) NOT NULL,
    tax DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(10,2) NOT NULL,
    razorpay_payment_id VARCHAR(255),
    status VARCHAR(20) DEFAULT 'pending',   -- pending, paid, failed
    paid_at TIMESTAMP,
    period_start DATE,
    period_end DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 9. NOTIFICATIONS TABLE
-- ============================================

CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    message TEXT,
    type VARCHAR(30),                       -- lead_new, followup_due, fee_due, fee_overdue, system
    reference_type VARCHAR(30),             -- lead, student, payment, etc.
    reference_id UUID,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notifications_user ON notifications(user_id, is_read);

-- ============================================
-- 10. LEAD ACTIVITIES / JOURNEY TIMELINE
-- ============================================

CREATE TABLE lead_activities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
    activity_type VARCHAR(30) NOT NULL,     -- call, whatsapp_sent, whatsapp_received, sms, visit, note, stage_change, followup_scheduled
    title VARCHAR(255) NOT NULL,            -- Short title: "Called - Not Picked", "WhatsApp Sent"
    description TEXT,                       -- Detailed notes
    old_value VARCHAR(50),                  -- For stage changes: old stage
    new_value VARCHAR(50),                  -- For stage changes: new stage
    call_duration VARCHAR(20),              -- e.g., "2 min 30 sec"
    call_outcome VARCHAR(30),              -- connected, not_picked, busy, switched_off, wrong_number
    whatsapp_message TEXT,                  -- Message sent/received
    next_action VARCHAR(255),               -- What to do next
    next_action_date TIMESTAMP,             -- When to do it
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_lead_activities_lead ON lead_activities(lead_id, created_at DESC);
CREATE INDEX idx_lead_activities_tenant ON lead_activities(tenant_id);

-- ============================================
-- HELPER FUNCTION: Auto-update updated_at
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply triggers
CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_leads_updated BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_courses_updated BEFORE UPDATE ON courses FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_batches_updated BEFORE UPDATE ON batches FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_students_updated BEFORE UPDATE ON students FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_student_fees_updated BEFORE UPDATE ON student_fees FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_expenses_updated BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_staff_updated BEFORE UPDATE ON staff_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
