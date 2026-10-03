import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequest, parseCompletion, parseStreamEvent, extractJson, complete, stream, validateConfig,
  anthropicSupportsEffort, anthropicSupportsFallback, LLMError,
} from '../src/lib/providers.js';

const req = {
  system: 'SYS',
  messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'q' }],
  maxTokens: 500,
};

describe('buildRequest', () => {
  test('anthropic: headers, cached system prompt, effort, fallback, structured output', () => {
    const { url, init } = buildRequest(
      { provider: 'anthropic', apiKey: 'k', model: 'claude-opus-5-5' },
      { ...req, json: true, schema: { type: 'object' }, effort: 'low' },
    );
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['x-api-key'], 'k');
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(init.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.max_tokens, 500);
    assert.deepEqual(body.system, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    assert.equal(body.messages.length, 3);
    assert.deepEqual(body.output_config, { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } });
    assert.equal(body.fallbacks, 'default');
    assert.equal(body.thinking, undefined);
    assert.equal(body.temperature, undefined);
  });

  test('anthropic: Haiku gets neither effort nor fallbacks', () => {
    const { init } = buildRequest({ provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-4-5' }, { ...req, effort: 'low' });
    const body = JSON.parse(init.body);
    assert.equal(body.output_config, undefined);
    assert.equal(body.fallbacks, undefined);
    assert.equal(init.headers['anthropic-beta'], undefined);
  });

  test('anthropic capability detection', () => {
    for (const m of ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-4-6', 'claude-sonnet-4-6']) {
      assert.ok(anthropicSupportsEffort(m), m);
    }
    assert.ok(!anthropicSupportsEffort('claude-haiku-4-5'));
    assert.ok(!anthropicSupportsEffort('claude-sonnet-4-5'));
    assert.ok(anthropicSupportsFallback('claude-sonnet-5-5'));
    assert.ok(!anthropicSupportsFallback('claude-sonnet-5'));
    assert.ok(!anthropicSupportsFallback('claude-opus-4-8'));
  });

  test('openai: system message, max_completion_tokens, reasoning effort, json mode', () => {
    const { url, init } = buildRequest({ provider: 'openai', apiKey: 'sk', model: 'gpt-5-mini' }, { ...req, json: true, effort: 'low' });
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init.headers.authorization, 'Bearer sk');
    const body = JSON.parse(init.body);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.max_completion_tokens, 500);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.reasoning_effort, 'low');
    assert.deepEqual(body.response_format, { type: 'json_object' });
  });

  test('openai-compatible: groq uses max_tokens; ollama needs no key; custom base url', () => {
    const groq = JSON.parse(buildRequest({ provider: 'groq', apiKey: 'g', model: 'llama' }, req).init.body);
    assert.equal(groq.max_tokens, 500);
    assert.equal(groq.reasoning_effort, undefined);
    const ollama = buildRequest({ provider: 'ollama', model: 'llama3.1' }, req);
    assert.equal(ollama.url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(ollama.init.headers.authorization, undefined);
    const custom = buildRequest({ provider: 'custom', baseUrl: 'https://x.example.com/v1/', model: 'm' }, req);
    assert.equal(custom.url, 'https://x.example.com/v1/chat/completions');
  });

  test('gemini: roles, system instruction, json mime, stream url', () => {
    const { url, init } = buildRequest({ provider: 'gemini', apiKey: 'g', model: 'gemini-2.5-flash' }, { ...req, json: true });
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(init.headers['x-goog-api-key'], 'g');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.contents.map((c) => c.role), ['user', 'model', 'user']);
    assert.equal(body.systemInstruction.parts[0].text, 'SYS');
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    const s = buildRequest({ provider: 'gemini', apiKey: 'g', model: 'gemini-2.5-flash' }, { ...req, stream: true });
    assert.match(s.url, /:streamGenerateContent\?alt=sse$/);
  });
});

describe('validateConfig', () => {
  test('requires keys except for local providers', () => {
    assert.throws(() => validateConfig({ provider: 'openai', model: 'x' }), LLMError);
    assert.doesNotThrow(() => validateConfig({ provider: 'ollama', model: 'x' }));
    assert.throws(() => validateConfig({ provider: 'custom', model: 'x' }), /base URL/);
  });
});

describe('parsing', () => {
  test('anthropic completion ignores thinking blocks and surfaces refusals', () => {
    const cfg = { provider: 'anthropic' };
    const r = parseCompletion(cfg, { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'A' }, { type: 'text', text: 'B' }], stop_reason: 'end_turn' });
    assert.equal(r.text, 'AB');
    assert.throws(() => parseCompletion(cfg, { content: [], stop_reason: 'refusal' }), /declined/);
  });

  test('gemini completion skips thought parts; blocked prompt errors', () => {
    const cfg = { provider: 'gemini' };
    assert.equal(parseCompletion(cfg, { candidates: [{ content: { parts: [{ text: 'x', thought: true }, { text: 'y' }] } }] }).text, 'y');
    assert.throws(() => parseCompletion(cfg, { promptFeedback: { blockReason: 'SAFETY' } }), /SAFETY/);
  });

  test('stream events', () => {
    const a = { provider: 'anthropic' };
    assert.equal(parseStreamEvent(a, { data: JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }) }), 'hi');
    assert.equal(parseStreamEvent(a, { data: JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } }) }), '');
    assert.equal(parseStreamEvent(a, { data: JSON.stringify({ type: 'message_stop' }) }), null);
    assert.throws(() => parseStreamEvent(a, { data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'refusal' } }) }), /declined/);
    const o = { provider: 'openai' };
    assert.equal(parseStreamEvent(o, { data: JSON.stringify({ choices: [{ delta: { content: 'z' } }] }) }), 'z');
    assert.equal(parseStreamEvent(o, { data: '[DONE]' }), null);
  });

  test('extractJson tolerates fences, prose and braces in strings', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
    assert.deepEqual(extractJson('Here you go: {"a":"}{","b":[1]} done'), { a: '}{', b: [1] });
    assert.equal(extractJson('no json'), null);
  });
});

describe('network', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test('complete retries transient errors then succeeds', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response('{"error":{"message":"busy"}}', { status: 503 });
      return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    };
    const r = await complete({ provider: 'groq', apiKey: 'k', model: 'm' }, req, { retries: 1 });
    assert.equal(r.text, 'ok');
    assert.equal(calls, 2);
  });

  test('complete does not retry auth errors and explains them', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('{"error":{"message":"bad key"}}', { status: 401 }); };
    await assert.rejects(complete({ provider: 'openai', apiKey: 'k', model: 'm' }, req), /rejected the API key/);
    assert.equal(calls, 1);
  });

  test('complete falls back when an endpoint rejects JSON mode', async () => {
    const bodies = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return new Response('{"error":{"message":"response_format is not supported"}}', { status: 400 });
      return Response.json({ choices: [{ message: { content: '{"items":[]}' } }] });
    };
    const r = await complete({ provider: 'custom', baseUrl: 'http://x/v1', model: 'm' }, { ...req, json: true });
    assert.equal(r.text, '{"items":[]}');
    assert.ok(bodies[0].response_format);
    assert.equal(bodies[1].response_format, undefined);
  });

  test('stream yields deltas from an SSE body split across chunks', async () => {
    const sse = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_de',
      'lta","delta":{"type":"text_delta","text":"lo"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(c) { for (const s of sse) c.enqueue(new TextEncoder().encode(s)); c.close(); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    let out = '';
    for await (const d of stream({ provider: 'anthropic', apiKey: 'k', model: 'claude-opus-5-5' }, req)) out += d;
    assert.equal(out, 'Hello');
  });
});
