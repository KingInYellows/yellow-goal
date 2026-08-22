/**
 * Builds `CommandRecord[]` from three real, provenance-backed sources: npm scripts (from
 * manifests.ts's parsed package.json), Makefile targets, and CI workflow `run:` steps. Every
 * record's `argv` must be a literal argument array safe to `spawnSync` without a shell — a CI
 * step containing shell metacharacters (`&&`, `|`, `;`, `$(...)`, backticks, `${{ }}` templating)
 * cannot be honestly decomposed into one, so such steps are recorded as evidence (their text, as
 * bounded fenced data) but deliberately produce NO CommandRecord rather than a wrong or unsafe one.
 */
import { dirname } from 'node:path';
import yaml from 'js-yaml';
import { CommandRecordSchema } from '../../contracts';
import type { CommandRecord } from '../../contracts';
import type { EvidenceStore } from '../../evidence/store';
import { lsFiles } from '../git';
import type { CompiledProtectedPathPolicy } from '../policy';
import { readTrackedPublicFile } from '../safe-tracked-read';
import type { ManifestFact } from './manifests';

const SHELL_METACHAR_RE = /[&|;$`(){}<>]/;
const GH_TEMPLATE_RE = /\$\{\{/;

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Returns argv, or null if `cmd` is not a safe single literal invocation (shell-metacharacter or
 *  GitHub Actions `${{ }}` templating present — never fabricate an argv for those). */
function tokenizeSimpleCommand(cmd: string): string[] | null {
  const trimmed = cmd.trim();
  if (trimmed.length === 0) return null;
  if (SHELL_METACHAR_RE.test(trimmed) || GH_TEMPLATE_RE.test(trimmed)) return null;
  if (trimmed.includes('\n')) return null; // multi-line run block — treat as complex, skip
  return trimmed.split(/\s+/);
}

function scriptSideEffect(name: string): CommandRecord['sideEffectClass'] {
  if (/test/i.test(name)) return 'test';
  if (/build|compile|bundle/i.test(name)) return 'build';
  if (/lint|check|typecheck|format/i.test(name)) return 'read-only';
  return 'unknown';
}

async function detectFromNpmScripts(manifests: ManifestFact[], evidence: EvidenceStore): Promise<CommandRecord[]> {
  const records: CommandRecord[] = [];
  for (const manifest of manifests) {
    if (!manifest.npmScripts) continue;
    for (const [name, script] of Object.entries(manifest.npmScripts)) {
      const record = evidence.add({
        sourceType: 'repository-file',
        path: manifest.path,
        sensitivity: 'public',
        facts: [`npm script "${name}"`],
        excerpt: script.length > 1000 ? script.slice(0, 1000) : script,
      });
      records.push(
        CommandRecordSchema.parse({
          schemaVersion: 'yellow-goal/command-record/v1',
          id: `cmd-npm-${slug(manifest.path)}-${slug(name)}`,
          argv: ['npm', 'run', name],
          workingDir: dirname(manifest.path),
          source: 'manifest-script',
          evidenceRefs: [record.id],
          confidence: 'configured',
          sideEffectClass: scriptSideEffect(name),
          executable: true,
        }),
      );
    }
  }
  return records;
}

const MAKE_TARGET_RE = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/;

async function detectFromMakefile(
  localDir: string,
  evidence: EvidenceStore,
  policy?: CompiledProtectedPathPolicy,
): Promise<CommandRecord[]> {
  const candidates = lsFiles(localDir, { paths: ['Makefile', 'makefile', 'GNUmakefile'] });
  const records: CommandRecord[] = [];
  for (const relPath of candidates) {
    const read = await readTrackedPublicFile(localDir, relPath, policy);
    if (read.status !== 'ok') continue;
    const content = read.content;
    const targets = new Set<string>();
    for (const line of content.split('\n')) {
      if (line.startsWith('\t') || line.trim().startsWith('#')) continue;
      const m = MAKE_TARGET_RE.exec(line);
      if (m && m[1] && !m[1].startsWith('.')) targets.add(m[1]);
    }
    if (targets.size === 0) continue;
    const record = evidence.add({
      sourceType: 'repository-file',
      path: relPath,
      sensitivity: 'public',
      facts: [`Makefile targets: ${[...targets].sort().join(', ')}`],
      excerpt: content.length > 2000 ? content.slice(0, 2000) : content,
    });
    for (const target of [...targets].sort()) {
      records.push(
        CommandRecordSchema.parse({
          schemaVersion: 'yellow-goal/command-record/v1',
          id: `cmd-make-${slug(relPath)}-${slug(target)}`,
          argv: ['make', target],
          workingDir: '.',
          source: 'makefile',
          evidenceRefs: [record.id],
          confidence: 'configured',
          sideEffectClass: /test/i.test(target) ? 'test' : /build/i.test(target) ? 'build' : 'unknown',
          executable: true,
        }),
      );
    }
  }
  return records;
}

interface WorkflowStep {
  run?: unknown;
}
interface WorkflowJob {
  steps?: unknown;
}
interface WorkflowDoc {
  jobs?: Record<string, WorkflowJob>;
}

async function detectFromCiWorkflows(
  localDir: string,
  evidence: EvidenceStore,
  policy?: CompiledProtectedPathPolicy,
): Promise<CommandRecord[]> {
  const files = lsFiles(localDir).filter((p) => /^\.github\/workflows\/.*\.ya?ml$/.test(p));
  const records: CommandRecord[] = [];
  for (const relPath of files) {
    const read = await readTrackedPublicFile(localDir, relPath, policy);
    if (read.status !== 'ok') continue;
    const content = read.content;
    let doc: WorkflowDoc;
    try {
      doc = (yaml.load(content) as WorkflowDoc) ?? {};
    } catch {
      continue;
    }
    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      const steps = Array.isArray(job.steps) ? (job.steps as WorkflowStep[]) : [];
      steps.forEach((step, idx) => {
        if (typeof step.run !== 'string') return;
        const argv = tokenizeSimpleCommand(step.run);
        const record = evidence.add({
          sourceType: 'repository-file',
          path: relPath,
          sensitivity: 'public',
          facts: [`CI workflow job "${jobName}" step ${idx} run command`, argv ? 'parsed as literal argv' : 'complex shell command — no CommandRecord emitted'],
          excerpt: step.run.length > 500 ? step.run.slice(0, 500) : step.run,
        });
        if (!argv) return; // complex/unsafe — evidence recorded above, no CommandRecord
        records.push(
          CommandRecordSchema.parse({
            schemaVersion: 'yellow-goal/command-record/v1',
            id: `cmd-ci-${slug(relPath)}-${slug(jobName)}-${idx}`,
            argv,
            workingDir: '.',
            source: 'ci-workflow',
            evidenceRefs: [record.id],
            confidence: 'configured',
            sideEffectClass: /test/i.test(jobName) ? 'test' : /build|lint/i.test(jobName) ? 'build' : 'unknown',
            executable: true,
          }),
        );
      });
    }
  }
  return records;
}

export async function detectCommands(
  localDir: string,
  manifests: ManifestFact[],
  evidence: EvidenceStore,
  policy?: CompiledProtectedPathPolicy,
): Promise<CommandRecord[]> {
  const [fromNpm, fromMake, fromCi] = await Promise.all([
    detectFromNpmScripts(manifests, evidence),
    detectFromMakefile(localDir, evidence, policy),
    detectFromCiWorkflows(localDir, evidence, policy),
  ]);
  return [...fromNpm, ...fromMake, ...fromCi];
}
