// Speech-to-text adapters for recorded audio chunks (audio/webm;codecs=opus).

import { sleep } from './util.js';

export const STT_PROVIDERS = {
  openai: {
    label: 'OpenAI',
    keyProvider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini-transcribe',
    models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'],
  },
  groq: {
    label: 'Groq (Whisper, fast & low cost)',
    keyProvider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'whisper-large-v3-turbo',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3'],
  },
  deepgram: {
    label: 'Deepgram',
    keyProvider: 'deepgram',
    baseUrl: 'https://api.deepgram.com/v1',
    defaultModel: 'nova-3',
    models: ['nova-3', 'nova-2'],
  },
  custom: {
    label: 'Custom (OpenAI-compatible Whisper server)',
    keyProvider: 'customStt',
    baseUrl: '',
    defaultModel: 'whisper-1',
    models: [],
    editableBaseUrl: true,
    optionalKey: true,
  },
  none: {
    label: 'None – read the meeting’s live captions instead',
  },
};

export class TranscriptionError extends Error {
  constructor(message, { status = 0, retryable = false, fatal = false } = {}) {
    super(message);
    this.name = 'TranscriptionError';
    this.status = status;
    this.retryable = retryable;
    this.fatal = fatal;
  }
}

export function sttBaseUrl(cfg) {
  const info = STT_PROVIDERS[cfg.provider] || {};
  return String((info.editableBaseUrl && cfg.baseUrl) || info.baseUrl || '').replace(/\/+$/, '');
}

export function isSttConfigured(cfg) {
  const info = STT_PROVIDERS[cfg?.provider];
  if (!info || cfg.provider === 'none') return false;
  if (!sttBaseUrl(cfg)) return false;
  return Boolean(cfg.apiKey || info.optionalKey);
}

export function buildTranscriptionRequest(cfg, blob, { prompt = '', language = '' } = {}) {
  const info = STT_PROVIDERS[cfg.provider];
  if (!info || cfg.provider === 'none') throw new TranscriptionError('No transcription provider configured.', { fatal: true });
  const base = sttBaseUrl(cfg);
  const model = cfg.model || info.defaultModel;

  if (cfg.provider === 'deepgram') {
    const params = new URLSearchParams({ model, smart_format: 'true', punctuate: 'true' });
    if (language) params.set('language', language);
    else params.set('detect_language', 'true');
    return {
      url: `${base}/listen?${params}`,
      init: {
        method: 'POST',
        headers: { authorization: `Token ${cfg.apiKey}`, 'content-type': blob.type || 'audio/webm' },
        body: blob,
      },
    };
  }

  const form = new FormData();
  form.append('file', blob, 'chunk.webm');
  form.append('model', model);
  form.append('response_format', 'json');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt.slice(-600));
  const headers = {};
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  return { url: `${base}/audio/transcriptions`, init: { method: 'POST', headers, body: form } };
}

export function parseTranscription(cfg, data) {
  if (cfg.provider === 'deepgram') {
    return data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
  }
  return typeof data === 'string' ? data : (data?.text || '');
}

export async function transcribe(cfg, blob, opts = {}, { signal, retries = 2 } = {}) {
  let attempt = 0;
  while (true) {
    const { url, init } = buildTranscriptionRequest(cfg, blob, opts);
    let res;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      if (attempt++ >= retries) throw new TranscriptionError("Couldn't reach the transcription service.", { retryable: true });
      await sleep(1000 * 2 ** attempt, signal);
      continue;
    }
    if (res.ok) return parseTranscription(cfg, await res.json()).trim();

    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    const status = res.status;
    const retryable = status === 429 || status >= 500;
    if (retryable && attempt++ < retries) {
      await sleep(1500 * 2 ** attempt, signal);
      continue;
    }
    const label = STT_PROVIDERS[cfg.provider]?.label || cfg.provider;
    const message = status === 401 || status === 403
      ? `${label} rejected the transcription API key. Check it in Settings.`
      : `${label} transcription failed (${status}). ${detail}`;
    throw new TranscriptionError(message, { status, retryable, fatal: status === 401 || status === 403 || status === 404 });
  }
}
