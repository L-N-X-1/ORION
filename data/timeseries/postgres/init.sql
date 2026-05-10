-- AURA-NET PostgreSQL init
-- Stores: incident records, audit log, change records

CREATE TABLE IF NOT EXISTS incidents (
    id UUID PRIMARY KEY,
    severity VARCHAR(10),
    incident_type VARCHAR(50),
    affected_entities JSONB,
    evidence JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY,
    change_id VARCHAR(50),
    actor VARCHAR(50),
    action JSONB,
    policy_decision VARCHAR(30),
    pre_change_snapshot JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS change_records (
    change_id VARCHAR(50) PRIMARY KEY,
    parameters JSONB,
    blast_radius INT,
    status VARCHAR(20),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
