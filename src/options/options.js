import * as db from '../lib/db.js';
import { getSettings, llmConfig, saveSettings } from '../lib/settings.js';
import { LLM_PROVIDERS, listModels, testConnection } from '../lib/providers.js';
import { STT_PROVIDERS } from '../lib/transcription.js';
import { h, toast } from '../lib/dom.js';
import { debounce, downloadFile } from '../lib/util.js';

const $ = (id) => document.getElementById(id);

const LANGUAGES = [
  ['', 'Auto-detect'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['tr', 'Turkish'],
  ['ru', 'Russian'], ['uk', 'Ukrainian'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['ur', 'Urdu'],
  ['bn', 'Bengali'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['id', 'Indonesian'],
  ['vi', 'Vietnamese'], ['th', 'Thai'], ['sv', 'Swedish'], ['da', 'Danish'], ['no', 'Norwegian'], ['fi', 'Finnish'],
];

let settings;

// --- Generic binding ------------------------------------------------------------------

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}

const persist = debounce(async () => {
  await saveSettings(settings);
  const el = $('savedIndicator');
  el.hidden = false;
  clearTimeout(persist.t);
  persist.t = setTimeout(() => { el.hidden = true; }, 1400);
}, 250);

function readInput(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.dataset.type === 'number') {
    const n = Number(el.value);
    const min = el.min !== '' ? Number(el.min) : -Infinity;
    const max = el.max !== '' ? Number(el.max) : Infinity;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
  }
  return el.value.trim();
}

function writeInputs() {
  for (const el of document.querySelectorAll('[data-key]')) {
    const v = getPath(settings, el.dataset.key);
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else if (el.type === 'radio') el.checked = el.value === String(v);
    else el.value = v ?? '';
  }
}

function bindInputs() {
  for (const el of document.querySelectorAll('[data-key]')) {
    const evt = el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      if (el.type === 'radio' && !el.checked) return;
      setPath(settings, el.dataset.key, readInput(el));
      onFieldChanged(el.dataset.key);
      persist();
    });
  }
}

function onFieldChanged(key) {
  if (key === 'llm.provider') {
    settings.llm.model = '';
    settings.llm.liveModel = '';
    settings.llm.baseUrl = '';
    writeInputs();
    renderLlm();
  } else if (key === 'stt.provider') {
    settings.stt.model = '';
    settings.stt.baseUrl = '';
    writeInputs();
    renderStt();
  } else if (key === 'stt.baseUrl') {
    renderSttOrigin();
  }
}

// --- Provider-specific UI -----------------------------------------------------------------

function fillSelect(select, entries) {
  select.replaceChildren(...entries.map(([value, label]) => h('option', { value }, label)));
}

function fillDatalist(list, models) {
  list.replaceChildren(...models.map((m) => h('option', { value: m })));
}

function keyHint(info, provider) {
  if (info.noKey) return 'No key needed for a local server.';
  const parts = [];
  if (info.optionalKey) parts.push('Optional – only if your endpoint requires one.');
  if (info.keyUrl) parts.push(h('a', { href: info.keyUrl, target: '_blank', rel: 'noopener' }, `Get your ${info.label} API key`));
  const sharedWith = provider === settings.stt.provider || STT_PROVIDERS[settings.stt.provider]?.keyProvider === provider;
  if (sharedWith && settings.capture.mode !== 'captions') parts.push(' · also used for transcription');
  return parts;
}

function renderLlm() {
  const provider = settings.llm.provider;
  const info = LLM_PROVIDERS[provider];
  $('llmModel').placeholder = info.defaultModel || 'model-id';
  fillDatalist($('llmModels'), info.models);
  $('llmBaseUrlField').hidden = !info.editableBaseUrl;
  $('llmBaseUrl').placeholder = info.baseUrl || 'https://your-endpoint.example.com/v1';
  $('llmBaseUrlHint').textContent = provider === 'ollama'
    ? 'Start Ollama with OLLAMA_ORIGINS=chrome-extension://* so the extension may call it.'
    : provider === 'custom' ? 'Any OpenAI-compatible /chat/completions API: LM Studio, vLLM, LiteLLM, Together, Mistral, DeepSeek, Azure-compatible gateways…' : '';
  $('llmKeyField').hidden = Boolean(info.noKey);
  const keyInput = $('llmKey');
  keyInput.value = settings.keys[provider] || '';
  keyInput.placeholder = info.keyHint || 'API key';
  $('llmKeyHint').replaceChildren(...[keyHint(info, provider)].flat());
  $('testLlmResult').textContent = '';
}

function renderStt() {
  const provider = settings.stt.provider;
  const info = STT_PROVIDERS[provider];
  const none = provider === 'none';
  $('sttModelField').hidden = none;
  $('sttBaseUrlField').hidden = !info.editableBaseUrl;
  $('sttKeyField').hidden = none;
  if (none) return;
  $('sttModel').placeholder = info.defaultModel;
  fillDatalist($('sttModels'), info.models);
  const keyInput = $('sttKey');
  keyInput.value = settings.keys[info.keyProvider] || '';
  const shared = info.keyProvider === settings.llm.provider;
  $('sttKeyHint').textContent = shared
    ? `Same key as your AI model (${LLM_PROVIDERS[settings.llm.provider].label}).`
    : info.optionalKey ? 'Optional – only if your server requires one.' : '';
  renderSttOrigin();
}

async function renderSttOrigin() {
  const btn = $('grantSttOrigin');
  const origin = originPattern(settings.stt.baseUrl);
  btn.hidden = !origin || (await chrome.permissions.contains({ origins: [origin] }));
}

function bindKeys() {
  $('llmKey').addEventListener('input', (e) => {
    settings.keys[settings.llm.provider] = e.target.value.trim();
    persist();
    const sttInfo = STT_PROVIDERS[settings.stt.provider];
    if (sttInfo?.keyProvider === settings.llm.provider) $('sttKey').value = e.target.value.trim();
  });
  $('sttKey').addEventListener('input', (e) => {
    const info = STT_PROVIDERS[settings.stt.provider];
    if (!info?.keyProvider) return;
    settings.keys[info.keyProvider] = e.target.value.trim();
    persist();
    if (info.keyProvider === settings.llm.provider) $('llmKey').value = e.target.value.trim();
  });
  for (const btn of document.querySelectorAll('[data-reveal]')) {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.reveal);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
    });
  }
}

// --- Host permissions for user-supplied endpoints -------------------------------------------

function originPattern(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/** Must be called directly from a click handler (permission prompts need a user gesture). */
function requestOrigin(url) {
  const origin = originPattern(url);
  if (!origin) return Promise.resolve(true);
  return chrome.permissions.request({ origins: [origin] }).catch(() => false);
}

// --- Actions -----------------------------------------------------------------------

function bindActions() {
  $('testLlm').addEventListener('click', async () => {
    const info = LLM_PROVIDERS[settings.llm.provider];
    const result = $('testLlmResult');
    const pending = info.editableBaseUrl ? requestOrigin(settings.llm.baseUrl || info.baseUrl) : Promise.resolve(true);
    result.className = 'test-result';
    result.replaceChildren(h('span', { class: 'spinner' }), ' Testing…');
    if (!(await pending)) {
      result.className = 'test-result err';
      result.textContent = 'Permission to reach this endpoint was not granted.';
      return;
    }
    try {
      await saveSettings(settings);
      const { ms, reply } = await testConnection(llmConfig(settings));
      result.className = 'test-result ok';
      result.textContent = `✓ Connected in ${ms} ms${reply ? ` – “${reply}”` : ''}`;
    } catch (err) {
      result.className = 'test-result err';
      result.textContent = `✗ ${err.message}`;
    }
  });

  $('fetchModels').addEventListener('click', async () => {
    const info = LLM_PROVIDERS[settings.llm.provider];
    if (info.editableBaseUrl && !(await requestOrigin(settings.llm.baseUrl || info.baseUrl))) return;
    const btn = $('fetchModels');
    btn.disabled = true;
    try {
      const models = await listModels(llmConfig(settings));
      fillDatalist($('llmModels'), models.length ? models : info.models);
      toast(`${models.length} models available – start typing in the Model field`);
      $('llmModel').focus();
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('grantSttOrigin').addEventListener('click', async () => {
    await requestOrigin(settings.stt.baseUrl);
    renderSttOrigin();
  });

  $('grantMic').addEventListener('click', async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      toast('Microphone allowed');
    } catch (err) {
      toast(err.name === 'NotAllowedError'
        ? 'Microphone blocked – allow it from the icon in the address bar'
        : `Microphone unavailable: ${err.message}`);
    }
    renderMic();
  });

  $('exportAll').addEventListener('click', async () => {
    const meetings = await db.listMeetings();
    const data = [];
    for (const m of meetings) {
      const [segments, insights, chat] = await Promise.all([db.getSegments(m.id), db.getInsights(m.id), db.getChat(m.id)]);
      data.push({ meeting: m, insights, transcript: segments, chat });
    }
    downloadFile(`smart-meet-export-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify({ exportedAt: new Date().toISOString(), meetings: data }, null, 2), 'application/json');
  });

  $('deleteAll').addEventListener('click', async () => {
    const { session } = await chrome.runtime.sendMessage({ type: 'session:get' }) || {};
    if (session) { toast('Stop the current capture first'); return; }
    if (!confirm('Delete every saved meeting, transcript and chat from this browser? This cannot be undone.')) return;
    await db.deleteAll();
    chrome.runtime.sendMessage({ type: 'meeting:deleted' }).catch(() => {});
    toast('All meetings deleted');
    renderStorage();
  });
}

async function renderMic() {
  const el = $('micStatus');
  const btn = $('grantMic');
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    const update = () => {
      el.textContent = status.state === 'granted' ? '✓ Microphone allowed' : status.state === 'denied' ? 'Microphone blocked' : 'Not allowed yet';
      btn.hidden = status.state === 'granted';
    };
    update();
    status.onchange = update;
  } catch {
    el.textContent = '';
  }
}

async function renderStorage() {
  try {
    const [{ usage }, meetings] = await Promise.all([navigator.storage.estimate(), db.listMeetings()]);
    $('storageInfo').textContent = `${meetings.length} meeting${meetings.length === 1 ? '' : 's'} · ${(usage / 1048576).toFixed(1)} MB used`;
  } catch { /* ignore */ }
}

// --- Init --------------------------------------------------------------------------

async function init() {
  settings = await getSettings();
  fillSelect($('llmProvider'), Object.entries(LLM_PROVIDERS).map(([k, v]) => [k, v.label]));
  fillSelect($('sttProvider'), Object.entries(STT_PROVIDERS).map(([k, v]) => [k, v.label]));
  fillSelect($('sttLanguage'), LANGUAGES);
  writeInputs();
  bindInputs();
  bindKeys();
  bindActions();
  renderLlm();
  renderStt();
  renderMic();
  renderStorage();

  if (new URLSearchParams(location.search).has('welcome')) $('welcome').hidden = false;
  const { version } = chrome.runtime.getManifest();
  $('foot').textContent = `Smart Meet v${version}`;

  chrome.storage.onChanged.addListener((changes, area) => {
    // Keep in sync if the side panel changes settings (e.g. consent).
    if (area === 'local' && changes.settings?.newValue?.consentAccepted !== settings.consentAccepted) {
      settings.consentAccepted = Boolean(changes.settings.newValue?.consentAccepted);
      writeInputs();
    }
  });
}

init();
