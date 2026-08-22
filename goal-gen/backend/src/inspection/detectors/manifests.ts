/**
 * Detects package/dependency manifests (npm, Python, Go, Rust, generic infra-as-code) and derives
 * `repositoryKinds` — a repository can legitimately carry more than one (the `multi-package-manager`
 * fixture exists specifically to prove this isn't assumed single-language).
 */
import type { EvidenceStore } from '../../evidence/store';
import { lsFiles } from '../git';
import type { CompiledProtectedPathPolicy } from '../policy';
import { readTrackedPublicFile } from '../safe-tracked-read';

export interface ManifestFact {
  kind: string;
  path: string;
  /** Parsed npm scripts, when this manifest is a package.json — used by the commands detector. */
  npmScripts?: Record<string, string>;
}

export interface ManifestsResult {
  manifests: ManifestFact[];
  repositoryKinds: string[];
  evidenceRefs: string[];
}

const MANIFEST_KINDS: { pattern: RegExp; kind: string }[] = [
  { pattern: /(^|\/)package\.json$/, kind: 'node' },
  { pattern: /(^|\/)pyproject\.toml$/, kind: 'python' },
  { pattern: /(^|\/)requirements\.txt$/, kind: 'python' },
  { pattern: /(^|\/)go\.mod$/, kind: 'go' },
  { pattern: /(^|\/)Cargo\.toml$/, kind: 'rust' },
  { pattern: /(^|\/)main\.tf$/, kind: 'terraform' },
  { pattern: /(^|\/)playbook\.ya?ml$/, kind: 'ansible' },
];

interface PackageJsonShape {
  name?: unknown;
  version?: unknown;
  scripts?: unknown;
}

export async function detectManifests(
  localDir: string,
  evidence: EvidenceStore,
  policy?: CompiledProtectedPathPolicy,
): Promise<ManifestsResult> {
  const files = lsFiles(localDir);
  const manifests: ManifestFact[] = [];
  const evidenceRefs: string[] = [];
  const kinds = new Set<string>();

  for (const relPath of files) {
    const matched = MANIFEST_KINDS.find((m) => m.pattern.test(relPath));
    if (!matched) continue;
    kinds.add(matched.kind);

    let npmScripts: Record<string, string> | undefined;
    let facts = [`manifest present at ${relPath}`, `kind=${matched.kind}`];
    let excerpt: string | undefined;

    if (matched.kind === 'node' && /(^|\/)package\.json$/.test(relPath)) {
      const read = await readTrackedPublicFile(localDir, relPath, policy);
      if (read.status === 'ok') {
        try {
          const parsed = JSON.parse(read.content) as PackageJsonShape;
          if (parsed.scripts && typeof parsed.scripts === 'object') {
            npmScripts = Object.fromEntries(
              Object.entries(parsed.scripts as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
            );
            facts = [...facts, `scriptCount=${Object.keys(npmScripts).length}`];
          }
          excerpt = read.content.length > 2000 ? read.content.slice(0, 2000) : read.content;
        } catch {
          // invalid JSON — still record the manifest's presence, just without scripts.
        }
      } else if (read.reason !== 'unreadable') {
        facts = [...facts, `content not read: ${read.reason}`];
      }
    }

    const record = evidence.add({
      sourceType: 'repository-file',
      path: relPath,
      sensitivity: 'public',
      facts,
      ...(excerpt !== undefined ? { excerpt } : {}),
    });
    evidenceRefs.push(record.id);
    manifests.push({ kind: matched.kind, path: relPath, ...(npmScripts ? { npmScripts } : {}) });
  }

  return { manifests, repositoryKinds: [...kinds].sort(), evidenceRefs };
}
