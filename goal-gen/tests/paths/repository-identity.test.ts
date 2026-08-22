import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sameRepositoryIdentity } from '../../backend/src/paths/repository-identity';

describe('sameRepositoryIdentity', () => {
  it('treats identical strings as the same, including GitHub owner/repo ids', () => {
    expect(sameRepositoryIdentity('octocat/example', 'octocat/example')).toBe(true);
    expect(sameRepositoryIdentity('octocat/example', 'octocat/other')).toBe(false);
  });

  it('treats a trailing slash as the same local path inspect would record', () => {
    expect(sameRepositoryIdentity('/tmp/repo/', '/tmp/repo')).toBe(true);
  });

  it('treats ./ and bare relative paths as the resolved absolute path', () => {
    const abs = resolvePath('some-repo');
    expect(sameRepositoryIdentity('./some-repo', abs)).toBe(true);
    expect(sameRepositoryIdentity('some-repo', abs)).toBe(true);
  });

  it('rejects two different absolute local paths', () => {
    expect(sameRepositoryIdentity('/tmp/repo-a', '/tmp/repo-b')).toBe(false);
  });
});
