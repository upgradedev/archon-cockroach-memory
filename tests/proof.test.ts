import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPECTED_VECTOR_INDEX_NAME,
  indexDefinitionFingerprint,
  isExpectedVectorIndexDefinition,
} from "../src/db/proof.js";

const EXPECTED_V26_2_DEFINITION =
  `CREATE VECTOR INDEX ${EXPECTED_VECTOR_INDEX_NAME} ` +
  "ON archon.public.agent_memory USING cspann " +
  "(tenant_id ASC, embed_model ASC, status ASC, company ASC, " +
  "embedding vector_cosine_ops)";

test("accepts the canonical CockroachDB v26.2 company-scoped C-SPANN index", () => {
  assert.equal(
    isExpectedVectorIndexDefinition(EXPECTED_V26_2_DEFINITION),
    true
  );
  assert.match(
    indexDefinitionFingerprint(EXPECTED_V26_2_DEFINITION),
    /^[a-f0-9]{64}$/u
  );
});

test("accepts safe C-SPANN tuning options without weakening the key shape", () => {
  assert.equal(
    isExpectedVectorIndexDefinition(
      `${EXPECTED_V26_2_DEFINITION} WITH (min_partition_size = 16)`
    ),
    true
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
});
