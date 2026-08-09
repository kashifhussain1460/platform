import { extractJson } from './extract-json';

describe('extractJson (tolerant LLM JSON parsing — G35)', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON wrapped in a ```json fence — the case that used to fail', () => {
    const raw = '```json\n{"type":"draft","definition":{"nodes":[]}}\n```';
    expect(extractJson(raw)).toEqual({ type: 'draft', definition: { nodes: [] } });
  });

  it('parses a bare ``` fence with no language tag', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('pulls the object out of surrounding prose', () => {
    const raw = 'Sure! Here is the workflow:\n{"type":"question","message":"which tool?"}\nHope that helps.';
    expect(extractJson(raw)).toEqual({ type: 'question', message: 'which tool?' });
  });

  it('keeps braces that live inside string values', () => {
    const raw = '{"prompt":"Use {{trigger.lead}} here","n":2}';
    expect(extractJson(raw)).toEqual({ prompt: 'Use {{trigger.lead}} here', n: 2 });
  });

  it('handles an escaped quote inside a string', () => {
    expect(extractJson('{"q":"say \\"hi\\" now"}')).toEqual({ q: 'say "hi" now' });
  });

  it('parses a top-level array', () => {
    expect(extractJson('```json\n[1,2,3]\n```')).toEqual([1, 2, 3]);
  });

  it('returns null (never throws) for junk, empty and truncated input', () => {
    expect(extractJson('not json at all')).toBeNull();
    expect(extractJson('')).toBeNull();
    expect(extractJson(undefined)).toBeNull();
    // Truncated mid-object — unbalanced, so there is no span to recover.
    expect(extractJson('{"a":1,"b":')).toBeNull();
  });
});
