// Seed a representative fused financial event into the memory store so the demo
// (the AWS HTTP API, the memory:demo script, or a judge using the live UI) has
// on-topic memories to recall — the headline question "what was the true employer
// cost and the off-bank wedge?" then answers substantively, with citations.
//
// Uses the env-selected embedder (real Bedrock Titan when AWS creds are present,
// FakeEmbedder offline), so the stored vectors match how the API embeds queries.
//
//   # against CockroachDB Cloud with real Titan embeddings
//   AWS_PROFILE=default DATABASE_URL='postgresql://…' npm run demo:seed
//
// Every write is idempotent. The production seed never deletes existing memory.

import { MemoryAgent } from "../src/agents/memory-agent.js";
import { defaultEmbedder } from "../src/memory/embeddings.js";
import type { Embedder } from "../src/memory/embeddings.js";
import { FakeNarrator } from "../src/agents/narrator.js";
import { memoryCount } from "../src/memory/memory.js";
import { closePool, query, toVectorLiteral } from "../src/db/client.js";
import type { PayrollEvent, EmployeePayslip } from "../src/extraction/types.js";

function emp(id: string, name: string, gross: number, net: number, employerCost: number): EmployeePayslip {
  return {
    employee_id: id,
    name,
    gross,
    employee_social_security: Math.round(gross * 0.14),
    tax: Math.round(gross * 0.1),
    net,
    employer_social_security: employerCost - gross,
    employer_cost: employerCost,
  };
}

export function demoEvent(): PayrollEvent {
  const employees = [
    emp("E-01", "Maria Papadopoulou", 3000, 2100, 3750),
    emp("E-02", "Yannis Georgiou", 2500, 1800, 3125),
    emp("E-03", "Elena Nikolaou", 4000, 2700, 5000),
    emp("E-04", "Dimitris Alexiou", 2800, 2000, 3500),
  ];
  const gross = employees.reduce((s, e) => s + e.gross, 0);
  const bank = employees.reduce((s, e) => s + e.net, 0);
  const employerCost = employees.reduce((s, e) => s + e.employer_cost, 0);
  const employerSS = employerCost - gross;
  return {
    event_id: "EVT-HELIOS-2604",
    company: "Helios SA",
    period: "2026-04",
    employee_count: employees.length,
    bank_net_total: bank,
    gross_total: gross,
    employer_social_security_total: employerSS,
    employee_social_security_total: employees.reduce((s, e) => s + e.employee_social_security, 0),
    tax_withheld_total: employees.reduce((s, e) => s + e.tax, 0),
    employer_cost_total: employerCost,
    cost_gap_amount: employerSS,
    cost_gap_pct: (employerSS / bank) * 100,
    off_bank_cost: employerCost - bank,
    employees,
    linked_docs: ["DOC-bank-1", "DOC-register-1", "DOC-payslip-1"],
  };
}

async function main() {
  const embedder = defaultEmbedder();
  const agent = new MemoryAgent(embedder, new FakeNarrator());
  const ids = await agent.ingestEvent(demoEvent());
  const auditIds = await Promise.all([
    agent.remember(
      "document",
      "Synthetic invoice revision INV-2043 records a confirmed total of €18,400.",
      {
        company: "Helios SA",
        period: "2026-04",
        sourceRef: "INV-2043",
        idempotencyKey: "archon-demo/v1/inv-2043-confirmed",
        metadata: {
          record: "INV-2043",
          total: 18_400,
          importance: 0.9,
          fixture: "synthetic-public-demo",
        },
      }
    ),
    agent.remember(
      "document",
      "Synthetic later note for INV-2043 records a conflicting total of €18,900.",
      {
        company: "Helios SA",
        period: "2026-04",
        sourceRef: "INV-2043",
        idempotencyKey: "archon-demo/v1/inv-2043-later-note",
        metadata: {
          record: "INV-2043",
          total: 18_900,
          fixture: "synthetic-public-demo",
        },
      }
    ),
    agent.remember(
      "validation",
      "Synthetic reconciliation RECON-2043 expects payroll confirmation PAY-118, which has not been stored.",
      {
        company: "Helios SA",
        period: "2026-04",
        sourceRef: "RECON-2043",
        idempotencyKey: "archon-demo/v1/recon-2043-missing-pay-118",
        metadata: {
          record: "RECON-2043",
          refs: ["PAY-118"],
          fixture: "synthetic-public-demo",
        },
      }
    ),
  ]);
  const isolationCanaryId = await agent.remember(
    "validation",
    "Synthetic isolation canary that must never be visible to the Helios SA public runtime.",
    {
      company: "Isolation Canary Ltd",
      period: "2026-04",
      sourceRef: "RLS-CANARY-1",
      idempotencyKey: "archon-demo/v1/rls-hidden-company-canary",
      metadata: {
        record: "RLS-CANARY-1",
        fixture: "synthetic-security-canary",
      },
    }
  );
  await Promise.all([
    seedIsolationCanary(embedder, {
      tenantId: "isolation-canary",
      company: "Helios SA",
      status: "active",
      idempotencyKey: "archon-demo/v1/rls-wrong-tenant-canary",
      content:
        "Synthetic wrong-tenant canary that must never be visible to the public runtime.",
      record: "RLS-CANARY-TENANT",
    }),
    seedIsolationCanary(embedder, {
      tenantId: "public-demo",
      company: "Helios SA",
      status: "retracted",
      idempotencyKey: "archon-demo/v1/rls-retracted-status-canary",
      content:
        "Synthetic retracted-status canary that must never be visible to the public runtime.",
      record: "RLS-CANARY-STATUS",
    }),
  ]);
  const ev = demoEvent();
  console.log(
    `seeded ${ids.length + auditIds.length} idempotent memories for ${ev.company} ${ev.period}: ` +
      `${ev.employee_count} employees, true employer cost €${ev.employer_cost_total.toLocaleString()}, ` +
      `full off-bank gap €${ev.off_bank_cost.toLocaleString()}; ` +
      `employer-contribution wedge €${ev.employer_social_security_total.toLocaleString()} ` +
      `(${ev.cost_gap_pct.toFixed(1)}% of bank).`
  );
  console.log(
    "self-audit fixtures: INV-2043 contradiction and missing PAY-118 counterpart."
  );
  console.log(
    `three-axis isolation canaries seeded (${isolationCanaryId.length > 0 ? "company id assigned" : "company id missing"}); ` +
      "runtime verification must prove wrong-company, wrong-tenant, and retracted rows are invisible."
  );
  console.log(`total memories now: ${await memoryCount()}`);
  await closePool();
}

async function seedIsolationCanary(
  embedder: Embedder,
  input: {
    tenantId: string;
    company: string;
    status: "active" | "retracted";
    idempotencyKey: string;
    content: string;
    record: string;
  }
): Promise<void> {
  const embedding = await embedder.embed(input.content);
  await query(
    `INSERT INTO agent_memory
       (tenant_id, kind, company, period, source_ref, content, metadata,
        embedding, embed_model, idempotency_key, status)
     VALUES ($1, 'validation', $2, '2026-04', $3, $4, $5,
             $6::VECTOR, $7, $8, $9)
     ON CONFLICT (tenant_id, embed_model, idempotency_key) DO NOTHING`,
    [
      input.tenantId,
      input.company,
      input.record,
      input.content,
      JSON.stringify({
        record: input.record,
        fixture: "synthetic-security-canary",
      }),
      toVectorLiteral(embedding),
      embedder.modelId,
      input.idempotencyKey,
      input.status,
    ]
  );
}

main().catch(async (error) => {
  await closePool().catch(() => undefined);
  console.error("Demo seed failed", {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
});
