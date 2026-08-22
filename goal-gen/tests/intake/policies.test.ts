import { describe, expect, it } from 'vitest';
import { isKnownOrchestrationProfile, KNOWN_ORCHESTRATION_PROFILES } from '../../backend/src/intake/orchestration-profiles';
import { isKnownPermissionProfile, KNOWN_PERMISSION_PROFILES } from '../../backend/src/intake/permission-profiles';

describe('permission profile policy', () => {
  it('loads the four profiles declared in policies/permission-profiles.json', () => {
    expect([...KNOWN_PERMISSION_PROFILES].sort()).toEqual(
      ['autonomous-isolated', 'compile', 'implement', 'inspect'].sort(),
    );
  });

  it('recognizes known profiles and rejects unknown ones', () => {
    expect(isKnownPermissionProfile('inspect')).toBe(true);
    expect(isKnownPermissionProfile('does-not-exist')).toBe(false);
  });
});

describe('orchestration profile policy', () => {
  it('recognizes the currently resolved default profile', () => {
    expect(KNOWN_ORCHESTRATION_PROFILES.has('claude-fable-opus-sonnet@1')).toBe(true);
    expect(isKnownOrchestrationProfile('claude-fable-opus-sonnet@1')).toBe(true);
  });

  it('rejects an unknown orchestration profile id', () => {
    expect(isKnownOrchestrationProfile('made-up-profile@9')).toBe(false);
  });
});
