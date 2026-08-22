/**
 * `{{PLACEHOLDER}}` substitution — no logic in templates (`.claude/specs/packet-compiler.md`
 * "packs/" row). A placeholder is a dotted-path scalar (`{{ goalResolution.rationale }}`) or an
 * all-caps fragment key (`{{FINDINGS_TABLE_ROWS}}`) computed by compiler code before rendering —
 * see `packs/repository-goal-packet/v1/README.md`'s placeholder inventory. The renderer never
 * evaluates a loop or conditional itself; it only looks up keys in a flat map.
 */

const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export interface RenderResult {
  rendered: string;
  /** Placeholder keys the template referenced but `values` did not provide. */
  unresolved: string[];
}

/** Every distinct `{{ ... }}` key referenced in `templateText`, trimmed, in first-seen order. */
export function extractPlaceholders(templateText: string): string[] {
  const seen = new Set<string>();
  for (const match of templateText.matchAll(PLACEHOLDER_PATTERN)) {
    seen.add(match[1]!);
  }
  return [...seen];
}

/**
 * Substitutes every `{{ key }}` in `templateText` with `values[key]`. A key present in `values`
 * (even as `''`) is resolved; a key absent from `values` is left untouched in the output and
 * reported in `unresolved`. Callers decide whether an unresolved key is fatal (this pack treats
 * every placeholder that appears in a `.tmpl` file as required — see the pack README).
 */
export function renderTemplate(templateText: string, values: Readonly<Record<string, string>>): RenderResult {
  const unresolved: string[] = [];
  const seenUnresolved = new Set<string>();

  const rendered = templateText.replace(PLACEHOLDER_PATTERN, (full, rawKey: string) => {
    if (Object.prototype.hasOwnProperty.call(values, rawKey)) {
      return values[rawKey]!;
    }
    if (!seenUnresolved.has(rawKey)) {
      seenUnresolved.add(rawKey);
      unresolved.push(rawKey);
    }
    return full;
  });

  return { rendered, unresolved };
}

/** Thrown by callers that want unresolved-required-placeholder to be a hard failure. */
export class UnresolvedPlaceholderError extends Error {
  constructor(
    public readonly templateName: string,
    public readonly unresolved: readonly string[],
  ) {
    super(`${templateName}: unresolved required placeholder(s): ${unresolved.join(', ')}`);
    this.name = 'UnresolvedPlaceholderError';
  }
}

/** `renderTemplate`, but throws {@link UnresolvedPlaceholderError} if anything is unresolved. */
export function renderTemplateStrict(
  templateName: string,
  templateText: string,
  values: Readonly<Record<string, string>>,
): string {
  const { rendered, unresolved } = renderTemplate(templateText, values);
  if (unresolved.length > 0) {
    throw new UnresolvedPlaceholderError(templateName, unresolved);
  }
  return rendered;
}
