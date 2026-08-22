/**
 * Tests for inspection/policy.ts: loads the REAL vendored goal-gen/policies/protected-paths.json
 * (not a hand-rolled test fixture — the point is to prove the matcher agrees with the actual
 * shipped policy), and exercises both directions of the over-match-biased matching rule.
 */
import { describe, expect, it } from 'vitest';
import { compileProtectedPathPolicy, loadProtectedPathPolicy } from '../../backend/src/inspection/policy';

describe('inspection/policy', () => {
  it('loads the vendored policy file and compiles it', async () => {
    const policy = await loadProtectedPathPolicy();
    expect(policy.schemaVersion).toBe('yellow-goal/protected-path-policy/v1');
    expect(policy.defaultPatterns.length).toBeGreaterThan(0);
    const compiled = compileProtectedPathPolicy(policy);
    expect(typeof compiled.isProtected).toBe('function');
  });

  it('matches literal, extension, substring, any-depth, and directory-prefix protected patterns', async () => {
    const compiled = compileProtectedPathPolicy(await loadProtectedPathPolicy());
    expect(compiled.isProtected('.env')).toBe(true);
    expect(compiled.isProtected('.env.local')).toBe(true);
    expect(compiled.isProtected('nested/.env')).toBe(true);
    expect(compiled.isProtected('nested/.env.production')).toBe(true);
    expect(compiled.isProtected('key.pem')).toBe(true);
    expect(compiled.isProtected('certs/server.key')).toBe(true);
    expect(compiled.isProtected('config/auth.users.json')).toBe(true);
    expect(compiled.isProtected('.aws/credentials')).toBe(true);
    expect(compiled.isProtected('.azure/nested/deep/file.json')).toBe(true);
  });

  it('over-matches by design: *token* matches a substring anywhere, not just literal "token" files', async () => {
    const compiled = compileProtectedPathPolicy(await loadProtectedPathPolicy());
    // Deliberate: the policy is implemented as written, biased toward false positives over
    // false negatives. "tokenizer.ts" containing the substring "token" IS a protected match.
    expect(compiled.isProtected('src/tokenizer.ts')).toBe(true);
    expect(compiled.isProtected('src/my-secret-sauce.md')).toBe(true);
  });

  it('sanitized patterns override an otherwise-protected match', async () => {
    const compiled = compileProtectedPathPolicy(await loadProtectedPathPolicy());
    expect(compiled.isProtected('.env.example')).toBe(false);
    expect(compiled.isProtected('nested/.env.sample')).toBe(false);
    expect(compiled.isProtected('config/database.example')).toBe(false);
    expect(compiled.isProtected('config/database.template')).toBe(false);
  });

  it('ordinary, non-matching paths are never flagged protected', async () => {
    const compiled = compileProtectedPathPolicy(await loadProtectedPathPolicy());
    expect(compiled.isProtected('README.md')).toBe(false);
    expect(compiled.isProtected('src/index.js')).toBe(false);
    expect(compiled.isProtected('package.json')).toBe(false);
  });
});
