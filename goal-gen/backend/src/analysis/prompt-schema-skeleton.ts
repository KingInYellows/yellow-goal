/**
 * Generates a field-by-field JSON skeleton of the expected `claude -p` analysis response,
 * introspected directly from the zod contract schemas (never hand-typed) — a repeat of the
 * live-smoke defect this fixes: the first prompt fix enumerated enum values but never described
 * full object shapes, so the model still produced findings missing required fields
 * (`schemaVersion`, `consequence`, `requiredBehavior`) and invented unrecognized keys
 * (`summary`, `recommendation`). Walking the real zod `_def` tree means the skeleton can never
 * hand-drift from `FindingSchema`/`RepositoryAssessmentSchema`/`GoalResolutionSchema`/
 * `MilestoneSpecSchema` the way a hand-written example inevitably would.
 *
 * Uses zod v3's internal `_def.typeName`/`_def.shape`/`_def.innerType`/`_def.type`/`_def.values`/
 * `_def.value` — the stable v3 "first-party type" introspection surface (not public API types,
 * but the same shape zod's own `zod-to-json-schema`-style tools walk). If zod is ever bumped to a
 * version with a different internal `_def` shape, `describeZodType`'s `switch` is the only place
 * that needs updating.
 */
import type { z } from 'zod';

type ZodDef = {
  typeName: string;
  shape?: Record<string, z.ZodTypeAny> | (() => Record<string, z.ZodTypeAny>);
  innerType?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  values?: readonly string[];
  value?: unknown;
};

function defOf(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

function shapeOf(def: ZodDef): Record<string, z.ZodTypeAny> {
  if (!def.shape) return {};
  return typeof def.shape === 'function' ? def.shape() : def.shape;
}

interface RenderContext {
  /** `keyPath` (dot-joined) -> schema to render INSTEAD of what's actually declared there — the
   *  one place this module needs a manual override: `RepositoryAssessmentSchema.findings` is
   *  `z.array(z.record(z.unknown()))` (loosely typed at the container level — see
   *  `output-validation.ts`), but the real per-element shape the model must produce is
   *  `FindingSchema`. Every other field is walked exactly as the schema declares it. */
  substitutions: Readonly<Record<string, z.ZodTypeAny>>;
}

/** Renders one zod node as a skeleton value at `indent`, tracking `keyPath` for substitutions and
 *  `required` so optional fields are marked. Unwraps `ZodOptional`/`ZodNullable`/`ZodDefault`
 *  transparently (the wrapped type is what actually matters for shape). */
function renderNode(schema: z.ZodTypeAny, keyPath: string, indent: string, required: boolean, ctx: RenderContext): string {
  const substituted = ctx.substitutions[keyPath];
  const target = substituted ?? schema;
  const def = defOf(target);

  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return renderNode(def.innerType!, keyPath, indent, false, ctx);

    case 'ZodLiteral':
      return JSON.stringify(def.value);

    case 'ZodEnum':
      return (def.values ?? []).map((v) => JSON.stringify(v)).join(' | ');

    case 'ZodString':
      return required ? '"<string, required>"' : '"<string>"';

    case 'ZodNumber':
      return required ? '<number, required>' : '<number>';

    case 'ZodBoolean':
      return required ? '<boolean, required>' : '<boolean>';

    case 'ZodArray': {
      const elementIndent = `${indent}  `;
      const element = renderNode(def.type!, `${keyPath}[]`, elementIndent, true, ctx);
      return `[\n${elementIndent}${element}\n${indent}]`;
    }

    case 'ZodRecord':
      return '{ /* any object */ }';

    case 'ZodObject': {
      const shape = shapeOf(def);
      const entries = Object.entries(shape);
      if (entries.length === 0) return '{}';
      const childIndent = `${indent}  `;
      const lines = entries.map(([key, valueSchema], i) => {
        const childDef = defOf(valueSchema);
        const isOptional = childDef.typeName === 'ZodOptional' || childDef.typeName === 'ZodNullable' || childDef.typeName === 'ZodDefault';
        const rendered = renderNode(valueSchema, keyPath ? `${keyPath}.${key}` : key, childIndent, !isOptional, ctx);
        const trailingComma = i < entries.length - 1 ? ',' : '';
        const comment = isOptional ? ' // optional' : '';
        return `${childIndent}"${key}": ${rendered}${trailingComma}${comment}`;
      });
      return `{\n${lines.join('\n')}\n${indent}}`;
    }

    default:
      return '<any>';
  }
}

/** Renders `schema` as a top-level JSON skeleton, with `substitutions` applied at the given
 *  dot-joined key paths (relative to the schema's own root — e.g. `"findings[]"` inside a
 *  `RepositoryAssessmentSchema` render substitutes what each element of the `findings` array is
 *  described as). */
export function renderSchemaSkeleton(schema: z.ZodTypeAny, substitutions: Readonly<Record<string, z.ZodTypeAny>> = {}): string {
  return renderNode(schema, '', '', true, { substitutions });
}

/** Every REQUIRED (non-optional) top-level key of an object schema, for tests that assert a
 *  generated skeleton mentions each one — the anti-rot check the team lead asked for. */
export function requiredKeysOf(schema: z.ZodTypeAny): string[] {
  const def = defOf(schema);
  if (def.typeName !== 'ZodObject') return [];
  return Object.entries(shapeOf(def))
    .filter(([, value]) => {
      const childDef = defOf(value);
      return childDef.typeName !== 'ZodOptional' && childDef.typeName !== 'ZodNullable' && childDef.typeName !== 'ZodDefault';
    })
    .map(([key]) => key);
}
