// Descriptor-backed verification for CockroachDB routine security metadata.
//
// CockroachDB v26.2.3's PostgreSQL-compatibility pg_proc currently exposes
// prosecdef=false for user-defined routines regardless of their descriptor.
// SHOW CREATE FUNCTION is generated from that descriptor and preserves the
// actual security mode.

export function isExpectedResolutionRoutineCreateStatement(
  createStatement: string,
  routineName: string
): boolean {
  const normalized = createStatement.replace(/\s+/gu, " ").trim();
  const bodyStart = /\sAS\s+\$[A-Za-z_0-9]*\$/iu.exec(normalized);
  if (!bodyStart || bodyStart.index === 0) return false;

  // Inspect only the canonical declaration emitted by SHOW CREATE FUNCTION.
  // A function body containing option-like text must never be able to spoof
  // the descriptor-backed security, language, or volatility checks.
  const declaration = normalized.slice(0, bodyStart.index);
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
  kind: "identifier" | "number" | "string" | "symbol";
  value: string;
};

function tokenizeRoutineBody(body: string): RoutineToken[] {
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
      if (depth !== 0) return [];
      continue;
    }
    if (character === "'") {
      cursor += 1;
      let value = "";
      let terminated = false;
      while (cursor < body.length) {
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
      if (!terminated) return [];
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
      if (!terminated) return [];
      tokens.push({ kind: "identifier", value: value.toLowerCase() });
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

function hasSequence(
  tokens: readonly RoutineToken[],
  values: readonly string[]
): boolean {
  return tokens.some((_, start) =>
    values.every((value, offset) => tokens[start + offset]?.value === value)
  );
}

function hasOnlyQualifiedRelations(
  tokens: readonly RoutineToken[],
  relations: readonly string[]
): boolean {
  return relations.every((relation) => {
    const occurrences = tokens
      .map((token, index) => ({ token, index }))
      .filter(({ token }) =>
        token.kind === "identifier" && token.value === relation
      );
    return (
      occurrences.length > 0 &&
      occurrences.every(
        ({ index }) =>
          tokens[index - 1]?.value === "." &&
          tokens[index - 2]?.kind === "identifier" &&
          tokens[index - 2]?.value === "public"
      )
    );
  });
}

function hasFunctionArgumentIdentifier(
  tokens: readonly RoutineToken[],
  qualifiedFunction: readonly string[],
  argument: string
): boolean {
  for (let start = 0; start < tokens.length; start += 1) {
    if (
      !qualifiedFunction.every(
        (value, offset) => tokens[start + offset]?.value === value
      )
    ) {
      continue;
    }
    const opening = start + qualifiedFunction.length - 1;
    let depth = 0;
    let containsArgument = false;
    for (let index = opening; index < tokens.length; index += 1) {
      if (tokens[index]?.value === "(") depth += 1;
      if (
        depth > 0 &&
        tokens[index]?.kind === "identifier" &&
        tokens[index]?.value === argument
      ) {
        containsArgument = true;
      }
      if (tokens[index]?.value === ")") {
        depth -= 1;
        if (depth === 0) return containsArgument;
      }
    }
  }
  return false;
}

function hasReturnString(
  tokens: readonly RoutineToken[],
  value: string
): boolean {
  return tokens.some(
    (token, index) =>
      token.kind === "identifier" &&
      token.value === "return" &&
      tokens[index + 1]?.kind === "string" &&
      tokens[index + 1]?.value === value
  );
}

export function isExpectedResolutionRoutineBody(
  body: string,
  routineName: string
): boolean {
  const tokens = tokenizeRoutineBody(body);
  if (
    tokens.length === 0 ||
    tokens.some(
      (token) => token.kind === "identifier" && token.value === "execute"
    ) ||
    !hasSequence(tokens, ["pg_catalog", ".", "now", "("])
  ) {
    return false;
  }

  if (routineName === "archon_resolution_create_session") {
    return (
      hasOnlyQualifiedRelations(tokens, [
        "memory_demo_sessions",
        "memory_resolution_observations",
        "memory_resolution_proposals",
      ]) &&
      hasSequence(tokens, ["p_max_active_sessions", ">", "500"]) &&
      hasReturnString(tokens, "created")
    );
  }

  if (routineName === "archon_resolution_decide") {
    return (
      hasOnlyQualifiedRelations(tokens, [
        "memory_demo_sessions",
        "memory_resolution_observations",
        "memory_resolution_proposals",
        "memory_resolution_decisions",
        "memory_resolution_consolidations",
      ]) &&
      hasFunctionArgumentIdentifier(
        tokens,
        ["pg_catalog", ".", "sha256", "("],
        "v_receipt_canonical"
      ) &&
      hasReturnString(tokens, "replayed") &&
      hasReturnString(tokens, "conflict") &&
      hasReturnString(tokens, "applied")
    );
  }

  return false;
}
