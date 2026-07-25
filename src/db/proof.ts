import { createHash } from "node:crypto";

export const EXPECTED_VECTOR_INDEX_NAME =
  "idx_agent_memory_company_scope_embedding";
export const EXPECTED_KIND_VECTOR_INDEX_NAME =
  "idx_agent_memory_company_kind_scope_embedding";
export const PUBLIC_RECALL_VIEW_NAME = "archon_public_memory_recall";
export const PUBLIC_KIND_RECALL_VIEW_NAME =
  "archon_public_memory_kind_recall";
export const PUBLIC_RECALL_VIEW_OWNER =
  "archon_public_memory_view_owner";

export function normalizeIndexDefinition(definition: string): string {
  return definition
    .toLowerCase()
    .replaceAll('"', "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function isExpectedVectorIndexDefinition(
  definition: string,
  expectedDatabase = "archon"
): boolean {
  return isExpectedScopedVectorIndexDefinition(
    definition,
    EXPECTED_VECTOR_INDEX_NAME,
    ["tenant_id", "embed_model", "status", "company"],
    expectedDatabase
  );
}

export function isExpectedKindVectorIndexDefinition(
  definition: string,
  expectedDatabase = "archon"
): boolean {
  return isExpectedScopedVectorIndexDefinition(
    definition,
    EXPECTED_KIND_VECTOR_INDEX_NAME,
    ["tenant_id", "embed_model", "status", "company", "kind"],
    expectedDatabase
  );
}

function isExpectedScopedVectorIndexDefinition(
  definition: string,
  indexName: string,
  prefixColumns: string[],
  expectedDatabase: string
): boolean {
  if (definition.includes('"')) return false;
  const normalized = normalizeIndexDefinition(definition);
  const database = escapeRegExp(
    expectedDatabase.toLowerCase().replaceAll('"', "")
  );
  const target =
    `(?:${database}\\.public\\.|public\\.)?agent_memory`;
  const vectorIndexHead =
    `(?:vector index ${indexName} on ${target}` +
    `(?: using cspann)?|index ${indexName} on ${target}` +
    " using cspann)";
  const prefix = prefixColumns
    .map((column) => `${column}(?:\\s+asc)?\\s*,\\s*`)
    .join("");
  const expected = new RegExp(
    `^create ${vectorIndexHead} ` +
      `\\(\\s*${prefix}` +
      "embedding\\s+vector_cosine_ops(?:\\s+asc)?\\s*\\)" +
      "(?: with \\([^();]+\\))?$",
    "u"
  );
  return expected.test(normalized);
}

export function normalizeViewDefinition(definition: string): string {
  return definition
    .toLowerCase()
    .replaceAll('"', "")
    .replace(
      /\b(?:[a-z0-9_]+\.)?(?:public\.)?agent_memory\./gu,
      ""
    )
    .replace(
      /@\{\s*force_index\s*=\s*([a-z0-9_]+)\s*\}/gu,
      "@$1"
    )
    .replace(/:{2,3}(?:string|text)\b/gu, "")
    .replace(/[()]/gu, "")
    .replace(/\s*,\s*/gu, ", ")
    .replace(/\s*=\s*/gu, " = ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function isExpectedPublicRecallViewDefinition(
  definition: string,
  kindScoped: boolean,
  expectedDatabase = "archon"
): boolean {
  if (definition.includes('"')) return false;
  const normalized = normalizeViewDefinition(definition);
  const indexName = kindScoped
    ? EXPECTED_KIND_VECTOR_INDEX_NAME
    : EXPECTED_VECTOR_INDEX_NAME;
  const database = escapeRegExp(
    expectedDatabase.toLowerCase().replaceAll('"', "")
  );
  const target =
    `(?:${database}\\.public\\.|public\\.)?agent_memory@${indexName}`;
  const columns = [
    "id",
    "tenant_id",
    "kind",
    "company",
    "period",
    "source_ref",
    "content",
    "metadata",
    "embedding",
    "embed_model",
    "idempotency_key",
    "status",
    "created_at",
  ].join(", ");
  return new RegExp(
    `^select ${columns} from ${target} ` +
      "where tenant_id = 'public-demo' " +
      "and company = 'helios sa' and status = 'active'$",
    "u"
  ).test(normalized);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function indexDefinitionFingerprint(definition: string): string {
  return createHash("sha256")
    .update(normalizeIndexDefinition(definition), "utf8")
    .digest("hex");
}
