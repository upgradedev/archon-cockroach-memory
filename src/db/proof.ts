import { createHash } from "node:crypto";

export const EXPECTED_VECTOR_INDEX_NAME =
  "idx_agent_memory_company_scope_embedding";

export function normalizeIndexDefinition(definition: string): string {
  return definition
    .toLowerCase()
    .replaceAll('"', "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function isExpectedVectorIndexDefinition(
  definition: string
): boolean {
  const normalized = normalizeIndexDefinition(definition);
  const target =
    "(?:[a-z0-9_]+\\.)?(?:public\\.)?agent_memory";
  const vectorIndexHead =
    `(?:vector index ${EXPECTED_VECTOR_INDEX_NAME} on ${target}` +
    `(?: using cspann)?|index ${EXPECTED_VECTOR_INDEX_NAME} on ${target}` +
    " using cspann)";
  const expected = new RegExp(
    `^create ${vectorIndexHead} ` +
      "\\(\\s*tenant_id(?:\\s+asc)?\\s*,\\s*" +
      "embed_model(?:\\s+asc)?\\s*,\\s*" +
      "status(?:\\s+asc)?\\s*,\\s*" +
      "company(?:\\s+asc)?\\s*,\\s*" +
      "embedding\\s+vector_cosine_ops(?:\\s+asc)?\\s*\\)" +
      "(?: with \\([^;]+\\))?$",
    "u"
  );
  return expected.test(normalized);
}

export function indexDefinitionFingerprint(definition: string): string {
  return createHash("sha256")
    .update(normalizeIndexDefinition(definition), "utf8")
    .digest("hex");
}
