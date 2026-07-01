// End-to-end demo of the CockroachDB agent-memory round trip.
//
//   npm run db:schema      # once, to create tables + vector index
//   npm run memory:demo
//
// Uses real Bedrock Titan embeddings when AWS creds are present, otherwise the
// deterministic FakeEmbedder — either way it exercises the SAME write + vector
// recall path against a live CockroachDB. Shows an agent (a) ingesting fused
// financial events into memory, then (b) recalling relevant facts by meaning to
// answer questions it was never given the keys for.

import { defaultEmbedder } from "../src/memory/embeddings.js";
import { memoryCount } from "../src/memory/memory.js";
import { MemoryAgent } from "../src/agents/memory-agent.js";
import { closePool, query } from "../src/db/client.js";
import type { PayrollEvent } from "../src/extraction/types.js";

// Two synthetic fused events for two companies / periods.
const EVENTS: PayrollEvent[] = [
  {
    event_id: "evt-acme-2026-03",
    company: "Acme Foods AE",
    period: "2026-03",
    employee_count: 3,
    bank_net_total: 41000,
    gross_total: 52000,
    employer_ika_total: 11800,
    employee_ika_total: 4200,
    tax_withheld_total: 6800,
    employer_cost_total: 63800,
    cost_gap_amount: 11800,
    cost_gap_pct: 28.8,
    hidden_total: 22800,
    employees: [
      { employee_id: "E-01", name: "Maria Papadopoulou", gross: 22000, employee_ika: 1800, tax: 3000, net: 17200, employer_ika: 5000, employer_cost: 27000 },
      { employee_id: "E-02", name: "Nikos Georgiou", gross: 18000, employee_ika: 1500, tax: 2400, net: 14100, employer_ika: 4100, employer_cost: 22100 },
      { employee_id: "E-03", name: "Elena Dimitriou", gross: 12000, employee_ika: 900, tax: 1400, net: 9700, employer_ika: 2700, employer_cost: 14700 },
    ],
    linked_docs: ["doc-bank-1", "doc-reg-1"],
  },
  {
    event_id: "evt-helios-2026-02",
    company: "Helios Retail EPE",
    period: "2026-02",
    employee_count: 2,
    bank_net_total: 22000,
    gross_total: 28000,
    employer_ika_total: 6300,
    employee_ika_total: 2200,
    tax_withheld_total: 3800,
    employer_cost_total: 34300,
    cost_gap_amount: 6300,
    cost_gap_pct: 28.6,
    hidden_total: 12300,
    employees: [
      { employee_id: "H-01", name: "Georgios Alexiou", gross: 16000, employee_ika: 1300, tax: 2200, net: 12500, employer_ika: 3600, employer_cost: 19600 },
      { employee_id: "H-02", name: "Sofia Ioannou", gross: 12000, employee_ika: 900, tax: 1600, net: 9500, employer_ika: 2700, employer_cost: 14700 },
    ],
    linked_docs: ["doc-bank-2", "doc-reg-2"],
  },
];

async function main() {
  const embedder = defaultEmbedder();
  console.log(`Embedder: ${embedder.modelId} (${embedder.dim} dims)\n`);
  const agent = new MemoryAgent(embedder);

  // Clean slate for a repeatable demo.
  await query(`DELETE FROM agent_memory`);

  // ── WRITE: agent commits fused events to memory ──────────────────────────
  for (const ev of EVENTS) {
    const ids = await agent.ingestEvent(ev);
    console.log(`WROTE ${ids.length} memories for ${ev.company} ${ev.period}`);
  }
  console.log(`Total memories in CockroachDB: ${await memoryCount()}\n`);

  // ── READ: agent recalls by MEANING (no keys given) ───────────────────────
  const questions: { q: string; company?: string }[] = [
    { q: "How much payroll cost is hidden from the bank statement?", company: "Acme Foods AE" },
    { q: "What did we pay Maria and what was her take-home?", company: "Acme Foods AE" },
    { q: "Which social-security contributions does the employer pay?" }, // cross-company
  ];
  for (const { q, company } of questions) {
    const { answer } = await agent.recallAnswer(q, { company, limit: 3 });
    console.log(`Q: ${q}${company ? `  [company=${company}]` : "  [all companies]"}`);
    console.log(answer + "\n");
  }

  await closePool();
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
