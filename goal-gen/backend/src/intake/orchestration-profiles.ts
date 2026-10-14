/**
 * The orchestration profile ids intake will currently accept. There is no vendored policy file
 * for this (unlike permission-profiles.json) — it mirrors goal-gen/schemas/app/
 * orchestration-profile.schema.json's `id` pattern, restricted to the profile this milestone
 * actually resolves (`claude-fable-opus-sonnet@1`, per 09_IMPLEMENTATION_MILESTONE.md and the
 * orchestration model-role work owned by other workers), plus the opt-in 5.5-generation
 * `claude-fable-opus-sonnet@2`. Extend this set only when a new OrchestrationProfile has actually
 * been resolved (analysis/orchestration-defaults.ts) and documented, not speculatively.
 */
export const KNOWN_ORCHESTRATION_PROFILES: ReadonlySet<string> = new Set([
  'claude-fable-opus-sonnet@1',
  'claude-fable-opus-sonnet@2',
]);

export function isKnownOrchestrationProfile(profile: string): boolean {
  return KNOWN_ORCHESTRATION_PROFILES.has(profile);
}
