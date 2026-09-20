import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex, trustedCheckerIdentity } from './implementation-revision';
import type { ObservedCheckSpec } from './observed-fixture-profiles';

const checksDir = path.dirname(fileURLToPath(import.meta.url)) + '/candidate-offline-checks';

export const CandidateFileContentSchemaVersion = 'yellow-goal/candidate-file-content/v1' as const;
export const CandidateOfflineSchemaVersion = 'yellow-goal/candidate-offline-milestone/v1' as const;

export const CANDIDATE_MAX_FILES = 16;
export const CANDIDATE_MAX_FILE_BYTES = 16 * 1024;
export const CANDIDATE_MAX_DEPTH = 4;
export const CANDIDATE_MAX_DOCUMENT_BYTES = 512 * 1024;

export type CandidateOfflineProfileId = 'config-repair';

export type CandidateOfflineProfile = {
  id: CandidateOfflineProfileId;
  version: string;
  timeoutMs: number;
  requiredCheckIds: string[];
  checks: ObservedCheckSpec[];
  baseFiles: Record<string, string>;
  allowedPaths: string[];
  maxFiles: number;
  maxFileBytes: number;
  maxDepth: number;
  maxDocumentBytes: number;
};

export type CandidateFileDocument = {
  schemaVersion: typeof CandidateFileContentSchemaVersion;
  files: Record<string, string>;
};

function nodeCheck(script: string): string[] {
  return [process.execPath, path.join(checksDir, script)];
}

function configRepairProfile(): CandidateOfflineProfile {
  const schemaHost: ObservedCheckSpec = {
    id: 'schema-host',
    argv: nodeCheck('schema-host.mjs'),
    command: 'candidate-offline:config-repair:schema-host',
    cwd: '.',
  };
  const siteBind: ObservedCheckSpec = {
    id: 'site-bind',
    argv: nodeCheck('site-bind.mjs'),
    command: 'candidate-offline:config-repair:site-bind',
    cwd: '.',
  };
  return {
    id: 'config-repair',
    version: '1',
    timeoutMs: 5_000,
    requiredCheckIds: [schemaHost.id, siteBind.id],
    checks: [schemaHost, siteBind],
    baseFiles: {
      'site.json': '{"host":"","retries":0,"mode":"live"}\n',
      SITE: '\n',
      'keep.txt': 'keep\n',
    },
    allowedPaths: ['site.json', 'SITE'],
    maxFiles: CANDIDATE_MAX_FILES,
    maxFileBytes: CANDIDATE_MAX_FILE_BYTES,
    maxDepth: CANDIDATE_MAX_DEPTH,
    maxDocumentBytes: CANDIDATE_MAX_DOCUMENT_BYTES,
  };
}

export function listCandidateOfflineProfiles(): CandidateOfflineProfile[] {
  return [configRepairProfile()];
}

export function getCandidateOfflineProfile(id: string): CandidateOfflineProfile {
  const match = listCandidateOfflineProfiles().find((profile) => profile.id === id);
  if (!match) {
    throw new Error(`unknown candidate-offline profile: ${id}`);
  }
  return match;
}

export function configRepairCandidates(): {
  alpha: CandidateFileDocument;
  beta: CandidateFileDocument;
  baseline: CandidateFileDocument;
  incorrect: CandidateFileDocument;
  extraFile: CandidateFileDocument;
  selfAssert: CandidateFileDocument;
  weaken: CandidateFileDocument;
} {
  return {
    alpha: {
      schemaVersion: CandidateFileContentSchemaVersion,
      files: {
        'site.json': '{"host":"alpha.test","retries":2,"mode":"offline"}\n',
        SITE: 'alpha.test\n',
      },
    },
    beta: {
      schemaVersion: CandidateFileContentSchemaVersion,
      files: {
        'site.json': '{"host":"beta.example","retries":5,"mode":"offline"}\n',
        SITE: 'beta.example\n',
      },
    },
    baseline: {
      schemaVersion: CandidateFileContentSchemaVersion,
      files: {},
    },
    incorrect: {
      schemaVersion: CandidateFileContentSchemaVersion,
      files: {
        'site.json': '{"host":"nope.invalid","retries":9,"mode":"live"}\n',
        SITE: 'nope.invalid\n',
      },
    },
    extraFile: {
      schemaVersion: CandidateFileContentSchemaVersion,
      files: {
        'site.json': '{"host":"alpha.test","retries":2,"mode":"offline"}\n',
        SITE: 'alpha.test\n',
        'extra.txt': 'unauthorized\n',
      },
    },
    selfAssert: {
      schemaVersion: CandidateFileContentSchemaVersion,
      files: {
        'site.json': '{"host":"","retries":0,"mode":"live"}\n',
        SITE: '\n',
        '_acceptance.json': '{"accepted":true}\n',
      },
    },
    weaken: {
      schemaVersion: CandidateFileContentSchemaVersion,
      files: {
        'site.json': '{"host":"alpha.test","retries":2,"mode":"offline"}\n',
        SITE: 'alpha.test\n',
        'schema-host.mjs': 'process.exit(0);\n',
      },
    },
  };
}

export function candidateProfileDigest(profile: CandidateOfflineProfile): string {
  return sha256Hex(
    JSON.stringify({
      id: profile.id,
      version: profile.version,
      timeoutMs: profile.timeoutMs,
      requiredCheckIds: profile.requiredCheckIds,
      allowedPaths: profile.allowedPaths,
      baseFiles: profile.baseFiles,
      maxFiles: profile.maxFiles,
      maxFileBytes: profile.maxFileBytes,
      maxDepth: profile.maxDepth,
      maxDocumentBytes: profile.maxDocumentBytes,
      checkers: profile.checks.map(trustedCheckerIdentity),
    }),
  );
}
