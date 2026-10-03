// Bring-your-own-key LLM adapters. Every provider is reduced to the same three
// calls: complete() for one-shot (optionally JSON) answers, stream() for
// token-by-token chat, and listModels() for the settings page.
//
// Requests are plain fetch() calls: this keeps the extension bundle-free and
// lets one code path cover OpenAI, Anthropic, Gemini and any OpenAI-compatible
// endpoint (OpenRouter, Groq, Ollama, LM Studio, vLLM, LiteLLM, ...).

import { readSSE } from './sse.js';
import { sleep } from './util.js';

export const LLM_PROVIDERS = {
  openai: {
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5-mini',
    models: ['gpt-5-mini', 'gpt-5', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o-mini'],
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-…',
  },
  anthropic: {
    label: 'Anthropic Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-…',
  },
  gemini: {
    label: 'Google Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyHint: 'AIza…',
  },
  openrouter: {
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5-mini', 'google/gemini-2.5-flash', 'meta-llama/llama-3.3-70b-instruct'],
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-…',
    extraHeaders: { 'X-Title': 'Smart Meet' },
  },
  groq: {
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_…',
  },
  ollama: {
    label: 'Ollama (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    models: ['llama3.1', 'qwen2.5', 'mistral'],
    noKey: true,
    editableBaseUrl: true,
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    kind: 'openai',
    baseUrl: '',
    defaultModel: '',
    models: [],
    editableBaseUrl: true,
    optionalKey: true,
  },
};

export class LLMError extends Error {
  constructor(message, { status = 0, provider = '', retryable = false, code = '' } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.provider = provider;
    this.retryable = retryable;
    this.code = code;
  }
}

function providerInfo(cfg) {
  const info = LLM_PROVIDERS[cfg.provider];
  if (!info) throw new LLMError(`Unknown provider "${cfg.provider}"`, { code: 'config' });
  return info;
}

export function baseUrlFor(cfg) {
  const info = providerInfo(cfg);
  const url = (info.editableBaseUrl && cfg.baseUrl) ? cfg.baseUrl : info.baseUrl;
  return String(url || '').replace(/\/+$/, '');
}

export function validateConfig(cfg) {
  const info = providerInfo(cfg);
  if (!info.noKey && !info.optionalKey && !cfg.apiKey) {
    throw new LLMError(`Add your ${info.label} API key in Settings.`, { code: 'config', provider: cfg.provider });
  }
  if (!baseUrlFor(cfg)) throw new LLMError('Set the API base URL in Settings.', { code: 'config', provider: cfg.provider });
  if (!(cfg.model || info.defaultModel)) throw new LLMError('Choose a model in Settings.', { code: 'config', provider: cfg.provider });
}

const modelOf = (cfg) => cfg.model || providerInfo(cfg).defaultModel;

// --- Anthropic capability detection -------------------------------------------------

/** Models that accept output_config.effort (it errors on Haiku 4.5 / Sonnet 4.5). */
export function anthropicSupportsEffort(model) {
  return /^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable|mythos)/.test(model);
}

/** Models that accept the server-side refusal fallback `fallbacks: "default"`. */
export function anthropicSupportsFallback(model) {
  return /^claude-(opus-5|fable-5-1|sonnet-5-5)/.test(model);
}

const OPENAI_REASONING = /^(gpt-5|o\d)/;

// --- Request builders (pure, unit-tested) -------------------------------------------

/**
 * @param {object} cfg {provider, model, apiKey, baseUrl}
 * @param {object} req {system, messages:[{role:'user'|'assistant', content}], json, schema,
 *                      maxTokens, effort:'low'|'medium'|'high', stream}
 * @returns {{url: string, init: RequestInit}}
 */
export function buildRequest(cfg, req) {
  const info = providerInfo(cfg);
  const base = baseUrlFor(cfg);
  const model = modelOf(cfg);
  const maxTokens = req.maxTokens ?? 4096;

  if (info.kind === 'anthropic') {
    const headers = {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    const body = {
      model,
      max_tokens: maxTokens,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (req.system) {
      // Cache the (often large, transcript-bearing) system prompt across follow-up questions.
      body.system = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
    }
    const outputConfig = {};
    if (req.effort && anthropicSupportsEffort(model)) outputConfig.effort = req.effort;
    if (req.json && req.schema) outputConfig.format = { type: 'json_schema', schema: req.schema };
    if (Object.keys(outputConfig).length) body.output_config = outputConfig;
    if (anthropicSupportsFallback(model)) {
      body.fallbacks = 'default';
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    }
    if (req.stream) body.stream = true;
    return { url: `${base}/messages`, init: { method: 'POST', headers, body: JSON.stringify(body) } };
  }

  if (info.kind === 'gemini') {
    const headers = { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey };
    const body = {
      contents: req.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: maxTokens },
    };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.json) body.generationConfig.responseMimeType = 'application/json';
    const action = req.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `${base}/models/${encodeURIComponent(model)}:${action}`;
    return { url, init: { method: 'POST', headers, body: JSON.stringify(body) } };
  }

  // OpenAI and OpenAI-compatible chat completions.
  const headers = { 'content-type': 'application/json', ...(info.extraHeaders || {}) };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const messages = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  for (const m of req.messages) messages.push({ role: m.role, content: m.content });
  const body = { model, messages };
  if (cfg.provider === 'openai') {
    body.max_completion_tokens = maxTokens;
    if (req.effort && OPENAI_REASONING.test(model)) body.reasoning_effort = req.effort === 'medium' ? 'medium' : 'low';
  } else {
    body.max_tokens = maxTokens;
  }
  if (req.json && !cfg.noJsonMode) body.response_format = { type: 'json_object' };
  if (req.stream) body.stream = true;
  return { url: `${base}/chat/completions`, init: { method: 'POST', headers, body: JSON.stringify(body) } };
}

// --- Response parsing ---------------------------------------------------------------

export function parseCompletion(cfg, data) {
  const info = providerInfo(cfg);
  if (info.kind === 'anthropic') {
    if (data.stop_reason === 'refusal') {
      throw new LLMError('The model declined this request. Try rephrasing, or pick another model in Settings.', {
        provider: cfg.provider, code: 'refusal',
      });
    }
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { text, stopReason: data.stop_reason, usage: data.usage };
  }
  if (info.kind === 'gemini') {
    const cand = data.candidates?.[0];
    if (!cand) {
      const reason = data.promptFeedback?.blockReason;
      throw new LLMError(reason ? `Gemini blocked the request (${reason}).` : 'Gemini returned no answer.', {
        provider: cfg.provider, code: 'refusal',
      });
    }
    const text = (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    return { text, stopReason: cand.finishReason, usage: data.usageMetadata };
  }
  const choice = data.choices?.[0];
  return { text: choice?.message?.content || '', stopReason: choice?.finish_reason, usage: data.usage };
}

/** Extracts the incremental text from one parsed SSE event; returns null when the stream is done. */
export function parseStreamEvent(cfg, ev) {
  const info = providerInfo(cfg);
  if (ev.data === '[DONE]') return null;
  let json;
  try { json = JSON.parse(ev.data); } catch { return ''; }

  if (info.kind === 'anthropic') {
    if (json.type === 'error') {
      throw new LLMError(json.error?.message || 'Stream error', {
        provider: cfg.provider, retryable: json.error?.type === 'overloaded_error',
      });
    }
    if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') return json.delta.text;
    if (json.type === 'message_delta' && json.delta?.stop_reason === 'refusal') {
      throw new LLMError('The model declined to continue this answer.', { provider: cfg.provider, code: 'refusal' });
    }
    if (json.type === 'message_stop') return null;
    return '';
  }
  if (info.kind === 'gemini') {
    const parts = json.candidates?.[0]?.content?.parts || [];
    return parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
  }
  if (json.error) throw new LLMError(json.error.message || 'Stream error', { provider: cfg.provider });
  return json.choices?.[0]?.delta?.content || '';
}

export async function errorFromResponse(cfg, res) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      const e = Array.isArray(j) ? j[0]?.error : j.error;
      detail = (typeof e === 'string' ? e : e?.message) || j.message || text;
    } catch { detail = text; }
  } catch { /* body unreadable */ }
  detail = String(detail || '').slice(0, 300);
  const label = LLM_PROVIDERS[cfg.provider]?.label || cfg.provider;
  const status = res.status;
  let message;
  if (status === 401 || status === 403) message = `${label} rejected the API key (${status}). Check it in Settings.`;
  else if (status === 404) message = `${label}: model or endpoint not found. ${detail}`;
  else if (status === 429) message = `${label} rate limit or quota reached. ${detail}`;
  else if (status >= 500) message = `${label} is having trouble (${status}). ${detail}`;
  else message = `${label} error ${status}: ${detail}`;
  return new LLMError(message.trim(), {
    status, provider: cfg.provider, retryable: status === 429 || status === 408 || status >= 500,
  });
}

function networkError(cfg, err) {
  if (err?.name === 'AbortError') return err;
  const label = LLM_PROVIDERS[cfg.provider]?.label || cfg.provider;
  const local = cfg.provider === 'ollama'
    ? ' Is Ollama running, and was it started with OLLAMA_ORIGINS=chrome-extension://* ?'
    : '';
  return new LLMError(`Couldn't reach ${label}.${local}`, { provider: cfg.provider, retryable: true, code: 'network' });
}

async function send(cfg, req, signal) {
  const { url, init } = buildRequest(cfg, req);
  let res;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (err) {
    throw networkError(cfg, err);
  }
  if (!res.ok) throw await errorFromResponse(cfg, res);
  return res;
}

function looksLikeUnsupportedJsonMode(err) {
  return err.status === 400 && /response_format|json_schema|output_config|format|responseMimeType/i.test(err.message);
}

/**
 * One-shot completion with retries on transient failures.
 * @returns {Promise<{text: string, stopReason: string, usage: object}>}
 */
export async function complete(cfg, req, { signal, retries = 2 } = {}) {
  validateConfig(cfg);
  let attempt = 0;
  let current = { ...req, stream: false };
  let currentCfg = cfg;
  while (true) {
    try {
      const res = await send(currentCfg, current, signal);
      return parseCompletion(currentCfg, await res.json());
    } catch (err) {
      if (err instanceof LLMError && current.json && looksLikeUnsupportedJsonMode(err)) {
        // Some models/endpoints don't support native JSON mode; the prompt still asks for JSON.
        current = { ...current, schema: undefined };
        currentCfg = { ...currentCfg, noJsonMode: true };
        if (cfg.provider === 'anthropic' || cfg.provider === 'gemini') current.json = false;
        continue;
      }
      if (!(err instanceof LLMError) || !err.retryable || attempt >= retries || signal?.aborted) throw err;
      attempt++;
      await sleep(1000 * 2 ** attempt, signal);
    }
  }
}

/** Streams text deltas. Usage: for await (const delta of stream(cfg, req)) ... */
export async function* stream(cfg, req, { signal } = {}) {
  validateConfig(cfg);
  const res = await send(cfg, { ...req, stream: true, json: false }, signal);
  for await (const ev of readSSE(res, signal)) {
    const delta = parseStreamEvent(cfg, ev);
    if (delta === null) return;
    if (delta) yield delta;
  }
}

export async function listModels(cfg, { signal } = {}) {
  const info = providerInfo(cfg);
  const base = baseUrlFor(cfg);
  let url;
  const headers = {};
  if (info.kind === 'anthropic') {
    url = `${base}/models?limit=100`;
    Object.assign(headers, {
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
  } else if (info.kind === 'gemini') {
    url = `${base}/models?pageSize=200`;
    headers['x-goog-api-key'] = cfg.apiKey;
  } else {
    url = `${base}/models`;
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  }
  let res;
  try { res = await fetch(url, { headers, signal }); } catch (err) { throw networkError(cfg, err); }
  if (!res.ok) throw await errorFromResponse(cfg, res);
  const data = await res.json();
  if (info.kind === 'gemini') {
    return (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''));
  }
  return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}

/** Sends a tiny request to confirm key + model work. */
export async function testConnection(cfg, { signal } = {}) {
  const started = performance.now();
  const { text } = await complete(cfg, {
    system: 'You are a connectivity check.',
    messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
    maxTokens: 2000,
    effort: 'low',
  }, { signal, retries: 0 });
  return { ok: true, reply: text.trim().slice(0, 40), ms: Math.round(performance.now() - started) };
}

/** Pulls the first JSON object out of a model reply (tolerates code fences and prose). */
export function extractJson(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* fall through */ }
  }
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}
