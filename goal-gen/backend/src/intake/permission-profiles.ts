import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads goal-gen/policies/permission-profiles.json via node:fs + JSON.parse rather than a static
 * `import ... .json`, so this module has no dependency on Node's ESM JSON-import-attribute
 * requirements (which vary across the tsc/tsx/vitest runtimes this repo runs under).
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const policyPath = path.resolve(moduleDir, '../../../policies/permission-profiles.json');

interface PermissionProfilesPolicy {
  schemaVersion: string;
  profiles: Record<string, { targetWrite?: boolean | string } & Record<string, unknown>>;
  invariant: string;
}

function loadPermissionProfilesPolicy(): PermissionProfilesPolicy {
  const raw = readFileSync(policyPath, 'utf8');
  return JSON.parse(raw) as PermissionProfilesPolicy;
}

const policy = loadPermissionProfilesPolicy();

/** The permission profile ids currently defined by policy (e.g. "inspect", "compile",
 *  "implement", "autonomous-isolated"). Unknown values must be rejected — see the policy's own
 *  `invariant` field. */
export const KNOWN_PERMISSION_PROFILES: ReadonlySet<string> = new Set(Object.keys(policy.profiles));

export function isKnownPermissionProfile(profile: string): boolean {
  return KNOWN_PERMISSION_PROFILES.has(profile);
}

/** Whether the named permission profile permits any write to the repository target — the
 *  policy's `targetWrite` is `false` for read-only profiles (`inspect`, `compile`), or a truthy
 *  string (e.g. `"isolated-worktree-only"`) for profiles that permit scoped writes. Unrecognized
 *  profile ids are treated as NOT write-permitting (fail closed, RR21) — pair with
 *  `isKnownPermissionProfile` for a separate "unknown profile" rejection where that distinction
 *  matters. */
export function permissionProfileAllowsTargetWrite(profile: string): boolean {
  const entry = policy.profiles[profile];
  return Boolean(entry?.targetWrite);
}
