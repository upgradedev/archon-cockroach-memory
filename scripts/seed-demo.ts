// Seed a representative fused financial event into the memory store so the demo
// (the AWS Function URL, the memory:demo script, a judge poking the live API) has
// on-topic memories to recall — the headline question "what was the true employer
// cost and the off-bank wedge?" then answers substantively, with citations.
//
// Uses the env-selected embedder (real Bedrock Titan when AWS creds are present,
// FakeEmbedder offline), so the stored vectors match how the API embeds queries.
//
//   # against CockroachDB Cloud with real Titan embeddings
//   AWS_PROFILE=default DATABASE_URL='postgresql://…' DEMO_RESET=1 npm run demo:seed
//
// DEMO_RESET=1 first clears existing memories (removes stale test residue) so the
// demo store is clean; without it, the event is simply added.

import { MemoryAgent } from "../src/agents/memory-agent.js";
import { defaultEmbedder } from "../src/memory/embeddings.js";
import { FakeNarrator } from "../src/agents/narrator.js";
import { memoryCount } from "../src/memory/memory.js";
import { query, closePool } from "../src/db/client.js";
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
  const agent = new MemoryAgent(defaultEmbedder(), new FakeNarrator());
  if (process.env.DEMO_RESET === "1") {
    await query(`DELETE FROM agent_memory`);
    console.log("cleared existing memories (DEMO_RESET=1)");
  }
  const ids = await agent.ingestEvent(demoEvent());
  const ev = demoEvent();
  console.log(
    `seeded ${ids.length} memories for ${ev.company} ${ev.period}: ` +
      `${ev.employee_count} employees, true employer cost €${ev.employer_cost_total.toLocaleString()}, ` +
      `off-bank wedge €${ev.off_bank_cost.toLocaleString()} (~${ev.cost_gap_pct.toFixed(1)}%).`
  );
  console.log(`total memories now: ${await memoryCount()}`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
