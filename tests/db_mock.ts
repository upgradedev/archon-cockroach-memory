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
  tenant_id: string;
  kind: string;
  company: string;
  period: string | null;
  source_ref: string | null;
  content: string;
  metadata: any | null;
  embedding: number[];
  embed_model: string;
  idempotency_key: string | null;
  content_hash: string | null;
  status: "active" | "superseded" | "retracted";
  // The pg driver returns a TIMESTAMP column as a JS Date, not a string — mirror
  // that here so the mock exercises the same createdAt normalization as prod.
  created_at: Date;
}

const db: MockRecord[] = [];

function dotProduct(a: number[], b: number[]): number {
  if (
    a.length !== b.length ||
    a.some((value) => !Number.isFinite(value)) ||
    b.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Mock VECTOR operands must have equal finite dimensions.");
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
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

  // 2. Idempotency preflight / concurrent-winner lookup
  if (
    queryStr
      .toUpperCase()
      .startsWith("SELECT ID, CONTENT_HASH FROM AGENT_MEMORY")
  ) {
    const [tenant, model, key] = params;
    const found = db.find(
      (record) =>
        record.tenant_id === tenant &&
        record.embed_model === model &&
        record.idempotency_key === key
    );
    return {
      rows: found
        ? [{ id: found.id, content_hash: found.content_hash }]
        : [],
    };
  }

  // 3. INSERT INTO agent_memory
  if (queryStr.toUpperCase().startsWith("INSERT INTO AGENT_MEMORY")) {
    const scopedInsert = /\(\s*tenant_id\s*,/iu.test(queryStr);
    const tenant_id = scopedInsert ? params[0] : "public-demo";
    const offset = scopedInsert ? 1 : 0;
    const kind = params[offset];
    const company = params[offset + 1] ?? "_global";
    const period = params[offset + 2] ?? null;
    const source_ref = params[offset + 3] ?? null;
    const content = params[offset + 4];
    const metadata = params[offset + 5]
      ? JSON.parse(params[offset + 5])
      : null;
    const embeddingStr: string = params[offset + 6];
    const embedding = embeddingStr
      ? embeddingStr.slice(1, -1).split(",").map(Number)
      : [];
    const embed_model = params[offset + 7] ?? "test";
    const idempotency_key = scopedInsert ? params[offset + 8] ?? null : null;
    const content_hash = scopedInsert ? params[offset + 9] ?? null : null;

    if (idempotency_key !== null) {
      const conflict = db.find(
        (record) =>
          record.tenant_id === tenant_id &&
          record.embed_model === embed_model &&
          record.idempotency_key === idempotency_key
      );
      if (conflict) return { rows: [] };
    }

    const record: MockRecord = {
      id: "mock-id-" + Math.random().toString(36).substring(2, 10),
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
      content_hash,
      status: "active",
      created_at: new Date(),
    };
    db.push(record);
    return { rows: [{ id: record.id }] };
  }

  // 4. SELECT count(*)
  if (queryStr.toUpperCase().startsWith("SELECT COUNT(*)")) {
    let filtered = [...db];
    const filterMatches = [
      ...queryStr.matchAll(
        /(\btenant_id\b|\bcompany\b|\bperiod\b|\bkind\b|\bstatus\b|\bembed_model\b)\s*=\s*\$(\d+)/giu
      ),
    ];
    for (const match of filterMatches) {
      const column = match[1]!.toLowerCase() as keyof MockRecord;
      const index = Number(match[2]) - 1;
      filtered = filtered.filter((record) => record[column] === params[index]);
    }
    return { rows: [{ n: String(filtered.length) }] };
  }

  // 5. SELECT for vector recall or normal select
  if (queryStr.toUpperCase().startsWith("SELECT ID, KIND, COMPANY, PERIOD, SOURCE_REF, CONTENT, METADATA, CREATED_AT")) {
    let filtered = [...db];

    // Apply dynamic column filters: column = $N
    const filterMatches = [
      ...queryStr.matchAll(
        /(\btenant_id\b|\bembed_model\b|\bstatus\b|\bcompany\b|\bperiod\b|\bkind\b)\s*=\s*\$(\d+)/giu
      ),
    ];
    for (const m of filterMatches) {
      const col = m[1]!.toLowerCase();
      const pIdx = parseInt(m[2]!, 10) - 1; // Correctly parse digits after $
      const val = params[pIdx];
      filtered = filtered.filter(
        (record) => record[col as keyof MockRecord] === val
      );
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
      filtered.sort(
        (a, b) => b.created_at.getTime() - a.created_at.getTime()
      );
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

      const limitMatch = queryStr.match(/LIMIT\s+\$(\d+)/iu);
      if (limitMatch) {
        const limitIdx = Number(limitMatch[1]) - 1;
        rows = rows.slice(0, params[limitIdx] as number);
      }
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
