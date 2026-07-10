// In-memory CockroachDB mock for offline unit/integration tests.
// Hooks into pg.Pool.prototype.query to simulate database operations, including
// distributed vector indexing and cosine distance calculation.

import { mock } from "node:test";
import pg from "pg";

// Set a dummy connection string if not already set, to prevent getPool() from throwing.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://mock_user:mock_pass@localhost:26257/archon_memory?sslmode=disable";
}

interface MockRecord {
  id: string;
  kind: string;
  company: string;
  period: string | null;
  source_ref: string | null;
  content: string;
  metadata: any | null;
  embedding: number[];
  created_at: string;
}

const db: MockRecord[] = [];

function dotProduct(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

// Hook Pool.prototype.query
mock.method(pg.Pool.prototype, "query", async function (text: string, params: any[] = []) {
  const queryStr = text.trim().replace(/\s+/g, " ");

  // 1. DELETE FROM agent_memory
  if (queryStr.toUpperCase().startsWith("DELETE FROM AGENT_MEMORY")) {
    db.length = 0;
    return { rows: [] };
  }

  // 2. INSERT INTO agent_memory
  if (queryStr.toUpperCase().startsWith("INSERT INTO AGENT_MEMORY")) {
    const kind = params[0];
    const company = params[1] ?? "_global";
    const period = params[2] ?? null;
    const source_ref = params[3] ?? null;
    const content = params[4];
    const metadata = params[5] ? JSON.parse(params[5]) : null;
    const embeddingStr: string = params[6];
    const embedding = embeddingStr
      ? embeddingStr.slice(1, -1).split(",").map(Number)
      : [];

    const record: MockRecord = {
      id: "mock-id-" + Math.random().toString(36).substring(2, 10),
      kind,
      company,
      period,
      source_ref,
      content,
      metadata,
      embedding,
      created_at: new Date().toISOString(),
    };
    db.push(record);
    return { rows: [{ id: record.id }] };
  }

  // 3. SELECT count(*)
  if (queryStr.toUpperCase().startsWith("SELECT COUNT(*)")) {
    let filtered = [...db];
    const match = queryStr.match(/company\s*=\s*\$(\d+)/i);
    if (match) {
      const idx = parseInt(match[1]!, 10) - 1;
      const comp = params[idx];
      filtered = filtered.filter((r) => r.company === comp);
    }
    return { rows: [{ n: String(filtered.length) }] };
  }

  // 4. SELECT for vector recall or normal select
  if (queryStr.toUpperCase().startsWith("SELECT ID, KIND, COMPANY, PERIOD, SOURCE_REF, CONTENT, METADATA, CREATED_AT")) {
    let filtered = [...db];

    // Apply dynamic column filters: column = $N
    const filterMatches = [...queryStr.matchAll(/(\bcompany\b|\bperiod\b|\bkind\b)\s*=\s*\$(\d+)/gi)];
    for (const m of filterMatches) {
      const col = m[1]!.toLowerCase();
      const pIdx = parseInt(m[2]!, 10) - 1; // Correctly parse digits after $
      const val = params[pIdx];
      if (col === "company") {
        filtered = filtered.filter((r) => r.company === val);
      } else if (col === "period") {
        filtered = filtered.filter((r) => r.period === val);
      } else if (col === "kind") {
        filtered = filtered.filter((r) => r.kind === val);
      }
    }

    // Vector search distance calculation
    const isVectorRecall = queryStr.includes("<=>");
    let rows: any[] = [];

    if (isVectorRecall) {
      const qvecStr: string = params[0];
      const qvec = qvecStr ? qvecStr.slice(1, -1).split(",").map(Number) : [];

      rows = filtered.map((r) => {
        const dist = 1 - dotProduct(r.embedding, qvec);
        return {
          id: r.id,
          kind: r.kind,
          company: r.company,
          period: r.period,
          source_ref: r.source_ref,
          content: r.content,
          metadata: r.metadata,
          created_at: r.created_at,
          distance: String(dist),
        };
      });

      // Sort by distance ascending
      rows.sort((a, b) => Number(a.distance) - Number(b.distance));

      // Limit results
      const limitMatch = queryStr.match(/LIMIT\s+\$(\d+)/i);
      if (limitMatch) {
        const limitIdx = parseInt(limitMatch[1]!, 10) - 1;
        const limit = params[limitIdx] as number;
        rows = rows.slice(0, limit);
      }
    } else {
      // Normal select
      rows = filtered.map((r) => ({
        id: r.id,
        kind: r.kind,
        company: r.company,
        period: r.period,
        source_ref: r.source_ref,
        content: r.content,
        metadata: r.metadata,
        created_at: r.created_at,
      }));
    }

    return { rows };
  }

  throw new Error(`Unhandled mock query: ${queryStr}`);
});

// Mock Pool.prototype.connect
mock.method(pg.Pool.prototype, "connect", async function () {
  return {
    query: pg.Pool.prototype.query,
    release: () => {},
  };
});
