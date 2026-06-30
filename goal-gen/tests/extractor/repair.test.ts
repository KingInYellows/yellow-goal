/**
 * Repair-round unit test (plan task 5.2) — proves the load-bearing path WITHOUT a real `claude -p`
 * call (zero spend): a malformed LLM response is fed through pre-processing + one zod-repair round
 * and must come out a schema-valid GoalSpec, while a genuinely-irreparable response raises a
 * structured ExtractionError. The extractor authors through the swappable `LlmClient`, so a scripted
 * in-memory client is a drop-in.
 */
import { describe, expect, it } from 'vitest';
import { plan } from '../../backend/src/planner/plan';
import {
  dedupeIds,
  ExtractionError,
  LlmExtractorImpl,
  parseJson,
  preprocessJson,
} from '../../backend/src/extractors/llm-extractor';
import type { LlmClient, LlmCompletion } from '../../backend/src/extractors/llm-extractor';
import type { Action } from '../../backend/src/planner/types';

/** Scripted LlmClient: returns the next queued completion per `complete()` call. */
class ScriptedClient implements LlmClient {
  calls = 0;
  constructor(private readonly responses: string[]) {}
  async complete(): Promise<LlmCompletion> {
    const text = this.responses[this.calls] ?? '';
    this.calls++;
    return { text, costUsd: 0 };
  }
}

const VALID_GOALSPEC = {
  goalText: 'create a file',
  initialState: { created: false },
  goalState: { created: true },
  constraints: [],
  completionPolicy: 'verify-only',
  actions: [
    {
      id: 'a1',
      name: 'create the file',
      cost: 1,
      preconditions: { created: false },
      effects: { created: true },
      executor: 'claude-code',
      payload: { prompt: 'create file f' },
      verify: { command: 'test -f f' },
    },
  ],
};

/** Capture the structured measurement events the extractor emits. */
function makeExtractor(responses: string[]): { extractor: LlmExtractorImpl; client: ScriptedClient; events: Record<string, unknown>[] } {
  const client = new ScriptedClient(responses);
  const events: Record<string, unknown>[] = [];
  const extractor = new LlmExtractorImpl(client, { onEvent: (e) => events.push(e) });
  return { extractor, client, events };
}

describe('preprocessJson + parseJson', () => {
  it('preprocessJson strips ```json fences and surrounding prose (no comma repair)', () => {
    expect(JSON.parse(preprocessJson('```json\n{"a":1}\n```'))).toEqual({ a: 1 });
    expect(JSON.parse(preprocessJson('Here is your spec:\n{"a":1}\nHope that helps!'))).toEqual({ a: 1 });
  });
  it('parseJson repairs a trailing comma as a fallback', () => {
    const r = parseJson('{"a":1,}');
    expect(r.ok && r.value).toEqual({ a: 1 });
  });
  it('parseJson parses valid JSON as-is, NEVER corrupting a command containing ",}"', () => {
    // regression: the old unconditional trailing-comma regex mangled `,}` inside a string value.
    const r = parseJson(`{"cmd":"awk '{print NR,}' f"}`);
    expect(r.ok && r.value).toEqual({ cmd: "awk '{print NR,}' f" });
  });
});

describe('extractor repair round', () => {
  it('succeeds on the first try, fixing fences + a trailing comma via the parse fallback', async () => {
    const fenced = '```json\n' + JSON.stringify(VALID_GOALSPEC).replace(/}$/, ',}') + '\n```';
    const { extractor, client, events } = makeExtractor([fenced]);
    const { goalSpec: spec } = await extractor.extract({ goalText: 'create a file' });
    expect(client.calls).toBe(1); // no repair needed
    expect(spec.actions).toHaveLength(1);
    expect(plan(spec)).not.toBeNull(); // the extracted spec is actually plannable
    expect(events).toContainEqual({ ev: 'extract.measure', firstTry: true, repairNeeded: false, success: true, costUsd: 0 });
  });

  it('repairs a zod-invalid first response (missing completionPolicy) on the second call', async () => {
    const { completionPolicy: _omit, ...missingPolicy } = VALID_GOALSPEC;
    const { extractor, client, events } = makeExtractor([
      JSON.stringify(missingPolicy), // parseable JSON but fails the schema
      JSON.stringify(VALID_GOALSPEC), // repaired
    ]);
    const { goalSpec: spec } = await extractor.extract({ goalText: 'create a file' });
    expect(client.calls).toBe(2); // exactly one repair round
    expect(spec.completionPolicy).toBe('verify-only');
    expect(events).toContainEqual({ ev: 'extract.measure', firstTry: false, repairNeeded: true, success: true, costUsd: 0 });
  });

  it('throws a structured ExtractionError when repair also fails', async () => {
    const { completionPolicy: _omit, ...missingPolicy } = VALID_GOALSPEC;
    const bad = JSON.stringify(missingPolicy);
    const { extractor, client, events } = makeExtractor([bad, bad]);
    await expect(extractor.extract({ goalText: 'create a file' })).rejects.toBeInstanceOf(ExtractionError);
    expect(client.calls).toBe(2); // first + exactly one repair, then give up
    expect(events).toContainEqual({ ev: 'extract.measure', firstTry: false, repairNeeded: true, success: false, costUsd: 0 });
  });

  it('rejects a response with an empty verify (the load-bearing refinement)', async () => {
    const noVerify = {
      ...VALID_GOALSPEC,
      actions: [{ ...VALID_GOALSPEC.actions[0], verify: {} }],
    };
    const bad = JSON.stringify(noVerify);
    const { extractor } = makeExtractor([bad, bad]);
    await expect(extractor.extract({ goalText: 'x' })).rejects.toBeInstanceOf(ExtractionError);
  });

  it('rejects an action whose verify has only a successPredicate (no ground-truth command)', async () => {
    const spOnly = {
      ...VALID_GOALSPEC,
      actions: [{ ...VALID_GOALSPEC.actions[0], verify: { successPredicate: { created: true } } }],
    };
    const bad = JSON.stringify(spOnly);
    const { extractor } = makeExtractor([bad, bad]);
    await expect(extractor.extract({ goalText: 'x' })).rejects.toBeInstanceOf(ExtractionError);
  });
});

/** A valid Action (verify.command satisfies the tightened schema) for expand/dedup coverage. */
const act = (id: string): Action => ({
  id,
  name: id,
  cost: 1,
  preconditions: {},
  effects: { [id]: true },
  executor: 'claude-code',
  payload: {},
  verify: { command: `test-${id}` },
});

describe('extractor expand() — repair round + dedup guard (acceptance #6)', () => {
  it('parses a JSON action array on the first try', async () => {
    const { extractor, client } = makeExtractor([JSON.stringify([act('install')])]);
    const { actions: added } = await extractor.expand('goal', {}, { actionId: 'x' }, []);
    expect(client.calls).toBe(1);
    expect(added.map((a) => a.id)).toEqual(['install']);
  });

  it('repairs an invalid first response on the second call', async () => {
    const { extractor, client } = makeExtractor(['not json at all', JSON.stringify([act('install')])]);
    const { actions: added } = await extractor.expand('goal', {}, { actionId: 'x' }, []);
    expect(client.calls).toBe(2);
    expect(added).toHaveLength(1);
  });

  it('renames a new action whose id collides with the existing pool', async () => {
    const { extractor } = makeExtractor([JSON.stringify([act('install')])]);
    const { actions: added } = await extractor.expand('goal', {}, { actionId: 'x' }, [act('install')]);
    expect(added[0]?.id).toMatch(/^install-ext\d+$/); // disjoint from the existing pool
  });
});

describe('dedupeIds', () => {
  it('keeps clean ids and renames collisions (vs existing pool AND intra-batch)', () => {
    const ids = dedupeIds([act('a'), act('b'), act('a')], [act('b')]).map((a) => a.id);
    expect(ids[0]).toBe('a'); // clean, untouched
    expect(ids[1]).toMatch(/^b-ext\d+$/); // collides with existing 'b'
    expect(ids[2]).toMatch(/^a-ext\d+$/); // collides with the earlier new 'a'
    expect(new Set(ids).size).toBe(3); // all unique now
  });
});
