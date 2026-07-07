// End-to-end demo of the CockroachDB agent-memory round trip.
//
//   npm run db:schema      # once, to create tables + vector index
//   npm run memory:demo
//
// Uses real Bedrock (Titan embeddings + Claude Sonnet narration) when AWS creds
// are present, otherwise the deterministic FakeEmbedder + FakeNarrator — either
// way it exercises the SAME write + vector recall + narrate path against a live
// CockroachDB. Shows an agent (a) ingesting fused financial events into memory,
// then (b) recalling relevant facts by meaning and (c) writing a grounded,
// citing answer to a question it was never given the keys for.

import { defaultEmbedder } from "../src/memory/embeddings.js";
import { memoryCount } from "../src/memory/memory.js";
import { defaultNarrator } from "../src/agents/narrator.js";
import { MemoryAgent } from "../src/agents/memory-agent.js";
import { closePool, query } from "../src/db/client.js";
import type { PayrollEvent } from "../src/extraction/types.js";

// Two synthetic fused events for two companies / periods.
const EVENTS: PayrollEvent[] = [
  {
    event_id: "evt-acme-2026-03",
    company: "Acme Foods",
    period: "2026-03",
    employee_count: 3,
    bank_net_total: 41000,
    gross_total: 52000,
    employer_social_security_total: 11800,
    employee_social_security_total: 4200,
    tax_withheld_total: 6800,
    employer_cost_total: 63800,
    cost_gap_amount: 11800,
    cost_gap_pct: 28.8,
    off_bank_cost: 22800,
    employees: [
      { employee_id: "E-01", name: "Alex Morgan", gross: 22000, employee_social_security: 1800, tax: 3000, net: 17200, employer_social_security: 5000, employer_cost: 27000 },
      { employee_id: "E-02", name: "Sam Rivera", gross: 18000, employee_social_security: 1500, tax: 2400, net: 14100, employer_social_security: 4100, employer_cost: 22100 },
      { employee_id: "E-03", name: "Priya Nair", gross: 12000, employee_social_security: 900, tax: 1400, net: 9700, employer_social_security: 2700, employer_cost: 14700 },
    ],
    linked_docs: ["doc-bank-1", "doc-reg-1"],
  },
  {
    event_id: "evt-helios-2026-02",
    company: "Helios Retail",
    period: "2026-02",
    employee_count: 2,
    bank_net_total: 22000,
    gross_total: 28000,
    employer_social_security_total: 6300,
    employee_social_security_total: 2200,
    tax_withheld_total: 3800,
    employer_cost_total: 34300,
    cost_gap_amount: 6300,
    cost_gap_pct: 28.6,
    off_bank_cost: 12300,
    employees: [
      { employee_id: "H-01", name: "Jordan Lee", gross: 16000, employee_social_security: 1300, tax: 2200, net: 12500, employer_social_security: 3600, employer_cost: 19600 },
      { employee_id: "H-02", name: "Emma Rossi", gross: 12000, employee_social_security: 900, tax: 1600, net: 9500, employer_social_security: 2700, employer_cost: 14700 },
    ],
    linked_docs: ["doc-bank-2", "doc-reg-2"],
  },
];

async function main() {
  const embedder = defaultEmbedder();
  const narrator = defaultNarrator();
  console.log(`Embedder: ${embedder.modelId} (${embedder.dim} dims)`);
  console.log(`Narrator: ${narrator.modelId}\n`);
  const agent = new MemoryAgent(embedder, narrator);

  // Clean slate for a repeatable demo.
  await query(`DELETE FROM agent_memory`);

  // ── WRITE: agent commits fused events to memory ──────────────────────────
  for (const ev of EVENTS) {
    const ids = await agent.ingestEvent(ev);
    console.log(`WROTE ${ids.length} memories for ${ev.company} ${ev.period}`);
  }

  // Beyond the numbers, Archon also cross-checks the whole picture for missing or
  // inconsistent information. Here it remembers a completeness finding — a bank
  // payment with no matching invoice — a co-equal example alongside workforce cost.
  await agent.remember(
    "validation",
    `Completeness check for Acme Foods 2026-03: a bank payment of €4,500 to vendor ` +
      `"Nomad Supplies" has no matching purchase invoice on file — either the invoice ` +
      `was never registered or the payment is misattributed. Flagged for review.`,
    { company: "Acme Foods", period: "2026-03", sourceRef: "chk-acme-2026-03" }
  );
  console.log(`Total memories in CockroachDB: ${await memoryCount()}\n`);

  // ── READ: agent recalls by MEANING, then NARRATES a grounded, cited answer ─
  const questions: { q: string; company?: string }[] = [
    { q: "What was our real cost of employing the team last month?", company: "Acme Foods" },
    { q: "Are there any payments without a matching invoice?", company: "Acme Foods" },
    { q: "Which social-security contributions does the employer pay?" }, // cross-company
  ];
  for (const { q, company } of questions) {
    const { answer, citations, modelId } = await agent.recallAnswer(q, { company, limit: 3 });
    console.log(`Q: ${q}${company ? `  [company=${company}]` : "  [all companies]"}`);
    console.log(`A (${modelId}): ${answer}`);
    console.log(`Grounded in ${citations.length} recalled memory item(s): ` +
      citations.map((c) => `${c.marker} ${c.kind}`).join(", ") + "\n");
  }

  // ── SELF-AUDIT: the agent checks its OWN memory for cross-session conflicts ─
  // Across many separate write events, two sessions can remember the same record
  // differently. Here two sessions stored different totals for one invoice (the
  // earlier write flagged important), and a reconciliation memory references a
  // payment record no session ever stored. The agent audits everything it has
  // remembered and RECOMMENDS which value to trust — read-only, it never rewrites
  // or deletes a memory.
  await agent.remember(
    "document",
    `Invoice INV-2043 for Acme Foods totalled €18,400 (confirmed by finance).`,
    { company: "Acme Foods", period: "2026-03", sourceRef: "INV-2043",
      metadata: { record: "INV-2043", total: 18400, importance: 0.9 } }
  );
  await agent.remember(
    "document",
    `Invoice INV-2043 for Acme Foods totalled €18,900 (later casual note).`,
    { company: "Acme Foods", period: "2026-03", sourceRef: "INV-2043",
      metadata: { record: "INV-2043", total: 18900 } }
  );
  await agent.remember(
    "validation",
    `Three-way match for INV-2043 references purchase order PO-5590 and payment PAY-118.`,
    { company: "Acme Foods", period: "2026-03", sourceRef: "RECON-2043",
      metadata: { record: "RECON-2043", refs: ["INV-2043", "PAY-118"] } }
  );

  const countBefore = await memoryCount();
  const report = await agent.audit({ company: "Acme Foods" });
  const countAfter = await memoryCount();
  console.log(
    `SELF-AUDIT over ${report.audited} stored memories: ` +
      `${report.contradictions.length} contradiction(s), ${report.absences.length} dangling reference(s).`
  );
  for (const c of report.contradictions) {
    console.log(
      ` • ${c.subject}.${c.attribute}: ${c.values.map((v) => v.value).join(" vs ")} ` +
        `→ trust ${c.resolution.recommendedValue} ` +
        `(${c.resolution.rule}, confidence ${c.resolution.confidence})`
    );
    console.log(`   ${c.resolution.rationale}`);
  }
  for (const a of report.absences) {
    console.log(` • dangling reference: ${a.subject} is referenced but never stored ` +
      `(by ${a.referencedBy.map((r) => r.memoryId).join(", ")})`);
  }
  console.log(`Read-only: memory count unchanged (${countBefore} → ${countAfter}).\n`);

  await closePool();
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
