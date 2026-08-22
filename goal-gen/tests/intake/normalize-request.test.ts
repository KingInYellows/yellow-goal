import { describe, expect, it } from 'vitest';
import { IntakeValidationFailure, normalizeRequest } from '../../backend/src/intake';

describe('normalizeRequest', () => {
  it('accepts a minimal request containing only repository and goal (AC-1)', () => {
    const request = normalizeRequest({ repository: 'octocat/example', goal: 'Ship the thing.' });
    expect(request.target.repository).toBe('octocat/example');
    expect(request.intent.goal).toBe('Ship the thing.');
  });

  it('defaults mode, target.ref, pack, and both profiles', () => {
    const request = normalizeRequest({ repository: 'octocat/example', goal: 'Ship the thing.' });
    expect(request.mode).toBe('review-and-compile');
    expect(request.target.ref).toBe('AUTO');
    expect(request.pack).toBe('repository-goal-packet@1');
    expect(request.orchestration).toMatchObject({
      permissionProfile: 'inspect',
      orchestrationProfile: 'claude-fable-opus-sonnet@1',
    });
  });

  it('preserves the goal verbatim, including internal and surrounding whitespace', () => {
    const goal = '  Ship the   thing\nwith a trailing newline.\n';
    const request = normalizeRequest({ repository: 'octocat/example', goal });
    expect(request.intent.goal).toBe(goal);
  });

  it('validates against the canonical schema (always well-formed on success)', () => {
    const request = normalizeRequest({ repository: 'octocat/example', goal: 'Ship the thing.' });
    expect(request.schemaVersion).toBe('yellow-goal/request/v1');
  });

  it('rejects a missing repository', () => {
    expect(() => normalizeRequest({ repository: '', goal: 'Ship the thing.' })).toThrow(
      IntakeValidationFailure,
    );
  });

  it('rejects a too-short goal', () => {
    expect(() => normalizeRequest({ repository: 'octocat/example', goal: 'Hi' })).toThrow(
      IntakeValidationFailure,
    );
  });

  it('rejects an unknown permission profile', () => {
    try {
      normalizeRequest({
        repository: 'octocat/example',
        goal: 'Ship the thing.',
        permissionProfile: 'nonexistent-profile',
      });
      expect.unreachable('normalizeRequest should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeValidationFailure);
      const failure = err as IntakeValidationFailure;
      expect(failure.errors.some((e) => e.code === 'UNKNOWN_PERMISSION_PROFILE')).toBe(true);
    }
  });

  it('rejects an unknown orchestration profile', () => {
    try {
      normalizeRequest({
        repository: 'octocat/example',
        goal: 'Ship the thing.',
        orchestrationProfile: 'nonexistent-profile@1',
      });
      expect.unreachable('normalizeRequest should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeValidationFailure);
      const failure = err as IntakeValidationFailure;
      expect(failure.errors.some((e) => e.code === 'UNKNOWN_ORCHESTRATION_PROFILE')).toBe(true);
    }
  });

  it('accepts every known permission profile', () => {
    for (const profile of ['inspect', 'compile', 'implement', 'autonomous-isolated']) {
      const request = normalizeRequest({
        repository: 'octocat/example',
        goal: 'Ship the thing.',
        permissionProfile: profile,
      });
      expect(request.orchestration?.permissionProfile).toBe(profile);
    }
  });

  it('generates a requestId matching the canonical pattern when none is supplied', () => {
    const request = normalizeRequest({ repository: 'octocat/example', goal: 'Ship the thing.' });
    expect(request.requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });

  it('uses an injected requestId generator for deterministic output', () => {
    const request = normalizeRequest(
      { repository: 'octocat/example', goal: 'Ship the thing.' },
      { generateRequestId: () => 'req-fixed-001' },
    );
    expect(request.requestId).toBe('req-fixed-001');
  });

  it('honors an explicitly supplied requestId over the generator', () => {
    const request = normalizeRequest(
      { repository: 'octocat/example', goal: 'Ship the thing.', requestId: 'req-explicit' },
      { generateRequestId: () => 'req-should-not-be-used' },
    );
    expect(request.requestId).toBe('req-explicit');
  });

  it('respects explicit overrides for mode, ref, and pack', () => {
    const request = normalizeRequest({
      repository: 'octocat/example',
      goal: 'Ship the thing.',
      mode: 'review-only',
      ref: 'v2.0.0',
      pack: 'repository-goal-packet@2',
    });
    expect(request.mode).toBe('review-only');
    expect(request.target.ref).toBe('v2.0.0');
    expect(request.pack).toBe('repository-goal-packet@2');
  });
});
