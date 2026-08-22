import { z } from 'zod';

/** PacketManifest — mirrors goal-gen/schemas/vendored/packet-manifest.schema.json, including the
 *  documented completion against 07_PACKET_CONTRACT.md's "Manifest requirements" section
 *  (schemas/README.md). */
export const PacketManifestSchemaVersion = 'yellow-goal/packet-manifest/v1' as const;

const PacketManifestPackSchema = z.object({
  id: z.string(),
  version: z.string(),
});

const PacketManifestTargetSchema = z.object({
  repository: z.string(),
  requestedRef: z.string().optional(),
  resolvedRef: z.string().optional(),
  headSha: z.string(),
});

const PacketManifestFileSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  bytes: z.number().int().min(0).optional(),
});

const PacketManifestValidationSchema = z.object({
  status: z.enum(['passed', 'failed']),
  errors: z.array(z.string()).optional(),
});

export const PacketManifestSchema = z
  .object({
    schemaVersion: z.literal(PacketManifestSchemaVersion),
    packetId: z.string(),
    engineVersion: z.string(),
    pack: PacketManifestPackSchema,
    requestId: z.string().min(1),
    target: PacketManifestTargetSchema,
    inspectionStartedAt: z.string().datetime({ offset: true }),
    inspectionCompletedAt: z.string().datetime({ offset: true }),
    analysisModels: z.record(z.string()),
    resolvedOrchestrationModels: z.record(z.string()),
    tools: z.record(z.unknown()),
    schemas: z.record(z.string()),
    files: z.array(PacketManifestFileSchema),
    humanGates: z.array(z.string()),
    evidenceGaps: z.array(z.string()),
    timestampFields: z.array(z.string()),
    predecessorPacketId: z.string().optional(),
    targetMutationOccurred: z.literal(false),
    validation: PacketManifestValidationSchema,
  })
  .strict();

export type PacketManifest = z.infer<typeof PacketManifestSchema>;
