export interface SystemGrant {
  privilege_type: string;
  is_grantable: boolean;
}

// CockroachDB reports restrictive role options through SHOW SYSTEM GRANTS
// alongside affirmative privileges. These entries remove capabilities; they do
// not grant cluster authority. Everything else remains fail-closed, including
// unknown future privileges and a restrictive option carrying grant authority.
const RESTRICTIVE_ROLE_OPTIONS = new Set([
  "NOBYPASSRLS",
  "NOCANCELQUERY",
  "NOCONTROLCHANGEFEED",
  "NOCONTROLJOB",
  "NOCREATEDB",
  "NOCREATELOGIN",
  "NOCREATEROLE",
  "NOLOGIN",
  "NOMODIFYCLUSTERSETTING",
  "NOSQLLOGIN",
  "NOVIEWACTIVITY",
  "NOVIEWACTIVITYREDACTED",
  "NOVIEWCLUSTERSETTING",
]);

export function affirmativeSystemGrants(
  grants: readonly SystemGrant[]
): SystemGrant[] {
  return grants.filter(
    (grant) =>
      grant.is_grantable ||
      !RESTRICTIVE_ROLE_OPTIONS.has(grant.privilege_type.toUpperCase())
  );
}
