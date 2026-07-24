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

REVOKE ALL ON TABLE documents FROM archon_public_reader;
REVOKE ALL ON TABLE employees FROM archon_public_reader;
REVOKE ALL ON TABLE employee_payroll FROM archon_public_reader;
REVOKE ALL ON TABLE payroll_events FROM archon_public_reader;
REVOKE ALL ON TABLE payroll_event_payslips FROM archon_public_reader;
REVOKE ALL ON TABLE validation_results FROM archon_public_reader;
REVOKE ALL ON TABLE agent_memory FROM archon_public_reader;
GRANT SELECT ON TABLE agent_memory TO archon_public_reader;

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

-- Conventional secondary indexes for exact-match filtering / housekeeping.
CREATE INDEX IF NOT EXISTS idx_agent_memory_kind ON agent_memory (kind);
CREATE INDEX IF NOT EXISTS idx_agent_memory_company ON agent_memory (company);
CREATE INDEX IF NOT EXISTS idx_agent_memory_source_ref ON agent_memory (source_ref);
CREATE INDEX IF NOT EXISTS idx_agent_memory_period ON agent_memory (period);
CREATE INDEX IF NOT EXISTS idx_agent_memory_active_scope
    ON agent_memory (tenant_id, embed_model, status, company, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_idempotency
    ON agent_memory (tenant_id, embed_model, idempotency_key);
