import { describe, expect, it } from 'vitest';
import { extractPlaceholders, renderTemplate, renderTemplateStrict, UnresolvedPlaceholderError } from '../../backend/src/packs/template-renderer';

describe('extractPlaceholders', () => {
  it('finds both scalar dotted-path and SCREAMING_SNAKE fragment placeholders, deduplicated', () => {
    const text = '{{ foo.bar }} plain text {{FRAGMENT_ONE}} more {{ foo.bar }} {{FRAGMENT_TWO}}';
    expect(extractPlaceholders(text)).toEqual(['foo.bar', 'FRAGMENT_ONE', 'FRAGMENT_TWO']);
  });
});

describe('renderTemplate', () => {
  it('substitutes every provided key, including an empty-string value (resolved, not unresolved)', () => {
    const { rendered, unresolved } = renderTemplate('a={{ a }} b={{ b }}', { a: 'X', b: '' });
    expect(rendered).toBe('a=X b=');
    expect(unresolved).toEqual([]);
  });

  it('leaves an unmapped placeholder untouched and reports it as unresolved exactly once', () => {
    const { rendered, unresolved } = renderTemplate('{{ known }} {{ unknown }} {{ unknown }}', { known: 'K' });
    expect(rendered).toBe('K {{ unknown }} {{ unknown }}');
    expect(unresolved).toEqual(['unknown']);
  });

  it('performs no logic — a template with no placeholders round-trips byte for byte', () => {
    const text = '# Plain markdown\n\nNo placeholders here.\n';
    expect(renderTemplate(text, {}).rendered).toBe(text);
  });
});

describe('renderTemplateStrict', () => {
  it('throws UnresolvedPlaceholderError naming every missing key when the context is incomplete', () => {
    expect(() => renderTemplateStrict('t.md', '{{ a }} {{ b }}', { a: 'x' })).toThrowError(UnresolvedPlaceholderError);
    try {
      renderTemplateStrict('t.md', '{{ a }} {{ b }}', { a: 'x' });
    } catch (e) {
      expect((e as UnresolvedPlaceholderError).unresolved).toEqual(['b']);
      expect((e as UnresolvedPlaceholderError).templateName).toBe('t.md');
    }
  });

  it('returns the rendered text when every placeholder resolves', () => {
    expect(renderTemplateStrict('t.md', '{{ a }}-{{ b }}', { a: '1', b: '2' })).toBe('1-2');
  });
});
