import { describe, expect, it } from 'vitest';
import { validateAgainstJsonSchema } from './support/json-schema-checker';

/** Direct unit coverage of the hand-rolled checker itself, independent of any real contract
 *  schema — exercises the keyword subset it claims to support. */

describe('validateAgainstJsonSchema', () => {
  it('rejects an additional property when additionalProperties is false', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['a'],
      properties: { a: { type: 'string' } },
    };
    const result = validateAgainstJsonSchema(schema, { a: 'x', b: 'unexpected' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('b'))).toBe(true);
  });

  it('allows an additional property when additionalProperties is absent', () => {
    const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' } } };
    const result = validateAgainstJsonSchema(schema, { a: 'x', b: 'fine' });
    expect(result.valid).toBe(true);
  });

  it('type-checks a typed additionalProperties map', () => {
    const schema = { type: 'object', additionalProperties: { type: 'boolean' } };
    expect(validateAgainstJsonSchema(schema, { flag: true }).valid).toBe(true);
    expect(validateAgainstJsonSchema(schema, { flag: 'not-a-boolean' }).valid).toBe(false);
  });

  it('flags a missing required property', () => {
    const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' } } };
    expect(validateAgainstJsonSchema(schema, {}).valid).toBe(false);
  });

  it('checks enum membership', () => {
    const schema = { enum: ['x', 'y'] };
    expect(validateAgainstJsonSchema(schema, 'x').valid).toBe(true);
    expect(validateAgainstJsonSchema(schema, 'z').valid).toBe(false);
  });

  it('checks const equality', () => {
    const schema = { const: false };
    expect(validateAgainstJsonSchema(schema, false).valid).toBe(true);
    expect(validateAgainstJsonSchema(schema, true).valid).toBe(false);
  });

  it('checks string pattern, minLength, and date-time format', () => {
    const schema = { type: 'string', pattern: '^F-[0-9]+$', minLength: 3 };
    expect(validateAgainstJsonSchema(schema, 'F-1').valid).toBe(true);
    expect(validateAgainstJsonSchema(schema, 'X-1').valid).toBe(false);

    const dateSchema = { type: 'string', format: 'date-time' };
    expect(validateAgainstJsonSchema(dateSchema, '2026-08-22T00:00:00Z').valid).toBe(true);
    expect(validateAgainstJsonSchema(dateSchema, 'not-a-date').valid).toBe(false);
  });

  it('checks numeric minimum/maximum', () => {
    const schema = { type: 'integer', minimum: 1, maximum: 3 };
    expect(validateAgainstJsonSchema(schema, 2).valid).toBe(true);
    expect(validateAgainstJsonSchema(schema, 0).valid).toBe(false);
    expect(validateAgainstJsonSchema(schema, 4).valid).toBe(false);
  });

  it('checks array minItems and uniqueItems', () => {
    const schema = { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } };
    expect(validateAgainstJsonSchema(schema, ['a']).valid).toBe(true);
    expect(validateAgainstJsonSchema(schema, []).valid).toBe(false);
    expect(validateAgainstJsonSchema(schema, ['a', 'a']).valid).toBe(false);
  });

  it('resolves a local $ref against $defs', () => {
    const schema = {
      type: 'object',
      properties: { item: { $ref: '#/$defs/item' } },
      $defs: { item: { type: 'string', minLength: 2 } },
    };
    expect(validateAgainstJsonSchema(schema, { item: 'ok' }).valid).toBe(true);
    expect(validateAgainstJsonSchema(schema, { item: 'x' }).valid).toBe(false);
  });

  it('checks anyOf', () => {
    const schema = { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }] };
    expect(validateAgainstJsonSchema(schema, 5).valid).toBe(true);
    expect(validateAgainstJsonSchema(schema, 'ok').valid).toBe(true);
    expect(validateAgainstJsonSchema(schema, false).valid).toBe(false);
  });

  it('allows a nullable field expressed as a type array', () => {
    const schema = { type: ['string', 'null'] };
    expect(validateAgainstJsonSchema(schema, null).valid).toBe(true);
    expect(validateAgainstJsonSchema(schema, 'x').valid).toBe(true);
    expect(validateAgainstJsonSchema(schema, 5).valid).toBe(false);
  });
});
