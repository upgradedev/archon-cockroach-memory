-- ═════════════════════════════════════════════════════════════════════════════
-- Archon Memory — CockroachDB schema
--
-- Ported from the Archon Nebius Managed PostgreSQL schema (Postgres-wire compat)
-- and extended with the piece that makes this a hackathon entry: a distributed
-- VECTOR memory index so the agents can RECALL prior financial facts by meaning,
-- not just by key.
--
-- Vector indexing requires CockroachDB v25.2+. VECTOR(1024) matches AWS Bedrock
-- Titan Text Embeddings V2 output dimensionality — keep the two in lockstep.
-- ═════════════════════════════════════════════════════════════════════════════

-- Vector indexes are gated behind a cluster setting; sql_safe_updates must be
-- relaxed to add an index to a table that may already hold rows.
SET CLUSTER SETTING feature.vector_index.enabled = true;
SET CLUSTER SETTING sql.auth.skip_underlying_view_privilege_checks.enabled = false;
SET CLUSTER SETTING sql.ttl.job.enabled = true;
SET sql_safe_updates = false;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Document registry  (ported 1:1 from Nebius schema)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS documents (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    upload_id        TEXT NOT NULL,
    period           TEXT NOT NULL,          -- YYYY-MM
    source_file      TEXT NOT NULL,
    doc_type         TEXT NOT NULL,          -- payroll_register | bank_confirmation | payslip | sales_invoice | purchase_invoice | unknown
    detected_lang    TEXT,
    issue_date       DATE,
    vendor_name      TEXT,
    vendor_tax_id    TEXT,                   -- vendor tax ID
    recipient_name   TEXT,
    currency         CHAR(3) DEFAULT 'EUR',
    subtotal         DECIMAL(14,2),
    vat_amount       DECIMAL(14,2),
    vat_rate_pct     DECIMAL(5,2),
    total_amount     DECIMAL(14,2) NOT NULL,
    invoice_number   TEXT,
    confidence       DECIMAL(4,3),
    extraction_model TEXT,
    created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_period ON documents (period);
CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents (doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_upload_id ON documents (upload_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Employee master + per-period payroll line  (ported 1:1)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS employees (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_code TEXT UNIQUE,
    full_name     TEXT,
    tax_id        TEXT,
    bank_account  TEXT,
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employee_payroll (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id   UUID REFERENCES employees(id) ON DELETE CASCADE,
    period        TEXT NOT NULL,
    gross_pay     DECIMAL(12,2),
    net_pay       DECIMAL(12,2) NOT NULL,
    employer_cost DECIMAL(12,2),
    social_security_employee  DECIMAL(12,2),
    social_security_employer  DECIMAL(12,2),
    income_tax    DECIMAL(12,2),
    document_id   UUID REFERENCES documents(id),
    created_at    TIMESTAMPTZ DEFAULT now(),
    UNIQUE (employee_id, period)
);

CREATE INDEX IF NOT EXISTS idx_employee_payroll_period ON employee_payroll (period);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Payroll events — the fused financial event  (ported 1:1)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payroll_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period              TEXT NOT NULL,
    company_name        TEXT,
    bank_doc_id         UUID REFERENCES documents(id),
    register_doc_id     UUID REFERENCES documents(id),
    net_total           DECIMAL(12,2),
    gross_total         DECIMAL(12,2),
    employer_cost_total DECIMAL(12,2),
    employee_count      INT,
    is_complete         BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT now(),
    UNIQUE (period, company_name)
);

CREATE TABLE IF NOT EXISTS payroll_event_payslips (
    payroll_event_id UUID REFERENCES payroll_events(id) ON DELETE CASCADE,
    document_id      UUID REFERENCES documents(id) ON DELETE CASCADE,
    PRIMARY KEY (payroll_event_id, document_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Validation results  (ported 1:1)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS validation_results (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period       TEXT NOT NULL,
    upload_id    TEXT,
    rule         TEXT NOT NULL,
    passed       BOOLEAN NOT NULL,
    severity     TEXT NOT NULL,
    message      TEXT,
    source_files TEXT[],
    created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_validation_period ON validation_results (period);
CREATE INDEX IF NOT EXISTS idx_validation_passed ON validation_results (passed);

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. AGENT MEMORY  ← the new layer (CockroachDB Distributed Vector Indexing)
--
-- Every durable fact an agent learns — an extracted document, a fused payroll
-- event, a validation finding, a narrated insight — is written here as a
-- natural-language "memory" plus its embedding. Agents RECALL by semantic
-- similarity (cosine) over the distributed vector index, giving the pipeline a
-- persistent, queryable memory instead of a stateless per-request run.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_memory (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Scope / retrieval filters. tenant_id is server-derived and independently
    -- enforced by CockroachDB RLS below; public callers never choose it.
    tenant_id     TEXT NOT NULL DEFAULT 'public-demo',
    kind          TEXT NOT NULL,            -- document | payroll_event | validation | insight
    company       TEXT NOT NULL DEFAULT '_global',
    period        TEXT,                     -- YYYY-MM, when the memory is period-scoped
    source_ref    TEXT,                     -- id of the originating row (document.id, event.id, …)
    -- The recallable content.
    content       TEXT NOT NULL,            -- natural-language statement of the fact
    metadata      JSONB,                    -- structured payload (amounts, doc_type, …)
    embedding     VECTOR(1024) NOT NULL,    -- Bedrock Titan V2 embedding of `content`
    embed_model   TEXT NOT NULL,
    -- Durable lifecycle / replay fields.
    idempotency_key TEXT,
    content_hash    TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    superseded_by   UUID,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT chk_agent_memory_status
      CHECK (status IN ('active', 'superseded', 'retracted'))
);

-- Forward-only, idempotent migration for clusters created with the original
-- challenge schema. CREATE TABLE IF NOT EXISTS does not add newly introduced
-- columns, so each addition is explicit and safe to re-run.
ALTER TABLE agent_memory
    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'public-demo';
ALTER TABLE agent_memory
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE agent_memory
    ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE agent_memory
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE agent_memory
    ADD COLUMN IF NOT EXISTS superseded_by UUID;
ALTER TABLE agent_memory
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE agent_memory
    ADD CONSTRAINT IF NOT EXISTS chk_agent_memory_status
    CHECK (status IN ('active', 'superseded', 'retracted'));

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. ISOLATED MEMORY RESOLUTION SANDBOX
--
-- The public demo may prove a real action loop without granting any write path
-- to canonical agent_memory. Every session is synthetic, bearer-token scoped in
-- the service, serializable, human-gated, and automatically forgotten by a
-- CockroachDB row-level TTL. Child evidence is retained until the parent expires
-- so an approval never destroys the competing source or its receipt.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS memory_demo_sessions (
    id               UUID PRIMARY KEY,
    token_hash       TEXT NOT NULL UNIQUE,
    scenario_id      TEXT NOT NULL,
    tenant_id        TEXT NOT NULL DEFAULT 'public-demo',
    company          TEXT NOT NULL DEFAULT 'Helios SA',
    period           TEXT NOT NULL DEFAULT '2026-06',
    state            TEXT NOT NULL DEFAULT 'pending',
    decision_version INT8 NOT NULL DEFAULT 0,
    expires_at       TIMESTAMPTZ NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_memory_demo_session_token
      CHECK (length(token_hash) = 64 AND token_hash ~ '^[a-f0-9]+$'),
    CONSTRAINT chk_memory_demo_session_scope
      CHECK (
        scenario_id = 'helios-payroll-2026-06-correction-v1'
        AND tenant_id = 'public-demo'
        AND company = 'Helios SA'
        AND period = '2026-06'
      ),
    CONSTRAINT chk_memory_demo_session_state
      CHECK (
        state IN ('pending', 'approved', 'rejected')
        AND decision_version IN (0, 1)
        AND (
          (state = 'pending' AND decision_version = 0)
          OR (state IN ('approved', 'rejected') AND decision_version = 1)
        )
      )
) WITH (
    ttl_expiration_expression = 'expires_at',
    ttl_job_cron = '0 */4 * * *'
);

CREATE TABLE IF NOT EXISTS memory_resolution_observations (
    id                  UUID PRIMARY KEY,
    session_id          UUID NOT NULL
                          REFERENCES memory_demo_sessions(id)
                          ON DELETE CASCADE,
    ordinal             INT2 NOT NULL,
    label               TEXT NOT NULL,
    source_ref          TEXT NOT NULL,
    source_class        TEXT NOT NULL,
    observed_at         TIMESTAMPTZ NOT NULL,
    authority_rank      INT2 NOT NULL,
    employer_cost_cents INT8 NOT NULL,
    status              TEXT NOT NULL,
    tenant_id           TEXT NOT NULL DEFAULT 'public-demo',
    company             TEXT NOT NULL DEFAULT 'Helios SA',
    expires_at          TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, id),
    UNIQUE (session_id, ordinal),
    UNIQUE (session_id, label),
    CONSTRAINT chk_memory_resolution_observation_scope
      CHECK (tenant_id = 'public-demo' AND company = 'Helios SA'),
    CONSTRAINT chk_memory_resolution_observation_status
      CHECK (status IN ('candidate', 'current', 'superseded', 'rejected')),
    CONSTRAINT chk_memory_resolution_observation_fixture
      CHECK (
        (
          ordinal = 1
          AND label = 'prior'
          AND source_ref = 'payroll-register-2026-06-v1'
          AND source_class = 'payroll-register'
          AND authority_rank = 60
          AND employer_cost_cents = 12440000
        )
        OR
        (
          ordinal = 2
          AND label = 'corrected'
          AND source_ref = 'signed-payroll-register-2026-06-v2'
          AND source_class = 'signed-payroll-register'
          AND authority_rank = 100
          AND employer_cost_cents = 12890000
        )
      )
);

CREATE TABLE IF NOT EXISTS memory_resolution_proposals (
    id                         UUID PRIMARY KEY,
    session_id                 UUID NOT NULL UNIQUE
                                 REFERENCES memory_demo_sessions(id)
                                 ON DELETE CASCADE,
    action                     TEXT NOT NULL,
    status                     TEXT NOT NULL DEFAULT 'pending',
    proposed_observation_id    UUID NOT NULL,
    supersedes_observation_id  UUID NOT NULL,
    rationale                  TEXT NOT NULL,
    required_human_role        TEXT NOT NULL,
    tenant_id                  TEXT NOT NULL DEFAULT 'public-demo',
    company                    TEXT NOT NULL DEFAULT 'Helios SA',
    expires_at                 TIMESTAMPTZ NOT NULL,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, id),
    CONSTRAINT fk_memory_resolution_proposed_observation
      FOREIGN KEY (session_id, proposed_observation_id)
      REFERENCES memory_resolution_observations(session_id, id),
    CONSTRAINT fk_memory_resolution_superseded_observation
      FOREIGN KEY (session_id, supersedes_observation_id)
      REFERENCES memory_resolution_observations(session_id, id),
    CONSTRAINT chk_memory_resolution_proposal_scope
      CHECK (tenant_id = 'public-demo' AND company = 'Helios SA'),
    CONSTRAINT chk_memory_resolution_proposal_contract
      CHECK (
        action = 'resolve-conflicting-memory'
        AND status IN ('pending', 'approved', 'rejected')
        AND required_human_role = 'financial-controller'
      )
);

CREATE TABLE IF NOT EXISTS memory_resolution_decisions (
    id                         UUID PRIMARY KEY,
    session_id                 UUID NOT NULL UNIQUE
                                 REFERENCES memory_demo_sessions(id)
                                 ON DELETE CASCADE,
    proposal_id                UUID NOT NULL UNIQUE,
    idempotency_key            UUID NOT NULL,
    actor_role                 TEXT NOT NULL,
    decision                   TEXT NOT NULL,
    decided_at                 TIMESTAMPTZ NOT NULL,
    policy_version             TEXT NOT NULL,
    current_observation_id     UUID NOT NULL,
    superseded_observation_id  UUID,
    receipt_hash               TEXT NOT NULL,
    tenant_id                  TEXT NOT NULL DEFAULT 'public-demo',
    company                    TEXT NOT NULL DEFAULT 'Helios SA',
    expires_at                 TIMESTAMPTZ NOT NULL,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, id),
    UNIQUE (session_id, idempotency_key),
    CONSTRAINT fk_memory_resolution_decision_proposal
      FOREIGN KEY (session_id, proposal_id)
      REFERENCES memory_resolution_proposals(session_id, id),
    CONSTRAINT fk_memory_resolution_decision_current_observation
      FOREIGN KEY (session_id, current_observation_id)
      REFERENCES memory_resolution_observations(session_id, id),
    CONSTRAINT fk_memory_resolution_decision_superseded_observation
      FOREIGN KEY (session_id, superseded_observation_id)
      REFERENCES memory_resolution_observations(session_id, id),
    CONSTRAINT chk_memory_resolution_decision_scope
      CHECK (tenant_id = 'public-demo' AND company = 'Helios SA'),
    CONSTRAINT chk_memory_resolution_decision_contract
      CHECK (
        actor_role = 'financial-controller'
        AND decision IN ('approve', 'reject')
        AND policy_version = 'resolution-policy-v1'
        AND length(receipt_hash) = 64
        AND receipt_hash ~ '^[a-f0-9]+$'
      )
);

CREATE TABLE IF NOT EXISTS memory_resolution_consolidations (
    id                         UUID PRIMARY KEY,
    session_id                 UUID NOT NULL UNIQUE
                                 REFERENCES memory_demo_sessions(id)
                                 ON DELETE CASCADE,
    decision_id                UUID NOT NULL UNIQUE,
    policy_version             TEXT NOT NULL,
    mode                       TEXT NOT NULL,
    current_observation_id     UUID NOT NULL,
    superseded_observation_id  UUID,
    receipt_hash               TEXT NOT NULL,
    consolidated_at            TIMESTAMPTZ NOT NULL,
    tenant_id                  TEXT NOT NULL DEFAULT 'public-demo',
    company                    TEXT NOT NULL DEFAULT 'Helios SA',
    expires_at                 TIMESTAMPTZ NOT NULL,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_memory_resolution_consolidation_decision
      FOREIGN KEY (session_id, decision_id)
      REFERENCES memory_resolution_decisions(session_id, id),
    CONSTRAINT fk_memory_resolution_consolidation_current_observation
      FOREIGN KEY (session_id, current_observation_id)
      REFERENCES memory_resolution_observations(session_id, id),
    CONSTRAINT fk_memory_resolution_consolidation_superseded_observation
      FOREIGN KEY (session_id, superseded_observation_id)
      REFERENCES memory_resolution_observations(session_id, id),
    CONSTRAINT chk_memory_resolution_consolidation_scope
      CHECK (tenant_id = 'public-demo' AND company = 'Helios SA'),
    CONSTRAINT chk_memory_resolution_consolidation_contract
      CHECK (
        policy_version = 'resolution-policy-v1'
        AND mode IN ('approved-correction', 'retained-prior')
        AND length(receipt_hash) = 64
        AND receipt_hash ~ '^[a-f0-9]+$'
      )
);

CREATE INDEX IF NOT EXISTS idx_memory_demo_sessions_expiry
    ON memory_demo_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_memory_resolution_observations_session
    ON memory_resolution_observations (session_id, ordinal);

-- Defense in depth for the public demo. Install the fail-closed authorization
-- baseline before any optional/performance index migration, so even an
-- unrelated index drift cannot leave a legacy broad policy in effect.
--
-- CockroachDB schema changes do not have full atomicity inside a multi-statement
-- explicit transaction. Each statement below is therefore an implicit
-- transaction and the ordering fails closed:
--   * revoke ambient object-creation and stale table grants first;
--   * install immutable restrictive + permissive v1 policies;
--   * enable/force RLS;
--   * only then remove legacy policies.
-- A retry is safe because the replacement policies use IF NOT EXISTS.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE ROLE IF NOT EXISTS archon_public_reader WITH NOLOGIN;
ALTER ROLE archon_public_reader WITH NOBYPASSRLS;
CREATE ROLE IF NOT EXISTS archon_resolution_writer WITH NOLOGIN;
ALTER ROLE archon_resolution_writer WITH NOBYPASSRLS;
CREATE ROLE IF NOT EXISTS archon_resolution_transition_owner WITH NOLOGIN;
ALTER ROLE archon_resolution_transition_owner WITH NOLOGIN NOBYPASSRLS;
ALTER ROLE archon_resolution_transition_owner SET search_path = pg_catalog;

REVOKE ALL ON TABLE documents FROM archon_public_reader;
REVOKE ALL ON TABLE employees FROM archon_public_reader;
REVOKE ALL ON TABLE employee_payroll FROM archon_public_reader;
REVOKE ALL ON TABLE payroll_events FROM archon_public_reader;
REVOKE ALL ON TABLE payroll_event_payslips FROM archon_public_reader;
REVOKE ALL ON TABLE validation_results FROM archon_public_reader;
REVOKE ALL ON TABLE agent_memory FROM archon_public_reader;
GRANT SELECT ON TABLE agent_memory TO archon_public_reader;

-- The runtime login inherits this capability in addition to the canonical
-- read-only role. It can read only the disposable fixed synthetic graph and
-- execute the two exact transition functions defined below. It never receives
-- direct INSERT, UPDATE, or DELETE on any relation.
REVOKE ALL ON TABLE memory_demo_sessions FROM archon_resolution_writer;
REVOKE ALL ON TABLE memory_resolution_observations FROM archon_resolution_writer;
REVOKE ALL ON TABLE memory_resolution_proposals FROM archon_resolution_writer;
REVOKE ALL ON TABLE memory_resolution_decisions FROM archon_resolution_writer;
REVOKE ALL ON TABLE memory_resolution_consolidations FROM archon_resolution_writer;
GRANT SELECT ON TABLE memory_demo_sessions TO archon_resolution_writer;
GRANT SELECT ON TABLE memory_resolution_observations TO archon_resolution_writer;
GRANT SELECT ON TABLE memory_resolution_proposals TO archon_resolution_writer;
GRANT SELECT ON TABLE memory_resolution_decisions TO archon_resolution_writer;
GRANT SELECT ON TABLE memory_resolution_consolidations TO archon_resolution_writer;

-- A non-login, non-bypass owner is the only principal with the table
-- privileges needed by the SECURITY DEFINER transition functions. The owner
-- has no members and receives no CREATE privilege after ownership transfer.
GRANT USAGE ON SCHEMA public TO archon_resolution_transition_owner;
REVOKE ALL ON TABLE memory_demo_sessions
    FROM archon_resolution_transition_owner;
REVOKE ALL ON TABLE memory_resolution_observations
    FROM archon_resolution_transition_owner;
REVOKE ALL ON TABLE memory_resolution_proposals
    FROM archon_resolution_transition_owner;
REVOKE ALL ON TABLE memory_resolution_decisions
    FROM archon_resolution_transition_owner;
REVOKE ALL ON TABLE memory_resolution_consolidations
    FROM archon_resolution_transition_owner;
GRANT SELECT, INSERT, UPDATE
    ON TABLE memory_demo_sessions
    TO archon_resolution_transition_owner;
GRANT SELECT, INSERT, UPDATE
    ON TABLE memory_resolution_observations
    TO archon_resolution_transition_owner;
GRANT SELECT, INSERT, UPDATE
    ON TABLE memory_resolution_proposals
    TO archon_resolution_transition_owner;
GRANT SELECT, INSERT
    ON TABLE memory_resolution_decisions
    TO archon_resolution_transition_owner;
GRANT SELECT, INSERT
    ON TABLE memory_resolution_consolidations
    TO archon_resolution_transition_owner;

CREATE POLICY IF NOT EXISTS memory_demo_sessions_operator_v1
    ON memory_demo_sessions
    AS PERMISSIVE FOR ALL TO CURRENT_USER
    USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS memory_demo_sessions_writer_permit_v1
    ON memory_demo_sessions
    AS PERMISSIVE FOR ALL TO
      archon_resolution_writer,
      archon_resolution_transition_owner
    USING (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
    )
    WITH CHECK (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
      AND expires_at <= now() + INTERVAL '61 minutes'
    );
CREATE POLICY IF NOT EXISTS memory_demo_sessions_writer_guard_v1
    ON memory_demo_sessions
    AS RESTRICTIVE FOR ALL TO
      archon_resolution_writer,
      archon_resolution_transition_owner
    USING (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
    )
    WITH CHECK (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
      AND expires_at <= now() + INTERVAL '61 minutes'
    );
ALTER POLICY memory_demo_sessions_writer_permit_v1
    ON memory_demo_sessions
    TO archon_resolution_writer, archon_resolution_transition_owner;
ALTER POLICY memory_demo_sessions_writer_guard_v1
    ON memory_demo_sessions
    TO archon_resolution_writer, archon_resolution_transition_owner;
ALTER TABLE memory_demo_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_demo_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS memory_resolution_observations_operator_v1
    ON memory_resolution_observations
    AS PERMISSIVE FOR ALL TO CURRENT_USER
    USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS memory_resolution_observations_writer_permit_v1
    ON memory_resolution_observations
    AS PERMISSIVE FOR ALL TO
      archon_resolution_writer,
      archon_resolution_transition_owner
    USING (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
    )
    WITH CHECK (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
      AND expires_at <= now() + INTERVAL '61 minutes'
    );
CREATE POLICY IF NOT EXISTS memory_resolution_observations_writer_guard_v1
    ON memory_resolution_observations
    AS RESTRICTIVE FOR ALL TO
      archon_resolution_writer,
      archon_resolution_transition_owner
    USING (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
    )
    WITH CHECK (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
      AND expires_at <= now() + INTERVAL '61 minutes'
    );
ALTER POLICY memory_resolution_observations_writer_permit_v1
    ON memory_resolution_observations
    TO archon_resolution_writer, archon_resolution_transition_owner;
ALTER POLICY memory_resolution_observations_writer_guard_v1
    ON memory_resolution_observations
    TO archon_resolution_writer, archon_resolution_transition_owner;
ALTER TABLE memory_resolution_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_resolution_observations FORCE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS memory_resolution_proposals_operator_v1
    ON memory_resolution_proposals
    AS PERMISSIVE FOR ALL TO CURRENT_USER
    USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS memory_resolution_proposals_writer_permit_v1
    ON memory_resolution_proposals
    AS PERMISSIVE FOR ALL TO
      archon_resolution_writer,
      archon_resolution_transition_owner
    USING (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
    )
    WITH CHECK (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
      AND expires_at <= now() + INTERVAL '61 minutes'
    );
CREATE POLICY IF NOT EXISTS memory_resolution_proposals_writer_guard_v1
    ON memory_resolution_proposals
    AS RESTRICTIVE FOR ALL TO
      archon_resolution_writer,
      archon_resolution_transition_owner
    USING (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
    )
    WITH CHECK (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
      AND expires_at <= now() + INTERVAL '61 minutes'
    );
ALTER POLICY memory_resolution_proposals_writer_permit_v1
    ON memory_resolution_proposals
    TO archon_resolution_writer, archon_resolution_transition_owner;
ALTER POLICY memory_resolution_proposals_writer_guard_v1
    ON memory_resolution_proposals
    TO archon_resolution_writer, archon_resolution_transition_owner;
ALTER TABLE memory_resolution_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_resolution_proposals FORCE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS memory_resolution_decisions_operator_v1
    ON memory_resolution_decisions
    AS PERMISSIVE FOR ALL TO CURRENT_USER
    USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS memory_resolution_decisions_writer_permit_v1
    ON memory_resolution_decisions
    AS PERMISSIVE FOR ALL TO
      archon_resolution_writer,
      archon_resolution_transition_owner
    USING (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
    )
    WITH CHECK (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
      AND expires_at <= now() + INTERVAL '61 minutes'
    );
CREATE POLICY IF NOT EXISTS memory_resolution_decisions_writer_guard_v1
    ON memory_resolution_decisions
    AS RESTRICTIVE FOR ALL TO
      archon_resolution_writer,
      archon_resolution_transition_owner
    USING (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
    )
    WITH CHECK (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
      AND expires_at <= now() + INTERVAL '61 minutes'
    );
ALTER POLICY memory_resolution_decisions_writer_permit_v1
    ON memory_resolution_decisions
    TO archon_resolution_writer, archon_resolution_transition_owner;
ALTER POLICY memory_resolution_decisions_writer_guard_v1
    ON memory_resolution_decisions
    TO archon_resolution_writer, archon_resolution_transition_owner;
ALTER TABLE memory_resolution_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_resolution_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS memory_resolution_consolidations_operator_v1
    ON memory_resolution_consolidations
    AS PERMISSIVE FOR ALL TO CURRENT_USER
    USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS memory_resolution_consolidations_writer_permit_v1
    ON memory_resolution_consolidations
    AS PERMISSIVE FOR ALL TO
      archon_resolution_writer,
      archon_resolution_transition_owner
    USING (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
    )
    WITH CHECK (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
      AND expires_at <= now() + INTERVAL '61 minutes'
    );
CREATE POLICY IF NOT EXISTS memory_resolution_consolidations_writer_guard_v1
    ON memory_resolution_consolidations
    AS RESTRICTIVE FOR ALL TO
      archon_resolution_writer,
      archon_resolution_transition_owner
    USING (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
    )
    WITH CHECK (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND expires_at > now()
      AND expires_at <= now() + INTERVAL '61 minutes'
    );
ALTER POLICY memory_resolution_consolidations_writer_permit_v1
    ON memory_resolution_consolidations
    TO archon_resolution_writer, archon_resolution_transition_owner;
ALTER POLICY memory_resolution_consolidations_writer_guard_v1
    ON memory_resolution_consolidations
    TO archon_resolution_writer, archon_resolution_transition_owner;
ALTER TABLE memory_resolution_consolidations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_resolution_consolidations FORCE ROW LEVEL SECURITY;

-- CockroachDB v26.2 does not implement PostgreSQL's per-function SET
-- configuration clause. Every object and built-in reference in these
-- SECURITY DEFINER bodies is therefore schema-qualified, PUBLIC cannot CREATE
-- in the public schema, and the owner has a fixed pg_catalog role search path.
-- The function bodies are the only mutation surface exposed to the runtime.
GRANT CREATE ON SCHEMA public TO archon_resolution_transition_owner;
SET ROLE archon_resolution_transition_owner;

CREATE OR REPLACE FUNCTION public.archon_resolution_create_session(
    p_token_hash STRING,
    p_session_id UUID,
    p_prior_observation_id UUID,
    p_corrected_observation_id UUID,
    p_proposal_id UUID,
    p_expires_at TIMESTAMPTZ,
    p_max_active_sessions INT8
)
RETURNS STRING
LANGUAGE PLpgSQL
VOLATILE
SECURITY DEFINER
AS $$
DECLARE
    v_active_sessions INT8;
BEGIN
    IF p_token_hash IS NULL
       OR p_token_hash !~ '^[a-f0-9]{64}$'
       OR p_session_id IS NULL
       OR p_prior_observation_id IS NULL
       OR p_corrected_observation_id IS NULL
       OR p_proposal_id IS NULL
       OR p_expires_at IS NULL
       OR p_expires_at <= pg_catalog.now()
       OR p_expires_at > pg_catalog.now() + INTERVAL '61 minutes'
       OR p_max_active_sessions IS NULL
       OR p_max_active_sessions < 10
       OR p_max_active_sessions > 500
    THEN
        RETURN 'invalid';
    END IF;

    SELECT count(*)
      INTO v_active_sessions
      FROM public.memory_demo_sessions
     WHERE expires_at > pg_catalog.now();

    IF v_active_sessions >= p_max_active_sessions THEN
        RETURN 'capacity';
    END IF;

    INSERT INTO public.memory_demo_sessions (
        id, token_hash, scenario_id, tenant_id, company, period,
        state, expires_at
    ) VALUES (
        p_session_id,
        p_token_hash,
        'helios-payroll-2026-06-correction-v1',
        'public-demo',
        'Helios SA',
        '2026-06',
        'pending',
        p_expires_at
    );

    INSERT INTO public.memory_resolution_observations (
        id, session_id, ordinal, label, source_ref, source_class,
        observed_at, authority_rank, employer_cost_cents, status, expires_at
    ) VALUES
      (
        p_prior_observation_id,
        p_session_id,
        1,
        'prior',
        'payroll-register-2026-06-v1',
        'payroll-register',
        '2026-07-01T08:00:00.000Z',
        60,
        12440000,
        'current',
        p_expires_at
      ),
      (
        p_corrected_observation_id,
        p_session_id,
        2,
        'corrected',
        'signed-payroll-register-2026-06-v2',
        'signed-payroll-register',
        '2026-07-08T10:30:00.000Z',
        100,
        12890000,
        'candidate',
        p_expires_at
      );

    INSERT INTO public.memory_resolution_proposals (
        id, session_id, action, status, proposed_observation_id,
        supersedes_observation_id, rationale, required_human_role, expires_at
    ) VALUES (
        p_proposal_id,
        p_session_id,
        'resolve-conflicting-memory',
        'pending',
        p_corrected_observation_id,
        p_prior_observation_id,
        'Prefer the newer signed payroll register, but preserve both sources and require a financial controller decision.',
        'financial-controller',
        p_expires_at
    );

    RETURN 'created';
END;
$$;

CREATE OR REPLACE FUNCTION public.archon_resolution_decide(
    p_token_hash STRING,
    p_decision STRING,
    p_idempotency_key UUID,
    p_decision_id UUID,
    p_consolidation_id UUID,
    p_decided_at TIMESTAMPTZ
)
RETURNS STRING
LANGUAGE PLpgSQL
VOLATILE
SECURITY DEFINER
AS $$
DECLARE
    v_session_id UUID;
    v_session_state STRING;
    v_expires_at TIMESTAMPTZ;
    v_proposal_id UUID;
    v_proposal_state STRING;
    v_corrected_observation_id UUID;
    v_prior_observation_id UUID;
    v_existing_decision STRING;
    v_existing_idempotency_key UUID;
    v_current_observation_id UUID;
    v_superseded_observation_id UUID;
    v_final_state STRING;
    v_consolidation_mode STRING;
    v_receipt_canonical STRING;
    v_receipt_hash STRING;
BEGIN
    IF p_token_hash IS NULL
       OR p_token_hash !~ '^[a-f0-9]{64}$'
       OR p_decision IS NULL
       OR p_decision NOT IN ('approve', 'reject')
       OR p_idempotency_key IS NULL
       OR p_decision_id IS NULL
       OR p_consolidation_id IS NULL
       OR p_decided_at IS NULL
       OR p_decided_at < pg_catalog.now() - INTERVAL '5 minutes'
       OR p_decided_at > pg_catalog.now() + INTERVAL '5 minutes'
    THEN
        RETURN 'invalid';
    END IF;

    SELECT id, state, expires_at
      INTO v_session_id, v_session_state, v_expires_at
      FROM public.memory_demo_sessions
     WHERE token_hash = p_token_hash
       AND expires_at > pg_catalog.now()
     FOR UPDATE;

    IF v_session_id IS NULL THEN
        RETURN 'not_found';
    END IF;

    SELECT decision, idempotency_key
      INTO v_existing_decision, v_existing_idempotency_key
      FROM public.memory_resolution_decisions
     WHERE session_id = v_session_id;

    IF v_existing_decision IS NOT NULL THEN
        IF v_existing_decision = p_decision
           AND v_existing_idempotency_key = p_idempotency_key
        THEN
            RETURN 'replayed';
        END IF;
        RETURN 'conflict';
    END IF;

    IF v_session_state <> 'pending' THEN
        RETURN 'conflict';
    END IF;

    SELECT
        id,
        status,
        proposed_observation_id,
        supersedes_observation_id
      INTO
        v_proposal_id,
        v_proposal_state,
        v_corrected_observation_id,
        v_prior_observation_id
      FROM public.memory_resolution_proposals
     WHERE session_id = v_session_id
     FOR UPDATE;

    IF v_proposal_id IS NULL OR v_proposal_state <> 'pending' THEN
        RETURN 'conflict';
    END IF;

    IF p_decision = 'approve' THEN
        v_final_state := 'approved';
        v_current_observation_id := v_corrected_observation_id;
        v_superseded_observation_id := v_prior_observation_id;
        v_consolidation_mode := 'approved-correction';
    ELSE
        v_final_state := 'rejected';
        v_current_observation_id := v_prior_observation_id;
        v_superseded_observation_id := NULL;
        v_consolidation_mode := 'retained-prior';
    END IF;

    v_receipt_canonical :=
        '{"actorRole":"financial-controller","currentObservationId":"'
        || v_current_observation_id::STRING
        || '","decidedAt":"'
        || pg_catalog.to_char(
             pg_catalog.timezone('UTC', p_decided_at),
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           )
        || '","decision":"'
        || p_decision
        || '","decisionId":"'
        || p_decision_id::STRING
        || '","idempotencyKey":"'
        || p_idempotency_key::STRING
        || '","policyVersion":"resolution-policy-v1","proposalId":"'
        || v_proposal_id::STRING
        || '","scenarioId":"helios-payroll-2026-06-correction-v1","sessionId":"'
        || v_session_id::STRING
        || '","supersededObservationId":'
        || CASE
             WHEN v_superseded_observation_id IS NULL THEN 'null'
             ELSE '"' || v_superseded_observation_id::STRING || '"'
           END
        || '}';
    v_receipt_hash := pg_catalog.sha256(v_receipt_canonical);

    UPDATE public.memory_demo_sessions
       SET state = v_final_state,
           decision_version = 1,
           updated_at = p_decided_at
     WHERE id = v_session_id
       AND state = 'pending';

    UPDATE public.memory_resolution_proposals
       SET status = v_final_state,
           updated_at = p_decided_at
     WHERE id = v_proposal_id
       AND status = 'pending';

    IF p_decision = 'approve' THEN
        UPDATE public.memory_resolution_observations
           SET status = CASE
                 WHEN id = v_prior_observation_id THEN 'superseded'
                 WHEN id = v_corrected_observation_id THEN 'current'
                 ELSE status
               END,
               updated_at = p_decided_at
         WHERE session_id = v_session_id;
    ELSE
        UPDATE public.memory_resolution_observations
           SET status = CASE
                 WHEN id = v_prior_observation_id THEN 'current'
                 WHEN id = v_corrected_observation_id THEN 'rejected'
                 ELSE status
               END,
               updated_at = p_decided_at
         WHERE session_id = v_session_id;
    END IF;

    INSERT INTO public.memory_resolution_decisions (
        id, session_id, proposal_id, idempotency_key, actor_role,
        decision, decided_at, policy_version, current_observation_id,
        superseded_observation_id, receipt_hash, expires_at
    ) VALUES (
        p_decision_id,
        v_session_id,
        v_proposal_id,
        p_idempotency_key,
        'financial-controller',
        p_decision,
        p_decided_at,
        'resolution-policy-v1',
        v_current_observation_id,
        v_superseded_observation_id,
        v_receipt_hash,
        v_expires_at
    );

    INSERT INTO public.memory_resolution_consolidations (
        id, session_id, decision_id, policy_version, mode,
        current_observation_id, superseded_observation_id,
        receipt_hash, consolidated_at, expires_at
    ) VALUES (
        p_consolidation_id,
        v_session_id,
        p_decision_id,
        'resolution-policy-v1',
        v_consolidation_mode,
        v_current_observation_id,
        v_superseded_observation_id,
        v_receipt_hash,
        p_decided_at,
        v_expires_at
    );

    RETURN 'applied';
END;
$$;

REVOKE ALL ON FUNCTION public.archon_resolution_create_session(
    STRING, UUID, UUID, UUID, UUID, TIMESTAMPTZ, INT8
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.archon_resolution_decide(
    STRING, STRING, UUID, UUID, UUID, TIMESTAMPTZ
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.archon_resolution_create_session(
    STRING, UUID, UUID, UUID, UUID, TIMESTAMPTZ, INT8
) TO archon_resolution_writer;
GRANT EXECUTE ON FUNCTION public.archon_resolution_decide(
    STRING, STRING, UUID, UUID, UUID, TIMESTAMPTZ
) TO archon_resolution_writer;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM archon_resolution_transition_owner;

CREATE POLICY IF NOT EXISTS agent_memory_migration_operator_v1
    ON agent_memory
    AS PERMISSIVE
    FOR ALL
    TO CURRENT_USER
    USING (true)
    WITH CHECK (true);

CREATE POLICY IF NOT EXISTS agent_memory_public_demo_permit_v1
    ON agent_memory
    AS PERMISSIVE
    FOR SELECT
    TO archon_public_reader
    USING (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND status = 'active'
    );

CREATE POLICY IF NOT EXISTS agent_memory_public_demo_guard_v1
    ON agent_memory
    AS RESTRICTIVE
    FOR SELECT
    TO archon_public_reader
    USING (
      tenant_id = 'public-demo'
      AND company = 'Helios SA'
      AND status = 'active'
    );

ALTER TABLE agent_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_memory_tenant_permissive ON agent_memory;
DROP POLICY IF EXISTS agent_memory_tenant_restrictive ON agent_memory;
DROP POLICY IF EXISTS agent_memory_public_demo_reader ON agent_memory;
DROP POLICY IF EXISTS agent_memory_migration_operator ON agent_memory;

-- Distributed vector index (cosine). CockroachDB organizes the vectors into a
-- hierarchical k-means partition tree and distributes it across the cluster.
--
-- This is a GLOBAL index (embedding only — no prefix columns). Verified via
-- EXPLAIN on v26.2.2: an unscoped `ORDER BY embedding <=> $q LIMIT k` plans a
-- `vector search` node (index-accelerated). A prefix index like
-- `(kind, company, embedding)` only accelerates when BOTH prefix columns are
-- equality-constrained, which would forbid the cross-company semantic recall the
-- memory layer needs — so we index globally and pre-filter with the btree
-- indexes below when a query is scoped. See docs/BUILD_PLAN.md (indexing notes).
CREATE VECTOR INDEX IF NOT EXISTS idx_agent_memory_embedding
    ON agent_memory (embedding vector_cosine_ops);

-- Production recall always equality-constrains tenant, embedding model, and
-- active lifecycle state. These prefix indexes therefore keep ANN work inside
-- the exact security/model space the query is allowed to see. The second index
-- additionally accelerates the fixed-company public demo path.
CREATE VECTOR INDEX IF NOT EXISTS idx_agent_memory_scope_embedding
    ON agent_memory (
      tenant_id,
      embed_model,
      status,
      embedding vector_cosine_ops
    );
CREATE VECTOR INDEX IF NOT EXISTS idx_agent_memory_company_scope_embedding
    ON agent_memory (
      tenant_id,
      embed_model,
      status,
      company,
      embedding vector_cosine_ops
    );
CREATE VECTOR INDEX IF NOT EXISTS idx_agent_memory_company_kind_scope_embedding
    ON agent_memory (
      tenant_id,
      embed_model,
      status,
      company,
      kind,
      embedding vector_cosine_ops
    );

-- CockroachDB v26.2 represents RLS as an optimizer barrier. A forced vector
-- index below that barrier cannot be rewritten to a VectorSearch operator.
-- These dematerialized serving views preserve the fixed public scope while
-- planning their hinted scans as a dedicated non-login BYPASSRLS owner. In
-- CockroachDB v26.2.3 BYPASSRLS is a direct, non-inheritable role option (not a
-- valid table privilege); the owner therefore has no members and no system
-- privileges. Lambda/runtime principals remain NOBYPASSRLS and receive SELECT
-- on only these fixed-scope views plus the RLS-protected base table.
CREATE ROLE IF NOT EXISTS archon_public_memory_view_owner WITH NOLOGIN;
ALTER ROLE archon_public_memory_view_owner WITH NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO archon_public_memory_view_owner;
REVOKE ALL ON TABLE agent_memory FROM archon_public_memory_view_owner;
GRANT SELECT ON TABLE agent_memory TO archon_public_memory_view_owner;

CREATE OR REPLACE VIEW archon_public_memory_recall (
    id,
    tenant_id,
    kind,
    company,
    period,
    source_ref,
    content,
    metadata,
    embedding,
    embed_model,
    idempotency_key,
    status,
    created_at
) WITH (security_invoker = false) AS
SELECT id, tenant_id, kind, company, period, source_ref, content, metadata,
       embedding, embed_model, idempotency_key, status, created_at
  FROM public.agent_memory@{FORCE_INDEX=idx_agent_memory_company_scope_embedding}
 WHERE tenant_id = 'public-demo'
   AND company = 'Helios SA'
   AND status = 'active';

CREATE OR REPLACE VIEW archon_public_memory_kind_recall (
    id,
    tenant_id,
    kind,
    company,
    period,
    source_ref,
    content,
    metadata,
    embedding,
    embed_model,
    idempotency_key,
    status,
    created_at
) WITH (security_invoker = false) AS
SELECT id, tenant_id, kind, company, period, source_ref, content, metadata,
       embedding, embed_model, idempotency_key, status, created_at
  FROM public.agent_memory@{FORCE_INDEX=idx_agent_memory_company_kind_scope_embedding}
 WHERE tenant_id = 'public-demo'
   AND company = 'Helios SA'
   AND status = 'active';

-- CockroachDB requires a prospective owner to have CREATE on the parent
-- schema. apply-schema.ts also revokes this in its finally block, so a failed
-- ownership transfer cannot strand the capability.
GRANT CREATE ON SCHEMA public TO archon_public_memory_view_owner;
ALTER VIEW archon_public_memory_recall
    OWNER TO archon_public_memory_view_owner;
ALTER VIEW archon_public_memory_kind_recall
    OWNER TO archon_public_memory_view_owner;
REVOKE CREATE ON SCHEMA public FROM archon_public_memory_view_owner;

REVOKE ALL ON TABLE archon_public_memory_recall FROM PUBLIC;
REVOKE ALL ON TABLE archon_public_memory_kind_recall FROM PUBLIC;
REVOKE ALL ON TABLE archon_public_memory_recall FROM archon_public_reader;
REVOKE ALL ON TABLE archon_public_memory_kind_recall FROM archon_public_reader;
GRANT SELECT ON TABLE archon_public_memory_recall TO archon_public_reader;
GRANT SELECT ON TABLE archon_public_memory_kind_recall TO archon_public_reader;

-- Conventional secondary indexes for exact-match filtering / housekeeping.
CREATE INDEX IF NOT EXISTS idx_agent_memory_kind ON agent_memory (kind);
CREATE INDEX IF NOT EXISTS idx_agent_memory_company ON agent_memory (company);
CREATE INDEX IF NOT EXISTS idx_agent_memory_source_ref ON agent_memory (source_ref);
CREATE INDEX IF NOT EXISTS idx_agent_memory_period ON agent_memory (period);
CREATE INDEX IF NOT EXISTS idx_agent_memory_active_scope
    ON agent_memory (tenant_id, embed_model, status, company, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_idempotency
    ON agent_memory (tenant_id, embed_model, idempotency_key);
