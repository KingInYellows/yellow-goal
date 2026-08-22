import { z } from 'zod';

/** FinalHandoff — mirrors goal-gen/schemas/app/final-handoff.schema.json. Net-new app contract:
 *  the terminal status of a compile run. The READY_AFTER_ONE_NAMED_ACTION/remainingAction
 *  invariant is enforced here via `.refine`, not in the structural JSON Schema (documented in the
 *  schema's `remainingAction` description). */
export const FinalHandoffSchemaVersion = 'yellow-goal/final-handoff/v1' as const;

const FinalHandoffStatus = z.enum([
  'PR_READY_FOR_HUMAN_REVIEW',
  'READY_AFTER_ONE_NAMED_ACTION',
  'DO_NOT_MERGE',
]);

const FinalHandoffTargetSchema = z
  .object({
    repository: z.string(),
    headSha: z.string(),
  })
  .strict();

export const FinalHandoffSchema = z
  .object({
    schemaVersion: z.literal(FinalHandoffSchemaVersion),
    status: FinalHandoffStatus,
    target: FinalHandoffTargetSchema,
    evidenceSummary: z.array(z.string()),
    remainingAction: z.string().optional(),
  })
  .strict()
  .refine(
    (handoff) =>
      handoff.status !== 'READY_AFTER_ONE_NAMED_ACTION' ||
      (handoff.remainingAction !== undefined && handoff.remainingAction.length > 0),
    {
      message: 'READY_AFTER_ONE_NAMED_ACTION requires a non-empty remainingAction',
      path: ['remainingAction'],
    },
  );

export type FinalHandoff = z.infer<typeof FinalHandoffSchema>;
