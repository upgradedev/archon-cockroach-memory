// Descriptor-backed and source-bound verification for CockroachDB routines.
//
// CockroachDB v26.2.3's PostgreSQL-compatibility pg_proc currently exposes
// prosecdef=false for user-defined routines regardless of their descriptor.
// SHOW CREATE FUNCTION is generated from that descriptor and preserves the
// actual security mode. Cockroach also parses and re-formats PL/pgSQL bodies,
// fully qualifies relation names, and may remove pg_catalog from built-ins.

export function isExpectedResolutionRoutineCreateStatement(
  createStatement: string,
  routineName: string
): boolean {
  const visibleDeclaration = routineCreateVisibleDeclaration(createStatement);
  if (visibleDeclaration === null) return false;
  const declaration = visibleDeclaration.replace(/\s+/gu, " ").trim();

  // Inspect only the canonical declaration emitted by SHOW CREATE FUNCTION.
  // Quoted defaults and the function body are masked, so option-like text in
  // either can never spoof descriptor-backed metadata.
  const escapedRoutineName = routineName.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&"
  );
  const declaresExpectedFunction = new RegExp(
    `^CREATE FUNCTION\\s+(?:[^\\s.()]+\\.)?public\\.${escapedRoutineName}\\s*\\(`,
    "iu"
  ).test(declaration);
  const securityModes =
    declaration.match(/\bSECURITY\s+(?:DEFINER|INVOKER)\b/giu) ?? [];
  const languages =
    declaration.match(/\bLANGUAGE\s+(?:PLPGSQL|SQL)\b/giu) ?? [];
  const volatility =
    declaration.match(/\b(?:IMMUTABLE|STABLE|VOLATILE)\b/giu) ?? [];

  return (
    declaresExpectedFunction &&
    securityModes.length === 1 &&
    /^SECURITY\s+DEFINER$/iu.test(securityModes[0]!) &&
    languages.length === 1 &&
    /^LANGUAGE\s+PLPGSQL$/iu.test(languages[0]!) &&
    volatility.length === 1 &&
    /^VOLATILE$/iu.test(volatility[0]!)
  );
}

type RoutineToken = {
  kind:
    | "identifier"
    | "number"
    | "quoted-identifier"
    | "string"
    | "symbol";
  value: string;
};

type ResolutionRoutineName =
  | "archon_resolution_create_session"
  | "archon_resolution_decide";

type RoutineInspectionMode = "runtime" | "source";

type RelationReference = {
  operation: "from" | "insert" | "join" | "update";
  path: readonly string[];
  terminalIndex: number;
};

type RoutineCall = {
  path: readonly string[];
  functionIndex: number;
  argumentTokens: readonly RoutineToken[] | null;
};

type RoutineContract = {
  relations: Readonly<Record<string, number>>;
  sourceCalls: Readonly<Record<string, number>>;
  runtimeCalls: Readonly<Record<string, number>>;
  returns: Readonly<Record<string, number>>;
  selectStatements: number;
  insertStatements: number;
  updateStatements: number;
  runtimeDuplicateNowTimestamptzCasts: number;
};

export type ResolutionRoutineBodyEvidence = {
  matches: boolean;
  missingRuleIds: readonly string[];
};

export type ResolutionRoutineRuntimeEvidence =
  ResolutionRoutineBodyEvidence & {
    diagnostics: {
      normalizationVersion: "cockroach-v26.2.3-fmt-parsable-exact-v2";
      sourceNormalizedTokenCount: number | null;
      runtimeNormalizedTokenCount: number | null;
      expectedRuntimeDuplicateNowTimestamptzCastCount: number | null;
      observedRuntimeDuplicateNowTimestamptzCastCount: number | null;
      firstMismatchIndex: number | null;
      sourceTokenKindAtMismatch: string | null;
      runtimeTokenKindAtMismatch: string | null;
    };
  };

const ROUTINE_CONTRACTS: Readonly<
  Record<ResolutionRoutineName, RoutineContract>
> = {
  archon_resolution_create_session: {
    relations: {
      memory_demo_sessions: 2,
      memory_resolution_observations: 1,
      memory_resolution_proposals: 1,
    },
    sourceCalls: {
      "pg_catalog.count": 1,
      "pg_catalog.now": 3,
    },
    runtimeCalls: {
      count: 1,
      now: 3,
    },
    returns: {
      capacity: 1,
      created: 1,
      invalid: 1,
    },
    selectStatements: 1,
    insertStatements: 3,
    updateStatements: 0,
    runtimeDuplicateNowTimestamptzCasts: 2,
  },
  archon_resolution_decide: {
    relations: {
      memory_demo_sessions: 2,
      memory_resolution_consolidations: 1,
      memory_resolution_decisions: 2,
      memory_resolution_observations: 2,
      memory_resolution_proposals: 2,
    },
    sourceCalls: {
      "pg_catalog.now": 3,
      "pg_catalog.sha256": 1,
      "pg_catalog.timezone": 1,
      "pg_catalog.to_char": 1,
    },
    runtimeCalls: {
      now: 3,
      sha256: 1,
      timezone: 1,
      to_char: 1,
    },
    returns: {
      applied: 1,
      conflict: 3,
      invalid: 1,
      not_found: 1,
      replayed: 1,
    },
    selectStatements: 3,
    insertStatements: 2,
    updateStatements: 4,
    runtimeDuplicateNowTimestamptzCasts: 1,
  },
};

const BUILTIN_NAMES = new Set([
  "count",
  "now",
  "sha256",
  "timezone",
  "to_char",
]);

const NON_CALL_PARENTHESIS_KEYWORDS = new Set([
  "and",
  "else",
  "if",
  "in",
  "or",
  "values",
  "where",
]);

const FORBIDDEN_BODY_IDENTIFIERS = new Set([
  "alter",
  "call",
  "copy",
  "create",
  "delete",
  "drop",
  "execute",
  "grant",
  "perform",
  "raise",
  "revoke",
  "truncate",
]);

function asResolutionRoutineName(
  routineName: string
): ResolutionRoutineName | null {
  return routineName === "archon_resolution_create_session" ||
    routineName === "archon_resolution_decide"
    ? routineName
    : null;
}

function tokenizeRoutineBody(body: string): RoutineToken[] | null {
  const tokens: RoutineToken[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const character = body[cursor]!;
    const next = body[cursor + 1];

    if (/\s/u.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      cursor += 2;
      while (cursor < body.length && body[cursor] !== "\n") cursor += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      cursor += 2;
      let depth = 1;
      while (cursor < body.length && depth > 0) {
        if (body[cursor] === "/" && body[cursor + 1] === "*") {
          depth += 1;
          cursor += 2;
        } else if (body[cursor] === "*" && body[cursor + 1] === "/") {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (depth !== 0) return null;
      continue;
    }
    const escapedString =
      (character === "e" || character === "E") &&
      next === "'" &&
      (cursor === 0 || !/[A-Za-z0-9_$]/u.test(body[cursor - 1]!));
    if (character === "'" || escapedString) {
      cursor += escapedString ? 2 : 1;
      let value = "";
      let terminated = false;
      while (cursor < body.length) {
        if (escapedString && body[cursor] === "\\" && cursor + 1 < body.length) {
          value += body[cursor + 1]!;
          cursor += 2;
          continue;
        }
        if (body[cursor] === "'" && body[cursor + 1] === "'") {
          value += "'";
          cursor += 2;
        } else if (body[cursor] === "'") {
          cursor += 1;
          terminated = true;
          break;
        } else {
          value += body[cursor]!;
          cursor += 1;
        }
      }
      if (!terminated) return null;
      tokens.push({ kind: "string", value });
      continue;
    }
    if (character === '"') {
      cursor += 1;
      let value = "";
      let terminated = false;
      while (cursor < body.length) {
        if (body[cursor] === '"' && body[cursor + 1] === '"') {
          value += '"';
          cursor += 2;
        } else if (body[cursor] === '"') {
          cursor += 1;
          terminated = true;
          break;
        } else {
          value += body[cursor]!;
          cursor += 1;
        }
      }
      if (!terminated) return null;
      // Quoted identifiers are case-sensitive SQL names. Never fold them into
      // the same token as an unquoted identifier: e.g. "PG_CATALOG" is not
      // the trusted pg_catalog schema.
      tokens.push({ kind: "quoted-identifier", value });
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      const start = cursor;
      cursor += 1;
      while (cursor < body.length && /[A-Za-z0-9_$]/u.test(body[cursor]!)) {
        cursor += 1;
      }
      tokens.push({
        kind: "identifier",
        value: body.slice(start, cursor).toLowerCase(),
      });
      continue;
    }
    if (/[0-9]/u.test(character)) {
      const start = cursor;
      cursor += 1;
      while (cursor < body.length && /[0-9]/u.test(body[cursor]!)) cursor += 1;
      tokens.push({ kind: "number", value: body.slice(start, cursor) });
      continue;
    }

    tokens.push({ kind: "symbol", value: character });
    cursor += 1;
  }
  return tokens;
}

function isEscapeStringQuote(source: string, quoteIndex: number): boolean {
  if (source[quoteIndex] !== "'" || quoteIndex === 0) return false;
  const prefix = source[quoteIndex - 1];
  return (
    (prefix === "e" || prefix === "E") &&
    (quoteIndex === 1 ||
      !/[A-Za-z0-9_$]/u.test(source[quoteIndex - 2]!))
  );
}

// Splits only real top-level SQL statements. Comments are removed outside
// quoted regions; strings and dollar bodies are copied atomically. A fake
// CREATE FUNCTION inside a comment, string, or DO body can never become a
// candidate definition.
function splitTopLevelSqlStatements(source: string): string[] | null {
  const statements: string[] = [];
  let statement = "";
  let cursor = 0;

  while (cursor < source.length) {
    const character = source[cursor]!;
    const next = source[cursor + 1];

    if (character === "-" && next === "-") {
      cursor += 2;
      while (cursor < source.length && source[cursor] !== "\n") cursor += 1;
      statement += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      cursor += 2;
      let depth = 1;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === "/" && source[cursor + 1] === "*") {
          depth += 1;
          cursor += 2;
        } else if (source[cursor] === "*" && source[cursor + 1] === "/") {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (depth !== 0) return null;
      statement += " ";
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      const backslashEscapes = isEscapeStringQuote(source, cursor);
      let terminated = false;
      statement += character;
      cursor += 1;
      while (cursor < source.length) {
        statement += source[cursor]!;
        if (
          backslashEscapes &&
          source[cursor] === "\\" &&
          cursor + 1 < source.length
        ) {
          statement += source[cursor + 1]!;
          cursor += 2;
          continue;
        }
        if (source[cursor] === quote && source[cursor + 1] === quote) {
          statement += source[cursor + 1]!;
          cursor += 2;
          continue;
        }
        if (source[cursor] === quote) {
          cursor += 1;
          terminated = true;
          break;
        }
        cursor += 1;
      }
      if (!terminated) return null;
      continue;
    }
    if (character === "$") {
      const delimiter = source.slice(cursor).match(/^\$[A-Za-z_0-9]*\$/u)?.[0];
      if (delimiter) {
        const closing = source.indexOf(delimiter, cursor + delimiter.length);
        if (closing < 0) return null;
        const end = closing + delimiter.length;
        statement += source.slice(cursor, end);
        cursor = end;
        continue;
      }
    }
    if (character === ";") {
      const trimmed = statement.trim();
      if (trimmed) statements.push(trimmed);
      statement = "";
      cursor += 1;
      continue;
    }
    statement += character;
    cursor += 1;
  }

  const trailing = statement.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function dollarQuotedSegments(
  statement: string
): readonly { body: string; end: number; start: number }[] | null {
  const segments: { body: string; end: number; start: number }[] = [];
  let cursor = 0;
  while (cursor < statement.length) {
    const character = statement[cursor]!;
    if (character === "'" || character === '"') {
      const quote = character;
      const backslashEscapes = isEscapeStringQuote(statement, cursor);
      let terminated = false;
      cursor += 1;
      while (cursor < statement.length) {
        if (
          backslashEscapes &&
          statement[cursor] === "\\" &&
          cursor + 1 < statement.length
        ) {
          cursor += 2;
          continue;
        }
        if (statement[cursor] === quote && statement[cursor + 1] === quote) {
          cursor += 2;
          continue;
        }
        if (statement[cursor] === quote) {
          cursor += 1;
          terminated = true;
          break;
        }
        cursor += 1;
      }
      if (!terminated) return null;
      continue;
    }
    if (character === "$") {
      const delimiter = statement
        .slice(cursor)
        .match(/^\$[A-Za-z_0-9]*\$/u)?.[0];
      if (delimiter) {
        const closing = statement.indexOf(
          delimiter,
          cursor + delimiter.length
        );
        if (closing < 0) return null;
        segments.push({
          body: statement.slice(cursor + delimiter.length, closing),
          end: closing + delimiter.length,
          start: cursor,
        });
        cursor = closing + delimiter.length;
        continue;
      }
    }
    cursor += 1;
  }
  return segments;
}

function visibleSqlCode(source: string): string | null {
  let visible = "";
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor]!;
    const next = source[cursor + 1];
    if (character === "-" && next === "-") {
      cursor += 2;
      while (cursor < source.length && source[cursor] !== "\n") cursor += 1;
      visible += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      cursor += 2;
      let depth = 1;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === "/" && source[cursor + 1] === "*") {
          depth += 1;
          cursor += 2;
        } else if (source[cursor] === "*" && source[cursor + 1] === "/") {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (depth !== 0) return null;
      visible += " ";
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      const backslashEscapes = isEscapeStringQuote(source, cursor);
      cursor += 1;
      let terminated = false;
      while (cursor < source.length) {
        if (
          backslashEscapes &&
          source[cursor] === "\\" &&
          cursor + 1 < source.length
        ) {
          cursor += 2;
          continue;
        }
        if (source[cursor] === quote && source[cursor + 1] === quote) {
          cursor += 2;
          continue;
        }
        if (source[cursor] === quote) {
          cursor += 1;
          terminated = true;
          break;
        }
        cursor += 1;
      }
      if (!terminated) return null;
      visible += " ";
      continue;
    }
    if (character === "$") {
      const delimiter = source.slice(cursor).match(/^\$[A-Za-z_0-9]*\$/u)?.[0];
      if (delimiter) {
        const closing = source.indexOf(delimiter, cursor + delimiter.length);
        if (closing < 0) return null;
        cursor = closing + delimiter.length;
        visible += " ";
        continue;
      }
    }
    visible += character;
    cursor += 1;
  }
  return visible;
}

function routineCreateVisibleDeclaration(
  createStatement: string
): string | null {
  const statements = splitTopLevelSqlStatements(createStatement);
  if (!statements || statements.length !== 1) return null;
  const statement = statements[0]!;
  const segments = dollarQuotedSegments(statement);
  if (!segments) return null;
  const bodySegments = segments.filter(
    (segment) =>
      /\bAS\s*$/iu.test(statement.slice(0, segment.start)) &&
      statement.slice(segment.end).trim() === ""
  );
  if (bodySegments.length !== 1) return null;
  return visibleSqlCode(statement.slice(0, bodySegments[0]!.start));
}

function resolutionRoutineSourceBody(
  schemaSource: string,
  routineName: ResolutionRoutineName
): {
  body: string | null;
  definitionCount: number;
  sourceParseable: boolean;
} {
  const statements = splitTopLevelSqlStatements(schemaSource);
  if (!statements) {
    return { body: null, definitionCount: 0, sourceParseable: false };
  }
  const escapedRoutineName = routineName.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&"
  );
  const declaration = new RegExp(
    `^CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${escapedRoutineName}\\s*\\(`,
    "iu"
  );
  const definitions = statements.filter((statement) =>
    declaration.test(statement)
  );
  if (definitions.length !== 1) {
    return {
      body: null,
      definitionCount: definitions.length,
      sourceParseable: true,
    };
  }

  const segments = dollarQuotedSegments(definitions[0]!);
  if (!segments) {
    return { body: null, definitionCount: 1, sourceParseable: false };
  }
  const bodySegments = segments.filter(
    (segment) =>
      /\bAS\s*$/iu.test(definitions[0]!.slice(0, segment.start)) &&
      definitions[0]!.slice(segment.end).trim() === ""
  );
  return {
    body: bodySegments.length === 1 ? bodySegments[0]!.body : null,
    definitionCount: 1,
    sourceParseable: true,
  };
}

function identifierPathAt(
  tokens: readonly RoutineToken[],
  start: number
): { end: number; path: readonly string[] } | null {
  if (tokens[start]?.kind !== "identifier") return null;
  const path = [tokens[start]!.value];
  let end = start;
  while (
    tokens[end + 1]?.value === "." &&
    tokens[end + 2]?.kind === "identifier"
  ) {
    path.push(tokens[end + 2]!.value);
    end += 2;
  }
  return { end, path };
}

function relationReferences(
  tokens: readonly RoutineToken[]
): readonly RelationReference[] {
  const references: RelationReference[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "identifier") continue;

    let operation: RelationReference["operation"] | null = null;
    if (token.value === "from") operation = "from";
    if (token.value === "join") operation = "join";
    if (
      token.value === "update" &&
      tokens[index - 1]?.value !== "for"
    ) {
      operation = "update";
    }
    if (
      token.value === "into" &&
      tokens[index - 1]?.value === "insert"
    ) {
      operation = "insert";
    }
    if (!operation) continue;

    const path = identifierPathAt(tokens, index + 1);
    references.push({
      operation,
      path: path?.path ?? [],
      terminalIndex: path?.end ?? -1,
    });
  }
  return references;
}

function callPathAt(
  tokens: readonly RoutineToken[],
  functionIndex: number
): readonly string[] {
  let start = functionIndex;
  while (
    tokens[start - 1]?.value === "." &&
    tokens[start - 2]?.kind === "identifier"
  ) {
    start -= 2;
  }
  const path: string[] = [];
  for (let index = start; index <= functionIndex; index += 2) {
    path.push(tokens[index]!.value);
  }
  return path;
}

function callArguments(
  tokens: readonly RoutineToken[],
  functionIndex: number
): readonly RoutineToken[] | null {
  const opening = functionIndex + 1;
  if (tokens[opening]?.value !== "(") return null;
  let depth = 0;
  for (let index = opening; index < tokens.length; index += 1) {
    if (tokens[index]?.value === "(") depth += 1;
    if (tokens[index]?.value === ")") {
      depth -= 1;
      if (depth === 0) return tokens.slice(opening + 1, index);
    }
  }
  return null;
}

function routineCalls(
  tokens: readonly RoutineToken[],
  relations: readonly RelationReference[]
): readonly RoutineCall[] {
  const relationTerminals = new Set(
    relations.map((reference) => reference.terminalIndex)
  );
  const calls: RoutineCall[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      token?.kind !== "identifier" ||
      tokens[index + 1]?.value !== "(" ||
      relationTerminals.has(index)
    ) {
      continue;
    }
    const path = callPathAt(tokens, index);
    // CockroachDB's FmtParsable output places grouping parentheses directly
    // after these PL/pgSQL/SQL grammar tokens. Exclude only an unqualified
    // keyword: attacker.if(...) and every other qualified/unknown call remain
    // visible to the closed call contract.
    if (
      path.length === 1 &&
      NON_CALL_PARENTHESIS_KEYWORDS.has(token.value)
    ) {
      continue;
    }
    calls.push({
      path,
      functionIndex: index,
      argumentTokens: callArguments(tokens, index),
    });
  }
  return calls;
}

function counted(values: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function exactCounts(
  actual: Readonly<Record<string, number>>,
  expected: Readonly<Record<string, number>>
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => actual[key] === expected[key])
  );
}

function canonicalRelationName(
  reference: RelationReference,
  mode: RoutineInspectionMode,
  databaseName: string | null
): string {
  if (
    reference.path.length === 2 &&
    reference.path[0] === "public"
  ) {
    return reference.path[1]!;
  }
  if (
    mode === "runtime" &&
    databaseName !== null &&
    reference.path.length === 3 &&
    reference.path[0] === databaseName.toLowerCase() &&
    reference.path[1] === "public"
  ) {
    return reference.path[2]!;
  }
  return `!${reference.path.join(".")}`;
}

function canonicalCallName(
  call: RoutineCall,
  mode: RoutineInspectionMode
): string {
  const path = call.path;
  if (mode === "source") return path.join(".");
  if (path.length === 1 && BUILTIN_NAMES.has(path[0]!)) return path[0]!;
  if (
    path.length === 2 &&
    path[0] === "pg_catalog" &&
    BUILTIN_NAMES.has(path[1]!)
  ) {
    return path[1]!;
  }
  return `!${path.join(".")}`;
}

function exactSha256Argument(
  calls: readonly RoutineCall[],
  mode: RoutineInspectionMode
): boolean {
  const shaCalls = calls.filter(
    (call) => call.path.at(-1) === "sha256"
  );
  if (shaCalls.length !== 1) return false;
  const args = shaCalls[0]!.argumentTokens;
  if (!args || args[0]?.kind !== "identifier") return false;
  if (args[0].value !== "v_receipt_canonical") return false;
  if (args.length === 1) return true;
  if (mode !== "runtime") return false;

  let colonCount = 0;
  while (args[1 + colonCount]?.value === ":") colonCount += 1;
  return (
    (colonCount === 2 || colonCount === 3) &&
    args.length === colonCount + 2 &&
    args[1 + colonCount]?.kind === "identifier" &&
    args[1 + colonCount]?.value === "string"
  );
}

function hasReceiptActorAssignment(tokens: readonly RoutineToken[]): boolean {
  const assignmentIndexes = tokens.flatMap((token, index) =>
    token.kind === "identifier" &&
    token.value === "v_receipt_canonical" &&
    tokens[index + 1]?.value === ":" &&
    tokens[index + 2]?.value === "="
      ? [index]
      : []
  );
  if (assignmentIndexes.length !== 1) return false;

  const expressionStart = assignmentIndexes[0]! + 3;
  let leftmostLeaf = expressionStart;
  while (tokens[leftmostLeaf]?.value === "(") leftmostLeaf += 1;
  if (
    tokens[leftmostLeaf]?.kind !== "string" ||
    tokens[leftmostLeaf]!.value !==
      '{"actorRole":"financial-controller","currentObservationId":"'
  ) {
    return false;
  }

  let depth = 0;
  for (let index = expressionStart; index < tokens.length; index += 1) {
    if (tokens[index]?.value === "(") depth += 1;
    if (tokens[index]?.value === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
    if (tokens[index]?.value === ";") return depth === 0;
  }
  return false;
}

function hasSequence(
  tokens: readonly RoutineToken[],
  values: readonly string[]
): boolean {
  return tokens.some((_, start) =>
    values.every((value, offset) => tokens[start + offset]?.value === value)
  );
}

function usesCockroachCanonicalSelectInto(
  tokens: readonly RoutineToken[],
  expectedSelectStatements: number
): boolean {
  let canonicalSelectStatements = 0;
  for (let start = 0; start < tokens.length; start += 1) {
    if (
      tokens[start]?.kind !== "identifier" ||
      tokens[start]?.value !== "select"
    ) {
      continue;
    }
    let end = start + 1;
    while (end < tokens.length && tokens[end]?.value !== ";") end += 1;
    const fromOffset = tokens
      .slice(start + 1, end)
      .findIndex(
        (token) => token.kind === "identifier" && token.value === "from"
      );
    const intoOffset = tokens
      .slice(start + 1, end)
      .findIndex(
        (token) => token.kind === "identifier" && token.value === "into"
      );
    if (fromOffset < 0 || intoOffset <= fromOffset) return false;
    const targetTokens = tokens.slice(start + 2 + intoOffset, end);
    if (
      targetTokens.length === 0 ||
      targetTokens.some((token, index) =>
        index % 2 === 0
          ? token.kind !== "identifier"
          : token.kind !== "symbol" || token.value !== ","
      )
    ) {
      return false;
    }
    canonicalSelectStatements += 1;
  }
  return canonicalSelectStatements === expectedSelectStatements;
}

function usesCockroachFmtParsableSyntax(
  tokens: readonly RoutineToken[],
  expectedSelectStatements: number
): boolean {
  const hasPrefixIntervalLiteral = tokens.some(
    (token, index) =>
      token.kind === "identifier" &&
      token.value === "interval" &&
      tokens[index + 1]?.kind === "string"
  );
  const hasAngleNotEqual = tokens.some(
    (token, index) => token.value === "<" && tokens[index + 1]?.value === ">"
  );
  return (
    !hasPrefixIntervalLiteral &&
    !hasAngleNotEqual &&
    usesCockroachCanonicalSelectInto(tokens, expectedSelectStatements)
  );
}

function inspectRoutineBody(
  body: string,
  routineName: ResolutionRoutineName,
  mode: RoutineInspectionMode,
  databaseName: string | null
): ResolutionRoutineBodyEvidence & { tokens: readonly RoutineToken[] | null } {
  const prefix = mode === "source" ? "source" : "runtime";
  const missingRuleIds: string[] = [];
  const requireRule = (matches: boolean, suffix: string): void => {
    if (!matches) missingRuleIds.push(`${prefix}.${suffix}`);
  };
  const tokens = tokenizeRoutineBody(body);
  requireRule(tokens !== null && tokens.length > 0, "body.parseable");
  if (!tokens || tokens.length === 0) {
    return { matches: false, missingRuleIds, tokens };
  }

  const contract = ROUTINE_CONTRACTS[routineName];
  requireRule(
    !tokens.some((token) => token.kind === "quoted-identifier"),
    "identifiers.unquoted-only"
  );
  requireRule(
    usesCockroachFmtParsableSyntax(tokens, contract.selectStatements),
    "cockroach-v26.2.3-fmt-parsable.canonical"
  );
  requireRule(
    !tokens.some(
      (token) =>
        token.kind === "identifier" &&
        FORBIDDEN_BODY_IDENTIFIERS.has(token.value)
    ),
    "statements.allowed"
  );

  const relations = relationReferences(tokens);
  const relationNames = relations.map((reference) =>
    canonicalRelationName(reference, mode, databaseName)
  );
  requireRule(
    exactCounts(counted(relationNames), contract.relations),
    "relations.closed-exact"
  );

  const calls = routineCalls(tokens, relations);
  const callNames = calls.map((call) => canonicalCallName(call, mode));
  requireRule(
    exactCounts(
      counted(callNames),
      mode === "source" ? contract.sourceCalls : contract.runtimeCalls
    ),
    "calls.closed-exact"
  );

  const returns = tokens.flatMap((token, index) => {
    if (token.kind !== "identifier" || token.value !== "return") return [];
    const value = tokens[index + 1];
    return [value?.kind === "string" ? value.value : "!non-literal"];
  });
  requireRule(
    exactCounts(counted(returns), contract.returns),
    "returns.closed-exact"
  );

  const selectStatements = tokens.filter(
    (token) => token.kind === "identifier" && token.value === "select"
  ).length;
  const insertStatements = tokens.filter(
    (token) => token.kind === "identifier" && token.value === "insert"
  ).length;
  const updateStatements = relations.filter(
    (reference) => reference.operation === "update"
  ).length;
  requireRule(
    selectStatements === contract.selectStatements &&
      insertStatements === contract.insertStatements &&
      updateStatements === contract.updateStatements,
    "statement-counts.closed-exact"
  );

  if (routineName === "archon_resolution_create_session") {
    requireRule(
      hasSequence(tokens, ["p_max_active_sessions", ">", "500"]),
      "capacity.maximum-500"
    );
  } else {
    requireRule(
      hasReceiptActorAssignment(tokens),
      "receipt.actor-role-canonical-assignment"
    );
    requireRule(
      exactSha256Argument(calls, mode),
      "receipt.sha256.exact-canonical-input"
    );
  }

  return {
    matches: missingRuleIds.length === 0,
    missingRuleIds,
    tokens,
  };
}

function isRuntimeDuplicateNowTimestamptzCast(
  tokens: readonly RoutineToken[],
  index: number
): boolean {
  if (index < 7) return false;
  const nowPath = callPathAt(tokens, index - 7);
  const hasObservedDirectComparator =
    tokens[index - 8]?.value === ">" ||
    (tokens[index - 8]?.value === "=" && tokens[index - 9]?.value === "<");
  return (
    tokens[index]?.value === ":" &&
    tokens[index + 1]?.value === ":" &&
    tokens[index + 2]?.value === ":" &&
    tokens[index + 3]?.kind === "identifier" &&
    tokens[index + 3]?.value === "timestamptz" &&
    tokens[index - 1]?.kind === "identifier" &&
    tokens[index - 1]?.value === "timestamptz" &&
    tokens[index - 2]?.value === ":" &&
    tokens[index - 3]?.value === ":" &&
    tokens[index - 4]?.value === ":" &&
    tokens[index - 5]?.value === ")" &&
    tokens[index - 6]?.value === "(" &&
    tokens[index - 7]?.kind === "identifier" &&
    tokens[index - 7]?.value === "now" &&
    nowPath.length === 1 &&
    nowPath[0] === "now" &&
    hasObservedDirectComparator
  );
}

function runtimeDuplicateNowTimestamptzCastCount(
  tokens: readonly RoutineToken[]
): number {
  return tokens.reduce(
    (count, _token, index) =>
      count + (isRuntimeDuplicateNowTimestamptzCast(tokens, index) ? 1 : 0),
    0
  );
}

function normalizedBindingTokens(
  tokens: readonly RoutineToken[],
  routineName: ResolutionRoutineName,
  databaseName: string,
  origin: "source" | "runtime"
): readonly string[] {
  const output: string[] = [];
  const contract = ROUTINE_CONTRACTS[routineName];
  const expectedRelations = new Set(Object.keys(contract.relations));
  let index = 0;
  while (index < tokens.length) {
    // CockroachDB v26.2.3 FmtParsable repeats the explicit TIMESTAMPTZ cast
    // on unqualified now() at the observed direct `>` / `<=` TIMESTAMPTZ
    // comparisons, but not when now() is part of interval arithmetic. Remove
    // exactly that second runtime-origin cast. Source-origin duplicates,
    // missing/wrong casts, qualified calls, and a third cast remain visible to
    // the reviewed-source binding.
    if (
      origin === "runtime" &&
      isRuntimeDuplicateNowTimestamptzCast(tokens, index)
    ) {
      index += 4;
      continue;
    }
    if (
      tokens[index]?.kind === "identifier" &&
      tokens[index]?.value === databaseName.toLowerCase() &&
      tokens[index + 1]?.value === "." &&
      tokens[index + 2]?.kind === "identifier" &&
      tokens[index + 2]?.value === "public" &&
      tokens[index + 3]?.value === "." &&
      tokens[index + 4]?.kind === "identifier" &&
      expectedRelations.has(tokens[index + 4]!.value)
    ) {
      index += 2;
      continue;
    }
    if (
      tokens[index]?.kind === "identifier" &&
      tokens[index]?.value === "pg_catalog" &&
      tokens[index + 1]?.value === "." &&
      tokens[index + 2]?.kind === "identifier" &&
      BUILTIN_NAMES.has(tokens[index + 2]!.value)
    ) {
      index += 2;
      continue;
    }
    output.push(`${tokens[index]!.kind}:${tokens[index]!.value}`);
    index += 1;
  }
  return output;
}

function firstMismatchIndex(
  left: readonly string[],
  right: readonly string[]
): number | null {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? null : sharedLength;
}

function bindingTokenKind(token: string | undefined): string {
  if (token === undefined) return "end";
  const separator = token.indexOf(":");
  return separator < 0 ? "unknown" : token.slice(0, separator);
}

export function resolutionRoutineSourceEvidence(
  schemaSource: string,
  routineName: string
): ResolutionRoutineBodyEvidence {
  const supportedName = asResolutionRoutineName(routineName);
  if (!supportedName) {
    return { matches: false, missingRuleIds: ["source.routine.supported"] };
  }
  const source = resolutionRoutineSourceBody(schemaSource, supportedName);
  const missingRuleIds: string[] = [];
  if (!source.sourceParseable) {
    missingRuleIds.push("source.sql.top-level-parseable");
  }
  if (source.definitionCount !== 1) {
    missingRuleIds.push("source.definition.exactly-one");
  }
  if (source.body === null) {
    missingRuleIds.push("source.body.single-terminal-dollar-quote");
    return { matches: false, missingRuleIds };
  }
  const body = inspectRoutineBody(source.body, supportedName, "source", null);
  missingRuleIds.push(...body.missingRuleIds);
  return {
    matches: missingRuleIds.length === 0,
    missingRuleIds: [...new Set(missingRuleIds)],
  };
}

export function resolutionRoutineRuntimeEvidence(
  runtimeBody: string,
  schemaSource: string,
  routineName: string,
  databaseName: string
): ResolutionRoutineRuntimeEvidence {
  const diagnostics = {
    normalizationVersion:
      "cockroach-v26.2.3-fmt-parsable-exact-v2" as const,
    sourceNormalizedTokenCount: null as number | null,
    runtimeNormalizedTokenCount: null as number | null,
    expectedRuntimeDuplicateNowTimestamptzCastCount: null as number | null,
    observedRuntimeDuplicateNowTimestamptzCastCount: null as number | null,
    firstMismatchIndex: null as number | null,
    sourceTokenKindAtMismatch: null as string | null,
    runtimeTokenKindAtMismatch: null as string | null,
  };
  const supportedName = asResolutionRoutineName(routineName);
  if (!supportedName) {
    return {
      matches: false,
      missingRuleIds: ["runtime.routine.supported"],
      diagnostics,
    };
  }

  const missingRuleIds: string[] = [];
  diagnostics.expectedRuntimeDuplicateNowTimestamptzCastCount =
    ROUTINE_CONTRACTS[supportedName].runtimeDuplicateNowTimestamptzCasts;
  const sourceEvidence = resolutionRoutineSourceEvidence(
    schemaSource,
    supportedName
  );
  if (!sourceEvidence.matches) {
    missingRuleIds.push("runtime.reviewed-source.valid");
  }
  const source = resolutionRoutineSourceBody(schemaSource, supportedName);
  const runtime = inspectRoutineBody(
    runtimeBody,
    supportedName,
    "runtime",
    databaseName
  );
  missingRuleIds.push(...runtime.missingRuleIds);
  diagnostics.observedRuntimeDuplicateNowTimestamptzCastCount = runtime.tokens
    ? runtimeDuplicateNowTimestamptzCastCount(runtime.tokens)
    : null;
  if (
    diagnostics.observedRuntimeDuplicateNowTimestamptzCastCount !==
    diagnostics.expectedRuntimeDuplicateNowTimestamptzCastCount
  ) {
    missingRuleIds.push(
      "runtime.cockroach-v26.2.3-fmt-parsable-duplicate-casts-exact"
    );
  }

  const sourceTokens =
    source.body === null ? null : tokenizeRoutineBody(source.body);
  if (sourceTokens && runtime.tokens) {
    const normalizedSource = normalizedBindingTokens(
      sourceTokens,
      supportedName,
      databaseName,
      "source"
    );
    const normalizedRuntime = normalizedBindingTokens(
      runtime.tokens,
      supportedName,
      databaseName,
      "runtime"
    );
    diagnostics.sourceNormalizedTokenCount = normalizedSource.length;
    diagnostics.runtimeNormalizedTokenCount = normalizedRuntime.length;
    diagnostics.firstMismatchIndex = firstMismatchIndex(
      normalizedSource,
      normalizedRuntime
    );
    if (diagnostics.firstMismatchIndex !== null) {
      diagnostics.sourceTokenKindAtMismatch = bindingTokenKind(
        normalizedSource[diagnostics.firstMismatchIndex]
      );
      diagnostics.runtimeTokenKindAtMismatch = bindingTokenKind(
        normalizedRuntime[diagnostics.firstMismatchIndex]
      );
      missingRuleIds.push("runtime.reviewed-source-token-binding");
    }
  } else {
    missingRuleIds.push("runtime.reviewed-source-token-binding");
  }

  const uniqueMissingRuleIds = [...new Set(missingRuleIds)];
  return {
    matches: uniqueMissingRuleIds.length === 0,
    missingRuleIds: uniqueMissingRuleIds,
    diagnostics,
  };
}
