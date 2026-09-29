/**
 * AGX-R11/R13 pre-spawn guards: two-way auth-mode guard, filesystem-tool confinement, and the
 * acceptEdits-only permission resolution.
 */
import { describe, expect, it } from 'vitest';
import { RunApprovalError } from '../../backend/src/cli/errors';
import {
  allowedToolNames,
  assertAuthModeMatchesEnv,
  assertFilesystemToolsConfined,
  resolveRealRunPermissionMode,
} from '../../backend/src/executors/real-run-guards';

function refusalCode(fn: () => void): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof RunApprovalError) return err.code;
    throw err;
  }
  return undefined;
}

describe('assertAuthModeMatchesEnv (AGX-R13)', () => {
  it('refuses an API key under subscription auth', () => {
    expect(refusalCode(() => assertAuthModeMatchesEnv('subscription', { ANTHROPIC_API_KEY: 'sk-test' }))).toBe(
      'AUTH_MODE_MISMATCH',
    );
  });

  it('refuses api-key auth without a key (absent or empty)', () => {
    expect(refusalCode(() => assertAuthModeMatchesEnv('api-key', {}))).toBe('AUTH_MODE_MISMATCH');
    expect(refusalCode(() => assertAuthModeMatchesEnv('api-key', { ANTHROPIC_API_KEY: '' }))).toBe('AUTH_MODE_MISMATCH');
  });

  it('accepts matching credentials', () => {
    expect(refusalCode(() => assertAuthModeMatchesEnv('subscription', {}))).toBeUndefined();
    expect(refusalCode(() => assertAuthModeMatchesEnv('subscription', { ANTHROPIC_API_KEY: '' }))).toBeUndefined();
    expect(refusalCode(() => assertAuthModeMatchesEnv('api-key', { ANTHROPIC_API_KEY: 'sk-test' }))).toBeUndefined();
  });

  it('never echoes the key', () => {
    let refusal: unknown;
    try {
      assertAuthModeMatchesEnv('subscription', { ANTHROPIC_API_KEY: 'sk-secret-value' });
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(RunApprovalError);
    const { message, details } = refusal as RunApprovalError;
    expect(JSON.stringify({ message, details })).not.toContain('sk-secret-value');
  });

  it.each([
    ['ANTHROPIC_AUTH_TOKEN'],
    ['ANTHROPIC_BASE_URL'],
    ['CLAUDE_CODE_USE_BEDROCK'],
    ['CLAUDE_CODE_USE_VERTEX'],
    ['CLAUDE_CODE_USE_FOUNDRY'],
    ['CLAUDE_CODE_OAUTH_TOKEN'],
    ['ANTHROPIC_CUSTOM_HEADERS'],
  ])('refuses %s in either auth mode, naming it without its value', (name) => {
    for (const env of [{ [name]: 'secret-value' }, { [name]: 'secret-value', ANTHROPIC_API_KEY: 'sk-test' }]) {
      const mode = 'ANTHROPIC_API_KEY' in env ? 'api-key' : 'subscription';
      let refusal: unknown;
      try {
        assertAuthModeMatchesEnv(mode, env);
      } catch (err) {
        refusal = err;
      }
      expect(refusal).toBeInstanceOf(RunApprovalError);
      expect((refusal as RunApprovalError).code).toBe('AUTH_MODE_MISMATCH');
      expect((refusal as RunApprovalError).message).toContain(name);
      expect(JSON.stringify((refusal as RunApprovalError).details)).not.toContain('secret-value');
    }
  });
});

describe('assertFilesystemToolsConfined (AGX-R11)', () => {
  it.each([
    ['Read(./**)'],
    ['Edit(./site.json)'],
    ['Edit(SITE)'],
    ['Write(./site.json)'],
    ['MultiEdit(./site.json)'],
    ['Glob(./*)'],
    ['Grep(./**)'],
    ['Read(./.claude/settings.json)'],
  ])('accepts %s', (rule) => {
    expect(refusalCode(() => assertFilesystemToolsConfined([rule]))).toBeUndefined();
  });

  it.each([
    ['Edit'],
    ['Read'],
    ['Bash'],
    ['Bash(ls)'],
    ['Bash(git status:*)'],
    ['WebFetch(domain:example.com)'],
    ['mcp__srv__tool'],
    ['Read(//etc/**)'],
    ['Write(/site.json)'],
    ['Read(~/.ssh/**)'],
    ['Edit(../x)'],
    ['Edit(./a/../../x)'],
    ['Edit(C:\\x)'],
    ['Edit(a\\b)'],
    ['Read($HOME/x)'],
    ['Edit()'],
    ['Edit( )'],
    ['Read( //etc/**)'],
    ['Edit( ~/.bashrc)'],
    ['Read(./x) Bash(*)'],
    ['Edit(./a,Bash)'],
    ['Edit("./site.json")'],
    ['Read(./{a,b})'],
    ['Edit(./site.json\t)'],
    ['Edit(./.claude/settings.json)'],
    ['Write(.git)'],
    ['Write(./.git/config)'],
    ['MultiEdit(./.mcp.json)'],
    ['Edit(./CLAUDE.local.md)'],
    ['Write(./.*)'],
    ['Edit(./.Claude/settings.json)'],
    ['Write(./.GIT/config)'],
    ['Write(./sub/.git/HEAD)'],
  ])('refuses %s', (rule) => {
    expect(refusalCode(() => assertFilesystemToolsConfined(['Edit(./site.json)', rule]))).toBe('TOOLS_UNCONFINED');
  });

  it('refuses an empty allowlist', () => {
    expect(refusalCode(() => assertFilesystemToolsConfined([]))).toBe('TOOLS_UNCONFINED');
  });

  it('lists every offending rule', () => {
    let refusal: unknown;
    try {
      assertFilesystemToolsConfined(['Bash', 'Edit(./site.json)', 'Read(//etc)']);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(RunApprovalError);
    const details = (refusal as RunApprovalError).details as { offending: Array<{ rule: string }> };
    expect(details.offending.map((o) => o.rule)).toEqual(['Bash', 'Read(//etc)']);
  });
});

describe('resolveRealRunPermissionMode (AGX-R11)', () => {
  it('returns acceptEdits only for acceptEdits', () => {
    expect(resolveRealRunPermissionMode('acceptEdits')).toBe('acceptEdits');
  });

  it.each([['plan'], ['auto'], ['dontAsk'], ['manual'], ['bypassPermissions'], [''], [undefined], [null], [42]])(
    'refuses %s',
    (mode) => {
      expect(refusalCode(() => resolveRealRunPermissionMode(mode))).toBe('MANIFEST_INVALID');
    },
  );
});

describe('allowedToolNames (--tools)', () => {
  it('returns the distinct, sorted tool names of an approved allowlist', () => {
    expect(allowedToolNames(['Read(./**)', 'Edit(./site.json)', 'Edit(./SITE)', 'Write(./SITE)'])).toEqual(['Edit', 'Read', 'Write']);
  });
});
