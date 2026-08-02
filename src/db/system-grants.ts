export interface SystemGrant {
  privilege_type: string;
  is_grantable: boolean;
}

// Restrictive deny-form entries returned by SHOW SYSTEM GRANTS remove
// capabilities; they do not grant cluster authority. Legacy role_options are
// checked independently through the exact-empty SHOW USERS runtime contract.
// Everything else remains fail-closed, including unknown future privileges and
// a restrictive entry carrying grant authority.
const RESTRICTIVE_SYSTEM_GRANTS = new Set([
  "NOBYPASSRLS",
  "NOCANCELQUERY",
  "NOCONTROLCHANGEFEED",
  "NOCONTROLJOB",
  "NOCREATEDB",
  "NOCREATELOGIN",
  "NOCREATEROLE",
  "NOLOGIN",
  "NOMODIFYCLUSTERSETTING",
  "NOREPLICATION",
  "NOSQLLOGIN",
  "NOVIEWACTIVITY",
  "NOVIEWACTIVITYREDACTED",
  "NOVIEWCLUSTERSETTING",
]);

const PRIVILEGED_RUNTIME_ROLE_OPTIONS = new Set([
  "ADMIN",
  "BYPASSRLS",
  "CANCELQUERY",
  "CONTROLCHANGEFEED",
  "CONTROLJOB",
  "CREATEDB",
  "CREATELOGIN",
  "CREATEROLE",
  "MODIFYCLUSTERSETTING",
  "PROVISIONSRC",
  "REPLICATION",
  "SUBJECT",
  "VIEWACTIVITY",
  "VIEWACTIVITYREDACTED",
  "VIEWCLUSTERSETTING",
]);

function roleOptionName(option: string): string {
  return option.toUpperCase().split(/[=\s]/u, 1)[0] ?? "";
}

export function privilegedRuntimeRoleOptions(
  options: readonly string[]
): string[] {
  return [
    ...new Set(
      options
        .map(roleOptionName)
        .filter((option) => PRIVILEGED_RUNTIME_ROLE_OPTIONS.has(option))
    ),
  ].sort();
}

export function runtimeLoginIsDisabled(options: readonly string[]): boolean {
  const names = new Set(options.map(roleOptionName));
  return names.has("NOLOGIN") || names.has("NOSQLLOGIN");
}

export function runtimeRoleOptionsAreCanonical(
  options: readonly string[]
): boolean {
  // Runtime users are generated without role options. An exact-empty contract
  // catches legacy and future options even when SHOW SYSTEM GRANTS does not.
  return options.length === 0;
}

export function affirmativeSystemGrants(
  grants: readonly SystemGrant[]
): SystemGrant[] {
  return grants.filter(
    (grant) =>
      grant.is_grantable ||
      !RESTRICTIVE_SYSTEM_GRANTS.has(grant.privilege_type.toUpperCase())
  );
}
