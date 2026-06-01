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
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_id VARCHAR(50),
    incident_id VARCHAR(50),
    action_type VARCHAR(50),
    parameters_hash TEXT,
    policy_decision VARCHAR(30),
    actor VARCHAR(50),
    pre_change_kpi_ref TEXT,
    executed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS change_records (
    change_id VARCHAR(20) PRIMARY KEY,
    incident_id VARCHAR(20) NOT NULL,
    action_type VARCHAR(50) NOT NULL,
    parameters JSONB NOT NULL,
    pre_change_kpis JSONB NOT NULL,
    status VARCHAR(20) DEFAULT 'applied',
    sim_time_s FLOAT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
