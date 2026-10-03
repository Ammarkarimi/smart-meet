import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SSEParser } from '../src/lib/sse.js';
import { renderMarkdown, escapeHtml } from '../src/lib/markdown.js';
import { isLikelyHallucination, mergeForDisplay, formatSegment, tailLines } from '../src/lib/transcript.js';
import { formatOffset, detectPlatform, cleanMeetingTitle, similarity } from '../src/lib/util.js';
import { buildTranscriptionRequest, parseTranscription, isSttConfigured } from '../src/lib/transcription.js';
import { mergeDefaults, DEFAULT_SETTINGS, resolveCaptureMode, llmConfig, sttConfig, isLlmConfigured } from '../src/lib/settings.js';
import { meetingToMarkdown } from '../src/lib/export.js';
import '../src/content/caption-diff.js';

const { newTextSince } = globalThis.SmartMeetCaptionDiff;

describe('SSEParser', () => {
  test('handles split chunks, CRLF, comments and multi-line data', () => {
    const p = new SSEParser();
    const out = [
      ...p.push(': keepalive\r\nevent: a\r\ndata: one\r\n'),
      ...p.push('data: two\r\n\r\ndata: {"x"'),
      ...p.push(':1}\n\n'),
      ...p.push('data: tail'),
      ...p.end(),
    ];
    assert.deepEqual(out, [
      { event: 'a', data: 'one\ntwo' },
      { event: 'message', data: '{"x":1}' },
      { event: 'message', data: 'tail' },
    ]);
  });
});

describe('markdown', () => {
  test('escapes HTML and never emits script or javascript: links', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> **bold** [x](javascript:alert(1)) [ok](https://a.b/c?d=1&e=2)');
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /href="javascript/);
    assert.match(html, /&lt;img/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<a href="https:\/\/a\.b\/c\?d=1&amp;e=2" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  });

  test('lists, headings, code, timestamps and tables', () => {
    const html = renderMarkdown('## Title\n- one\n- two\n\n1. first\n\n`a<b>`\n\nAt [12:34] Bob said.\n\n| A | B |\n|---|---|\n| 1 | <2> |');
    assert.match(html, /<h4>Title<\/h4>/);
    assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
    assert.match(html, /<ol><li>first<\/li><\/ol>/);
    assert.match(html, /<code>a&lt;b&gt;<\/code>/);
    assert.match(html, /<span class="ts" data-ts="12:34">12:34<\/span>/);
    assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>&lt;2&gt;<\/td><\/tr><\/tbody><\/table>/);
  });

  test('escapeHtml escapes quotes', () => {
    assert.equal(escapeHtml(`"'<>&`), '&quot;&#39;&lt;&gt;&amp;');
  });
});

describe('transcript', () => {
  test('flags common speech-to-text hallucinations', () => {
    for (const t of ['Thank you for watching!', 'Thanks for watching.', 'Subtitles by the Amara.org community', '[BLANK_AUDIO]', 'you', 'okay okay okay okay okay okay okay okay okay']) {
      assert.ok(isLikelyHallucination(t), t);
    }
    for (const t of ['Thank you, that answers my question about the budget.', 'Can you share the deck?']) {
      assert.ok(!isLikelyHallucination(t), t);
    }
  });

  test('mergeForDisplay joins consecutive lines by the same speaker', () => {
    const T = 1000;
    const merged = mergeForDisplay([
      { seq: 0, speaker: 'A', text: 'Hi', ts: T },
      { seq: 1, speaker: 'A', text: 'there', ts: T + 5000 },
      { seq: 2, speaker: 'B', text: 'Hello', ts: T + 6000 },
      { seq: 3, speaker: 'B', text: 'Later', ts: T + 60000 },
    ]);
    assert.deepEqual(merged.map((m) => [m.speaker, m.text, m.seqs]), [['A', 'Hi there', [0, 1]], ['B', 'Hello', [2]], ['B', 'Later', [3]]]);
  });

  test('formatting', () => {
    assert.equal(formatSegment({ seq: 7, speaker: 'Al', text: 'Yo', ts: 65_000 }, 0, { withSeq: true }), '[#7 01:05] Al: Yo');
    assert.equal(formatOffset(3_725_000), '1:02:05');
    const tail = tailLines([{ speaker: 'A', text: 'one', ts: 0 }, { speaker: 'B', text: 'two', ts: 1000 }], 0, 20);
    assert.equal(tail, '[00:01] B: two');
  });
});

describe('captions diff', () => {
  test('emits only new text as captions grow, scroll and get revised', () => {
    assert.equal(newTextSince('', 'Hello there'), 'Hello there');
    assert.equal(newTextSince('Hello there', 'Hello there, how are you'), ', how are you');
    assert.equal(newTextSince('Hello there', 'hello there'), '');
    assert.equal(newTextSince('so the budget for next quarter is fixed', 'budget for next quarter is fixed and approved'), 'and approved');
    assert.equal(newTextSince('we will ship it on Friday morning', 'we will ship it on Friday mornings'), '');
    assert.equal(newTextSince('we will ship it on Friday', 'we will ship it on Fridays and then test'), 'and then test');
    assert.equal(newTextSince('Completely different text here', 'Another sentence started now'), 'Another sentence started now');
  });
});

describe('util', () => {
  test('platform detection and titles', () => {
    assert.equal(detectPlatform('https://meet.google.com/abc-defg-hij'), 'meet');
    assert.equal(detectPlatform('https://app.zoom.us/wc/123/join'), 'zoom');
    assert.equal(detectPlatform('https://teams.microsoft.com/v2/'), 'teams');
    assert.equal(detectPlatform('https://teams.live.com/meet/1'), 'teams');
    assert.equal(detectPlatform('https://example.com'), 'other');
    assert.equal(detectPlatform('not a url'), 'other');
    assert.equal(cleanMeetingTitle('Meet - abc-defg-hij', 'meet'), 'abc-defg-hij');
    assert.equal(cleanMeetingTitle('(2) Weekly sync | Microsoft Teams', 'teams'), 'Weekly sync');
    assert.equal(cleanMeetingTitle('Zoom', 'zoom'), 'Zoom meeting');
  });

  test('similarity ignores stopwords and punctuation', () => {
    assert.ok(similarity('Send the deck by Friday!', 'send deck friday') > 0.9);
    assert.ok(similarity('Budget approval', 'Hiring plan') === 0);
  });
});

describe('transcription requests', () => {
  const blob = new Blob([new Uint8Array(2000)], { type: 'audio/webm' });

  test('openai-compatible multipart request', () => {
    const { url, init } = buildTranscriptionRequest({ provider: 'groq', apiKey: 'g', model: '' }, blob, { prompt: 'previous words', language: 'en' });
    assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(init.headers.authorization, 'Bearer g');
    assert.equal(init.body.get('model'), 'whisper-large-v3-turbo');
    assert.equal(init.body.get('language'), 'en');
    assert.equal(init.body.get('prompt'), 'previous words');
    assert.equal(init.body.get('file').name, 'chunk.webm');
  });

  test('deepgram raw-body request and parsing', () => {
    const { url, init } = buildTranscriptionRequest({ provider: 'deepgram', apiKey: 'd' }, blob, {});
    assert.match(url, /^https:\/\/api\.deepgram\.com\/v1\/listen\?model=nova-3/);
    assert.match(url, /detect_language=true/);
    assert.equal(init.headers.authorization, 'Token d');
    assert.equal(init.body, blob);
    assert.equal(parseTranscription({ provider: 'deepgram' }, { results: { channels: [{ alternatives: [{ transcript: 'hi' }] }] } }), 'hi');
  });

  test('configuration checks', () => {
    assert.equal(isSttConfigured({ provider: 'openai', apiKey: '' }), false);
    assert.equal(isSttConfigured({ provider: 'openai', apiKey: 'k' }), true);
    assert.equal(isSttConfigured({ provider: 'custom', baseUrl: 'http://localhost:8000/v1' }), true);
    assert.equal(isSttConfigured({ provider: 'none' }), false);
  });
});

describe('settings', () => {
  test('mergeDefaults keeps stored values and fills new ones', () => {
    const s = mergeDefaults(DEFAULT_SETTINGS, { llm: { provider: 'anthropic' }, insights: { types: { key_point: true } }, junk: 1 });
    assert.equal(s.llm.provider, 'anthropic');
    assert.equal(s.llm.model, '');
    assert.equal(s.insights.types.key_point, true);
    assert.equal(s.insights.types.question, true);
    assert.equal(s.junk, undefined);
    assert.equal(mergeDefaults(DEFAULT_SETTINGS, null).capture.mode, 'auto');
  });

  test('keys are shared between AI and transcription for the same vendor', () => {
    const s = mergeDefaults(DEFAULT_SETTINGS, { keys: { openai: 'sk' } });
    assert.equal(llmConfig(s).apiKey, 'sk');
    assert.equal(llmConfig(s).model, 'gpt-5-mini');
    assert.equal(sttConfig(s).apiKey, 'sk');
    assert.equal(sttConfig(s).model, 'gpt-4o-mini-transcribe');
    s.llm.liveModel = 'gpt-5-nano';
    assert.equal(llmConfig(s, 'live').model, 'gpt-5-nano');
    assert.equal(isLlmConfigured(s), true);
  });

  test('resolveCaptureMode', () => {
    const none = mergeDefaults(DEFAULT_SETTINGS, {});
    assert.equal(resolveCaptureMode(none, true).mode, 'captions');
    assert.equal(resolveCaptureMode(none, false).mode, null);
    const stt = mergeDefaults(DEFAULT_SETTINGS, { keys: { openai: 'sk' } });
    assert.equal(resolveCaptureMode(stt, false).mode, 'audio');
    stt.capture.mode = 'captions';
    assert.equal(resolveCaptureMode(stt, false).mode, null);
    assert.equal(resolveCaptureMode(stt, true).mode, 'captions');
  });
});

describe('export', () => {
  test('markdown export includes summary, action items, flagged items and transcript', () => {
    const meeting = {
      title: 'Sync', startedAt: 0, endedAt: 1_800_000, platform: 'meet', notes: '',
      summary: { title: 'Q3 Sync', summary: 'We planned.', key_points: [], decisions: ['Ship Friday'], action_items: [{ owner: 'You', task: 'Send deck', due: 'Mon' }], open_questions: [] },
    };
    const md = meetingToMarkdown(meeting, [{ seq: 0, speaker: 'A', text: 'Hi', ts: 1000 }], [{ type: 'question', text: 'Q?', ts: 61_000, status: 'open', speaker: 'A' }]);
    assert.match(md, /^# Q3 Sync/);
    assert.match(md, /- \[ \] \*\*You\*\*: Send deck _\(due Mon\)_/);
    assert.match(md, /\*\*Question\*\* \[01:01\] Q\? — A/);
    assert.match(md, /\[00:01\] A: Hi/);
  });
});
