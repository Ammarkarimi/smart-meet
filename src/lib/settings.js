// User settings, stored in chrome.storage.local (never synced: it holds API keys).

import { LLM_PROVIDERS } from './providers.js';
import { STT_PROVIDERS, isSttConfigured } from './transcription.js';

export const INSIGHT_TYPES = {
  question: { label: 'Question', plural: 'Questions' },
  clarification: { label: 'Clarify', plural: 'Clarify' },
  action_item: { label: 'Action item', plural: 'Actions' },
  decision: { label: 'Decision', plural: 'Decisions' },
  key_point: { label: 'Key point', plural: 'Key points' },
};

export const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  consentAccepted: false,
  llm: {
    provider: 'openai',
    model: '',
    liveModel: '',          // optional faster/cheaper model for live detection
    baseUrl: '',
  },
  stt: {
    provider: 'openai',
    model: '',
    baseUrl: '',
    language: '',           // ISO-639-1, empty = auto-detect
  },
  keys: {
    openai: '', anthropic: '', gemini: '', openrouter: '', groq: '', deepgram: '', custom: '', customStt: '', ollama: '',
  },
  capture: {
    mode: 'auto',           // 'auto' | 'audio' | 'captions'
    includeMic: true,
    minChunkSec: 6,
    maxChunkSec: 20,
    silenceMs: 800,
  },
  insights: {
    types: { question: true, clarification: true, action_item: true, decision: true, key_point: false },
    suggestReplies: true,
    minNewChars: 220,
    intervalSec: 20,
    autoSummary: true,
  },
  profile: {
    name: '',
    about: '',
  },
  privacy: {
    retentionDays: 0,       // 0 = keep until deleted
  },
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merges stored values over defaults so new settings get sane values after upgrades. */
export function mergeDefaults(defaults, stored) {
  if (!isPlainObject(stored)) return structuredClone(defaults);
  const out = {};
  for (const [k, v] of Object.entries(defaults)) {
    if (isPlainObject(v)) out[k] = mergeDefaults(v, stored[k]);
    else out[k] = stored[k] === undefined ? v : stored[k];
  }
  return out;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return mergeDefaults(DEFAULT_SETTINGS, settings);
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

export async function updateSettings(mutator) {
  const s = await getSettings();
  mutator(s);
  await saveSettings(s);
  return s;
}

export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area === 'local' && changes.settings) callback(mergeDefaults(DEFAULT_SETTINGS, changes.settings.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Config object for providers.js. `purpose: 'live'` picks the optional live model. */
export function llmConfig(settings, purpose = 'main') {
  const { provider, model, liveModel, baseUrl } = settings.llm;
  return {
    provider,
    model: (purpose === 'live' && liveModel) || model || LLM_PROVIDERS[provider]?.defaultModel || '',
    baseUrl,
    apiKey: settings.keys[provider] || '',
  };
}

export function sttConfig(settings) {
  const { provider, model, baseUrl, language } = settings.stt;
  const info = STT_PROVIDERS[provider] || {};
  return {
    provider,
    model: model || info.defaultModel || '',
    baseUrl,
    language,
    apiKey: info.keyProvider ? settings.keys[info.keyProvider] || '' : '',
  };
}

export function isLlmConfigured(settings) {
  const info = LLM_PROVIDERS[settings.llm.provider];
  if (!info) return false;
  if (info.editableBaseUrl && !info.baseUrl && !settings.llm.baseUrl) return false;
  if (!(settings.llm.model || info.defaultModel)) return false;
  return Boolean(info.noKey || info.optionalKey || settings.keys[settings.llm.provider]);
}

export function isTranscriptionConfigured(settings) {
  return isSttConfigured(sttConfig(settings));
}

/**
 * Decides how a meeting will be captured.
 * @returns {{mode: 'audio'|'captions'|null, reason?: string}}
 */
export function resolveCaptureMode(settings, platformSupportsCaptions) {
  const pref = settings.capture.mode;
  const sttReady = isTranscriptionConfigured(settings);
  if (pref === 'audio') {
    return sttReady ? { mode: 'audio' } : { mode: null, reason: 'Audio capture needs a transcription provider. Set one up in Settings.' };
  }
  if (pref === 'captions') {
    return platformSupportsCaptions
      ? { mode: 'captions' }
      : { mode: null, reason: 'Caption reading works on Google Meet, Zoom (web) and Teams (web). Switch to audio capture for other sites.' };
  }
  if (sttReady) return { mode: 'audio' };
  if (platformSupportsCaptions) return { mode: 'captions' };
  return { mode: null, reason: 'Set up a transcription provider in Settings to capture this tab.' };
}
