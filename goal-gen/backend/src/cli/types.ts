/**
 * Narrow interfaces for the commands that delegate to other workers' modules. These describe the
 * function shape `inspect`/`analyze`/`compile`/`packet verify` expect to call — the lead wires the
 * real implementation in at integration time (see backend/src/cli/commands.ts's NotWiredError
 * usage for exactly which module path/export name each command currently looks for).
 */

export interface InspectArgs {
  requestPath: string;
  outputDir: string;
}

export interface InspectResult {
  repoProfilePath: string;
  [key: string]: unknown;
}

export type InspectFn = (args: InspectArgs) => Promise<InspectResult>;

export interface AnalyzeArgs {
  requestPath: string;
  repoProfilePath: string;
  outputDir: string;
}

export interface AnalyzeResult {
  assessmentPath: string;
  goalResolutionPath: string;
  milestonePath: string;
  [key: string]: unknown;
}

export type AnalyzeFn = (args: AnalyzeArgs) => Promise<AnalyzeResult>;

export interface CompileArgs {
  requestPath: string;
  assessmentPath: string;
  pack: string;
  outputDir: string;
}

export interface CompileResult {
  packetPath: string;
  manifestPath: string;
  [key: string]: unknown;
}

export type CompileFn = (args: CompileArgs) => Promise<CompileResult>;

export interface PacketVerifyArgs {
  packetPath: string;
}

export interface PacketVerifyResult {
  valid: boolean;
  errors: string[];
}

export type PacketVerifyFn = (args: PacketVerifyArgs) => Promise<PacketVerifyResult>;
