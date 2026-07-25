import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPECTED_KIND_VECTOR_INDEX_NAME,
  EXPECTED_VECTOR_INDEX_NAME,
  indexDefinitionFingerprint,
  isExpectedKindVectorIndexDefinition,
  isExpectedPublicRecallViewDefinition,
  isExpectedVectorIndexDefinition,
} from "../src/db/proof.js";

const EXPECTED_V26_2_DEFINITION =
  `CREATE VECTOR INDEX ${EXPECTED_VECTOR_INDEX_NAME} ` +
  "ON archon.public.agent_memory " +
  "(tenant_id ASC, embed_model ASC, status ASC, company ASC, " +
  "embedding vector_cosine_ops)";
const EXPECTED_KIND_V26_2_DEFINITION =
  `CREATE VECTOR INDEX ${EXPECTED_KIND_VECTOR_INDEX_NAME} ` +
  "ON archon.public.agent_memory " +
  "(tenant_id ASC, embed_model ASC, status ASC, company ASC, kind ASC, " +
  "embedding vector_cosine_ops)";
const VIEW_COLUMNS =
  "id, tenant_id, kind, company, period, source_ref, content, metadata, " +
  "embedding, embed_model, idempotency_key, status, created_at";

function publicViewDefinition(indexName: string): string {
  return (
    `SELECT ${VIEW_COLUMNS} ` +
    `FROM archon.public.agent_memory@{FORCE_INDEX=${indexName}} ` +
    "WHERE (tenant_id = 'public-demo':::STRING) " +
    "AND (company = 'Helios SA':::STRING) " +
    "AND (status = 'active':::STRING)"
  );
}

test("accepts the canonical CockroachDB v26.2 company-scoped C-SPANN index", () => {
  assert.equal(
    isExpectedVectorIndexDefinition(EXPECTED_V26_2_DEFINITION),
    true
  );
  assert.match(
    indexDefinitionFingerprint(EXPECTED_V26_2_DEFINITION),
    /^[a-f0-9]{64}$/u
  );
  const renamedDatabase = EXPECTED_V26_2_DEFINITION.replace(
    "archon.public",
    "release_db.public"
  );
  assert.equal(
    isExpectedVectorIndexDefinition(renamedDatabase, "release_db"),
    true
  );
  assert.equal(isExpectedVectorIndexDefinition(renamedDatabase), false);
});

test("accepts the explicit USING cspann compatibility form", () => {
  assert.equal(
    isExpectedVectorIndexDefinition(
      EXPECTED_V26_2_DEFINITION.replace(
        "agent_memory (",
        "agent_memory USING cspann ("
      )
    ),
    true
  );
});

test("accepts the pg_catalog.pg_indexes C-SPANN representation", () => {
  assert.equal(
    isExpectedVectorIndexDefinition(
      EXPECTED_V26_2_DEFINITION
        .replace("CREATE VECTOR INDEX", "CREATE INDEX")
        .replace("agent_memory (", "agent_memory USING cspann (")
    ),
    true
  );
});

test("accepts safe C-SPANN tuning options without weakening the key shape", () => {
  assert.equal(
    isExpectedVectorIndexDefinition(
      `${EXPECTED_V26_2_DEFINITION} ` +
        "WITH (min_partition_size = 16, max_partition_size = 256)"
    ),
    true
  );
});

test("accepts the exact kind-prefixed C-SPANN index in both catalog forms", () => {
  assert.equal(
    isExpectedKindVectorIndexDefinition(EXPECTED_KIND_V26_2_DEFINITION),
    true
  );
  assert.equal(
    isExpectedKindVectorIndexDefinition(
      EXPECTED_KIND_V26_2_DEFINITION
        .replace("CREATE VECTOR INDEX", "CREATE INDEX")
        .replace("agent_memory (", "agent_memory USING cspann (")
    ),
    true
  );
});

test("rejects suffix injection after otherwise safe C-SPANN tuning options", () => {
  for (const suffix of [
    "WITH (min_partition_size = 16) WHERE status = 'active'",
    "WITH (min_partition_size = 16) STORING (content)",
    "WITH ((min_partition_size = 16))",
    "WITH (min_partition_size = 16; DROP TABLE agent_memory)",
  ]) {
    assert.equal(
      isExpectedVectorIndexDefinition(
        `${EXPECTED_V26_2_DEFINITION} ${suffix}`
      ),
      false,
      suffix
    );
    assert.equal(
      isExpectedKindVectorIndexDefinition(
        `${EXPECTED_KIND_V26_2_DEFINITION} ${suffix}`
      ),
      false,
      suffix
    );
  }
});

test("accepts only the exact fixed-scope serving-view definitions", () => {
  assert.equal(
    isExpectedPublicRecallViewDefinition(
      publicViewDefinition(EXPECTED_VECTOR_INDEX_NAME),
      false
    ),
    true
  );
  assert.equal(
    isExpectedPublicRecallViewDefinition(
      publicViewDefinition(EXPECTED_KIND_VECTOR_INDEX_NAME),
      true
    ),
    true
  );
  assert.equal(
    isExpectedPublicRecallViewDefinition(
      publicViewDefinition(EXPECTED_VECTOR_INDEX_NAME).replace(
        "archon.public.agent_memory",
        "evil.agent_memory"
      ),
      false
    ),
    false
  );
  assert.equal(
    isExpectedPublicRecallViewDefinition(
      publicViewDefinition(EXPECTED_VECTOR_INDEX_NAME).replace(
        "archon.public.agent_memory",
        "evil.public.agent_memory"
      ),
      false
    ),
    false
  );
  assert.equal(
    isExpectedPublicRecallViewDefinition(
      publicViewDefinition(EXPECTED_VECTOR_INDEX_NAME).replace(
        "archon.public.agent_memory",
        '"ARCHON".public.agent_memory'
      ),
      false
    ),
    false
  );
  assert.equal(
    isExpectedPublicRecallViewDefinition(
      publicViewDefinition(EXPECTED_VECTOR_INDEX_NAME).replace(
        "tenant_id =",
        '"TENANT_ID" ='
      ),
      false
    ),
    false
  );
  assert.equal(
    isExpectedPublicRecallViewDefinition(
      `${publicViewDefinition(EXPECTED_VECTOR_INDEX_NAME)} OR true`,
      false
    ),
    false
  );
});

test("rejects partial, differently scoped, or differently measured indexes", () => {
  assert.equal(
    isExpectedVectorIndexDefinition(
      `${EXPECTED_V26_2_DEFINITION} WHERE status = 'active'`
    ),
    false
  );
  assert.equal(
    isExpectedVectorIndexDefinition(
      EXPECTED_V26_2_DEFINITION.replace(
        "tenant_id ASC, embed_model ASC, status ASC, company ASC",
        "company ASC, tenant_id ASC, embed_model ASC, status ASC"
      )
    ),
    false
  );
  assert.equal(
    isExpectedVectorIndexDefinition(
      EXPECTED_V26_2_DEFINITION.replace(
        "vector_cosine_ops",
        "vector_l2_ops"
      )
    ),
    false
  );
  assert.equal(
    isExpectedVectorIndexDefinition(
      EXPECTED_V26_2_DEFINITION.replace(
        "CREATE VECTOR INDEX",
        "CREATE INDEX"
      )
    ),
    false
  );
  assert.equal(
    isExpectedKindVectorIndexDefinition(
      EXPECTED_KIND_V26_2_DEFINITION.replace(
        "company ASC, kind ASC",
        "kind ASC, company ASC"
      )
    ),
    false
  );
  assert.equal(
    isExpectedVectorIndexDefinition(
      EXPECTED_V26_2_DEFINITION.replace(
        "archon.public.agent_memory",
        "evil.agent_memory"
      )
    ),
    false
  );
  assert.equal(
    isExpectedVectorIndexDefinition(
      EXPECTED_V26_2_DEFINITION.replace(
        "archon.public.agent_memory",
        "evil.public.agent_memory"
      )
    ),
    false
  );
  assert.equal(
    isExpectedVectorIndexDefinition(
      EXPECTED_V26_2_DEFINITION.replace(
        "archon.public.agent_memory",
        '"ARCHON".public.agent_memory'
      )
    ),
    false
  );
  assert.equal(
    isExpectedVectorIndexDefinition(
      EXPECTED_V26_2_DEFINITION.replace(
        "tenant_id ASC",
        '"TENANT_ID" ASC'
      )
    ),
    false
  );
  assert.equal(
    isExpectedKindVectorIndexDefinition(
      EXPECTED_KIND_V26_2_DEFINITION.replace(", kind ASC", "")
    ),
    false
  );
});
