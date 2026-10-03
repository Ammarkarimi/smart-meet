import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseInsights, dedupeInsights, selectWindow, buildAnalysisPrompt, ALL_TYPES } from '../src/lib/analyzer.js';
import { rankWindows, buildWindows, selectTranscriptContext, normalizeSummary, buildQaSystemPrompt } from '../src/lib/qa.js';

const T0 = 1_700_000_000_000;
const seg = (seq, speaker, text) => ({ meetingId: 'm', seq, speaker, text, ts: T0 + seq * 10_000, source: 'tab' });

describe('analyzer', () => {
  const fresh = [seg(5, 'Alice', 'Can you send the Q3 numbers by Friday?'), seg(6, 'Bob', 'We should ship the API soon-ish.')];

  test('parseInsights normalizes, links segments and filters disabled types', () => {
    const raw = JSON.stringify({
      items: [
        { type: 'question', text: 'Alice asks you to send Q3 numbers by Friday.', quote: 'send the Q3 numbers', speaker: 'Alice', segment: 5, directed_at_user: true, priority: 'high', suggestion: 'Yes, I will send them Thursday.' },
        { type: 'Clarification', text: 'Ship date "soon-ish" is vague.', quote: 'ship the API soon-ish', speaker: 'Bob', segment: 99, directed_at_user: false, priority: 'urgent', suggestion: '' },
        { type: 'decision', text: 'Disabled type is dropped.', segment: 5 },
        { type: 'nonsense', text: 'Unknown type is dropped.' },
      ],
    });
    const items = parseInsights(raw, { meetingId: 'm', fresh, enabledTypes: ['question', 'clarification'] });
    assert.equal(items.length, 2);
    assert.equal(items[0].segmentSeq, 5);
    assert.equal(items[0].ts, fresh[0].ts);
    assert.equal(items[0].directedAtUser, true);
    assert.equal(items[1].type, 'clarification');
    assert.equal(items[1].segmentSeq, 6, 'falls back to quote match when segment number is wrong');
    assert.equal(items[1].priority, 'medium', 'invalid priority normalized');
    assert.equal(items[0].status, 'open');
  });

  test('parseInsights survives garbage', () => {
    assert.deepEqual(parseInsights('not json', { meetingId: 'm', fresh, enabledTypes: ALL_TYPES }), []);
    assert.deepEqual(parseInsights('{"items": "nope"}', { meetingId: 'm', fresh, enabledTypes: ALL_TYPES }), []);
  });

  test('dedupeInsights drops near-duplicates of existing and of each other', () => {
    const existing = [{ type: 'question', text: 'Alice asks you to send the Q3 numbers by Friday.' }];
    const candidates = [
      { type: 'question', text: 'Alice asked you to send Q3 numbers by Friday' },
      { type: 'question', text: 'Who owns the onboarding redesign?' },
      { type: 'question', text: 'Who owns onboarding redesign?' },
    ];
    const kept = dedupeInsights(candidates, existing);
    assert.deepEqual(kept.map((k) => k.text), ['Who owns the onboarding redesign?']);
  });

  test('selectWindow returns unanalyzed segments plus bounded earlier context', () => {
    const all = Array.from({ length: 50 }, (_, i) => seg(i, 'S', 'x'.repeat(100)));
    const { fresh: f, context } = selectWindow(all, 39, { contextChars: 500 });
    assert.deepEqual(f.map((s) => s.seq), [40, 41, 42, 43, 44, 45, 46, 47, 48, 49]);
    assert.ok(context.length > 0 && context.length <= 4);
    assert.equal(context[context.length - 1].seq, 39);
  });

  test('selectWindow caps a large backlog to the most recent lines', () => {
    const all = Array.from({ length: 200 }, (_, i) => seg(i, 'S', 'y'.repeat(200)));
    const { fresh: f, skipped } = selectWindow(all, -1, { maxFreshChars: 2300 });
    assert.equal(f[f.length - 1].seq, 199);
    assert.ok(f.length <= 11);
    assert.equal(skipped, 200 - f.length);
  });

  test('prompt contains the sections the model relies on', () => {
    const { system, user } = buildAnalysisPrompt({
      meeting: { id: 'm', title: 'Planning', startedAt: T0, notes: 'Budget is $40k' },
      profile: { name: 'Priya', about: 'PM' },
      enabledTypes: ['question', 'clarification'],
      suggestReplies: true,
      existing: [{ type: 'question', text: 'Old one' }],
      context: [seg(1, 'Alice', 'Hello')],
      fresh,
    });
    assert.match(system, /Priya/);
    assert.match(system, /"question"/);
    assert.doesNotMatch(system, /"action_item":/);
    assert.match(user, /ALREADY FLAGGED:\n- \[question\] Old one/);
    assert.match(user, /\[#5 00:50\] Alice: Can you send/);
    assert.match(user, /Budget is \$40k/);
  });
});

describe('qa retrieval', () => {
  const segments = [
    ...Array.from({ length: 40 }, (_, i) => seg(i, 'A', `general chatter about weather and weekend plans ${i}`)),
    seg(40, 'Bob', 'The pricing for the enterprise tier will be 49 dollars per seat'),
    seg(41, 'Alice', 'Pricing approval needs finance sign-off'),
    ...Array.from({ length: 40 }, (_, i) => seg(42 + i, 'A', `more unrelated discussion of travel logistics ${i}`)),
  ];

  test('BM25 ranks the relevant window first', () => {
    const ranked = rankWindows(buildWindows(segments, T0), 'what is the enterprise pricing per seat?');
    const best = ranked.sort((a, b) => b.score - a.score)[0];
    assert.match(best.text, /enterprise tier/);
  });

  test('full transcript when it fits; relevant excerpts when it does not', () => {
    assert.equal(selectTranscriptContext(segments, T0, 'pricing').partial, false);
    const { text, partial } = selectTranscriptContext(segments, T0, 'enterprise pricing seat', 1500);
    assert.equal(partial, true);
    assert.match(text, /enterprise tier/);
    assert.ok(text.length <= 1600);
  });

  test('system prompt grounds answers in the transcript', () => {
    const p = buildQaSystemPrompt({ meeting: { title: 'T', startedAt: T0 }, profile: {}, transcript: 'LINES', partial: true, insights: [] });
    assert.match(p, /excerpts most relevant/);
    assert.match(p, /LINES$/);
    assert.match(p, /\[12:34\]/);
  });

  test('normalizeSummary coerces loose model output', () => {
    const s = normalizeSummary({ title: ' Plan ', summary: 'S', key_points: ['a', '', null], decisions: 'x', action_items: ['Send deck', { owner: 'You', task: 'Book room', due: 'Mon' }, { task: '' }], open_questions: [] });
    assert.equal(s.title, 'Plan');
    assert.deepEqual(s.key_points, ['a']);
    assert.deepEqual(s.decisions, []);
    assert.deepEqual(s.action_items, [{ owner: '', task: 'Send deck', due: '' }, { owner: 'You', task: 'Book room', due: 'Mon' }]);
  });
});
