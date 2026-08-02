import { Counter, Rate, Trend } from "k6/metrics";

// No network access: this one-iteration workload exists only to prove the
// pinned k6 machine-readable summary schema that evidence workflows parse.
const schemaCounter = new Counter("archon_schema_counter");
const schemaRate = new Rate("archon_schema_rate");
const schemaTrend = new Trend("archon_schema_trend_ms", true);

export const options = {
  scenarios: {
    summary_schema: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "10s",
    },
  },
};

export default function summarySchemaSmoke() {
  schemaCounter.add(1);
  schemaRate.add(true);
  schemaTrend.add(42);
}
