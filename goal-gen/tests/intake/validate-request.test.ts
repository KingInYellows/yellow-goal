import { describe, expect, it } from 'vitest';
import { IntakeValidationFailure, parseCanonicalRequest, validateCanonicalRequest } from '../../backend/src/intake';
import { requestSample } from '../contracts/support/samples';

describe('validateCanonicalRequest', () => {
  it('accepts the canonical sample as-is (no normalization/defaulting applied)', () => {
    const result = validateCanonicalRequest(requestSample);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a canonical request with no orchestration profiles present', () => {
    const { orchestration: _orchestration, ...withoutOrchestration } = requestSample;
    const result = validateCanonicalRequest(withoutOrchestration);
    expect(result.valid).toBe(true);
  });

  it('rejects a value missing a required top-level field', () => {
    const { mode: _mode, ...withoutMode } = requestSample;
    const result = validateCanonicalRequest(withoutMode);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a flat convenience shape (it is not the canonical nested shape)', () => {
    const result = validateCanonicalRequest({ repository: 'octocat/example', goal: 'Ship the thing.' });
    expect(result.valid).toBe(false);
  });

  it('rejects non-object input without throwing', () => {
    const result = validateCanonicalRequest('not an object');
    expect(result.valid).toBe(false);
  });

  it('rejects an unknown permission profile on a hand-authored canonical request', () => {
    const result = validateCanonicalRequest({
      ...requestSample,
      orchestration: { permissionProfile: 'bypassPermissions', orchestrationProfile: 'claude-fable-opus-sonnet@1' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'orchestration.permissionProfile')).toBe(true);
    expect(result.errors.some((e) => e.message.includes('bypassPermissions'))).toBe(true);
  });

  it('rejects an unknown orchestration profile on a hand-authored canonical request', () => {
    const result = validateCanonicalRequest({
      ...requestSample,
      orchestration: { permissionProfile: 'inspect', orchestrationProfile: 'not-a-real-profile@1' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'orchestration.orchestrationProfile')).toBe(true);
  });
});

describe('parseCanonicalRequest', () => {
  it('returns the canonical sample', () => {
    const request = parseCanonicalRequest(requestSample);
    expect(request.requestId).toBe(requestSample.requestId);
  });

  it('throws IntakeValidationFailure for an unknown permission profile', () => {
    expect(() =>
      parseCanonicalRequest({
        ...requestSample,
        orchestration: { permissionProfile: 'bypassPermissions' },
      }),
    ).toThrow(IntakeValidationFailure);
  });
});
