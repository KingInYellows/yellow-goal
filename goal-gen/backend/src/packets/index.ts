/**
 * `packets/` barrel. `backend/src/cli/commands.ts` dynamically imports this module and calls
 * `compilePacket`/`verifyPacket` — see that file's `loadOptionalModule('../packets/index')` /
 * `NotWiredError('compile'|'packet verify', ...)` usage.
 */
import type { CompileArgs, CompileFn, CompileResult, PacketVerifyArgs, PacketVerifyFn, PacketVerifyResult } from '../cli/types';
import { compilePacketImpl, ENGINE_VERSION, PacketCompilationError, type CompilePacketOptions } from './compiler';
import { verifyPacketPath, type VerifyOptions } from './packet-validator';

export * from './archive';
export * from './checksums';
export * from './fragment-renderers';
export { buildPacketManifest, PACKET_TIMESTAMP_FIELDS, type BuildManifestInput } from './manifest';
export {
  isPathSymlink,
  isTemplateRenderedPath,
  validatePacketPreZip,
  verifyExtractedDirectory,
  verifyPacketPath,
  verifyZipPacket,
  type PreZipValidationInput,
  type RenderedFile,
  type VerifyOptions,
} from './packet-validator';
export { compilePacketImpl, ENGINE_VERSION, PacketCompilationError, type CompilePacketOptions } from './compiler';

/** CLI-wired `compile`. `compilePacketImpl` accepts an optional second `options` argument (clock
 *  injection, pack-dir override) for tests; the CLI-facing export below only ever needs the
 *  1-argument `CompileFn` shape `backend/src/cli/commands.ts` expects. */
export const compilePacket: CompileFn = (args: CompileArgs): Promise<CompileResult> => compilePacketImpl(args);

/** Builds a `compilePacket` bound to fixed options (clock, pack dir) — used by tests that need a
 *  pinned clock for determinism assertions or a `packDirOverride` to point at a test pack copy. */
export function createCompilePacket(options: CompilePacketOptions): CompileFn {
  return (args: CompileArgs): Promise<CompileResult> => compilePacketImpl(args, options);
}

/** CLI-wired `packet verify`. Maps the richer `ValidationResult` down to the CLI's
 *  `{valid, errors}` shape; each failed check becomes one human-readable error line.
 *
 *  Does NOT pass `VerifyOptions` (`liveTargetPath`/`allowStale`) through — the CLI's `--target`/
 *  `--allow-stale` flags are wired via `createVerifyPacket` below (see `cli/commands.ts`); this
 *  plain export remains the no-options default for callers without a staleness gate. */
export const verifyPacket: PacketVerifyFn = async (args: PacketVerifyArgs): Promise<PacketVerifyResult> => {
  const result = await verifyPacketPath(args.packetPath);
  const errors = result.checks
    .filter((c) => c.status === 'failed')
    .map((c) => `${c.id}: ${c.description}${c.details ? ` (${c.details})` : ''}`);
  return { valid: result.overall === 'passed', errors };
};

/** Builds a `packet verify`-shaped function bound to fixed `VerifyOptions` — for tests, and a
 *  ready-made building block for wiring `--target`/`--allow-stale` once `PacketVerifyArgs` grows
 *  those fields. */
export function createVerifyPacket(options: VerifyOptions): PacketVerifyFn {
  return async (args: PacketVerifyArgs): Promise<PacketVerifyResult> => {
    const result = await verifyPacketPath(args.packetPath, options);
    const errors = result.checks
      .filter((c) => c.status === 'failed')
      .map((c) => `${c.id}: ${c.description}${c.details ? ` (${c.details})` : ''}`);
    return { valid: result.overall === 'passed', errors };
  };
}
