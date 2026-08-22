/**
 * Hand-rolled structural JSON Schema (draft 2020-12) checker — deliberately not ajv. Covers only
 * the keyword subset actually used across goal-gen/schemas/{vendored,app}/*.schema.json: type
 * (incl. arrays of types for nullable fields), required/properties/additionalProperties, enum,
 * const, pattern, minLength/maxLength, minItems/maxItems, minimum/maximum, uniqueItems, format:
 * date-time, $ref/$defs (local refs only), and anyOf. See goal-gen/schemas/README.md for why the
 * two cross-field invariants (CommandRecord, FinalHandoff) are intentionally NOT checked here.
 */

export interface JsonSchemaValidationResult {
  valid: boolean;
  errors: string[];
}

type JsonSchemaNode = Record<string, unknown>;

const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function resolveRef(root: JsonSchemaNode, ref: string): JsonSchemaNode {
  if (!ref.startsWith('#/')) {
    throw new Error(`unsupported $ref (only local refs supported): ${ref}`);
  }
  const parts = ref.slice(2).split('/');
  let node: unknown = root;
  for (const part of parts) {
    if (typeof node !== 'object' || node === null) {
      throw new Error(`cannot resolve $ref ${ref}: hit a non-object at "${part}"`);
    }
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== 'object' || node === null) {
    throw new Error(`cannot resolve $ref ${ref}: target is not an object`);
  }
  return node as JsonSchemaNode;
}

function typeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function validateNode(
  root: JsonSchemaNode,
  schemaNode: JsonSchemaNode,
  value: unknown,
  pathLabel: string,
  errors: string[],
): void {
  const node = typeof schemaNode.$ref === 'string' ? resolveRef(root, schemaNode.$ref) : schemaNode;

  if ('const' in node) {
    if (value !== node.const) {
      errors.push(`${pathLabel}: expected const ${JSON.stringify(node.const)}, got ${JSON.stringify(value)}`);
    }
    return;
  }

  if (Array.isArray(node.enum)) {
    if (!node.enum.includes(value)) {
      errors.push(`${pathLabel}: expected one of ${JSON.stringify(node.enum)}, got ${JSON.stringify(value)}`);
    }
    return;
  }

  if (Array.isArray(node.anyOf)) {
    const branchErrors: string[][] = [];
    const matched = node.anyOf.some((branch) => {
      const branchErrs: string[] = [];
      validateNode(root, branch as JsonSchemaNode, value, pathLabel, branchErrs);
      branchErrors.push(branchErrs);
      return branchErrs.length === 0;
    });
    if (!matched) {
      errors.push(`${pathLabel}: matched no anyOf branch (${JSON.stringify(branchErrors)})`);
    }
    return;
  }

  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? (node.type as string[]) : [node.type as string];
    if (!types.some((t) => typeMatches(t, value))) {
      errors.push(`${pathLabel}: expected type ${types.join('|')}, got ${JSON.stringify(value)}`);
      return;
    }
  }

  if (value === undefined || value === null) {
    return;
  }

  if (typeof value === 'string') {
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern).test(value)) {
      errors.push(`${pathLabel}: does not match pattern ${node.pattern}`);
    }
    if (typeof node.minLength === 'number' && value.length < node.minLength) {
      errors.push(`${pathLabel}: shorter than minLength ${node.minLength}`);
    }
    if (typeof node.maxLength === 'number' && value.length > node.maxLength) {
      errors.push(`${pathLabel}: longer than maxLength ${node.maxLength}`);
    }
    if (node.format === 'date-time' && !ISO_DATE_TIME_RE.test(value)) {
      errors.push(`${pathLabel}: not a valid date-time`);
    }
    return;
  }

  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) {
      errors.push(`${pathLabel}: below minimum ${node.minimum}`);
    }
    if (typeof node.maximum === 'number' && value > node.maximum) {
      errors.push(`${pathLabel}: above maximum ${node.maximum}`);
    }
    return;
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === 'number' && value.length < node.minItems) {
      errors.push(`${pathLabel}: fewer than minItems ${node.minItems}`);
    }
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) {
      errors.push(`${pathLabel}: more than maxItems ${node.maxItems}`);
    }
    if (node.uniqueItems === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) {
        errors.push(`${pathLabel}: items are not unique`);
      }
    }
    if (node.items !== undefined) {
      value.forEach((item, index) => {
        validateNode(root, node.items as JsonSchemaNode, item, `${pathLabel}[${index}]`, errors);
      });
    }
    return;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const properties = (node.properties as Record<string, JsonSchemaNode> | undefined) ?? {};
    const required = (node.required as string[] | undefined) ?? [];

    for (const key of required) {
      if (!(key in obj)) {
        errors.push(`${pathLabel}.${key}: missing required property`);
      }
    }

    for (const [key, propValue] of Object.entries(obj)) {
      const propSchema = properties[key];
      if (propSchema) {
        validateNode(root, propSchema, propValue, `${pathLabel}.${key}`, errors);
        continue;
      }
      if (node.additionalProperties === false) {
        errors.push(`${pathLabel}.${key}: additional property not allowed`);
      } else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
        validateNode(root, node.additionalProperties as JsonSchemaNode, propValue, `${pathLabel}.${key}`, errors);
      }
      // additionalProperties true/absent: no declared shape, anything goes.
    }
  }
}

export function validateAgainstJsonSchema(schema: JsonSchemaNode, value: unknown): JsonSchemaValidationResult {
  const errors: string[] = [];
  validateNode(schema, schema, value, '$', errors);
  return { valid: errors.length === 0, errors };
}
