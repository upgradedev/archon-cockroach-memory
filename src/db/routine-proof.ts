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
