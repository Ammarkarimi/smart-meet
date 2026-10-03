import * as db from '../lib/db.js';
import {
  getSettings, updateSettings, onSettingsChanged, llmConfig, isLlmConfigured,
  isTranscriptionConfigured, resolveCaptureMode, INSIGHT_TYPES,
} from '../lib/settings.js';
import { askMeeting, draftReply } from '../lib/qa.js';
import { renderMarkdown } from '../lib/markdown.js';
import { meetingToJson, meetingToMarkdown } from '../lib/export.js';
import { copyText, h, icon, speakerHue, toast } from '../lib/dom.js';
import { mergeForDisplay } from '../lib/transcript.js';
import { STT_PROVIDERS } from '../lib/transcription.js';
import {
  CAPTION_PLATFORMS, PLATFORM_LABELS, debounce, detectPlatform, downloadFile,
  formatDateTime, formatDuration, formatOffset, safeFilename, uid,
} from '../lib/util.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  session: null,
  meeting: null,          // meeting shown in the Live tab
  segments: [],
  insights: [],
  filter: 'all',
  showDone: false,
  view: 'live',
  sub: 'insights',
  banners: new Map(),     // key -> {level, message, actions}
  activeTab: null,
  starting: false,
  askMeetingId: null,
  chat: [],
  asking: null,           // AbortController while an answer streams
  drafts: new Map(),      // insightId -> {text, running, controller, error}
  historyDetailId: null,
};

// --- Messaging ---------------------------------------------------------------------

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) {
    const err = new Error(res?.error || 'Something went wrong.');
    err.code = res?.code;
    throw err;
  }
  return res;
}

function openSettings(hash = '') {
  const url = chrome.runtime.getURL(`src/options/options.html${hash}`);
  chrome.tabs.create({ url });
}

// --- Banners -----------------------------------------------------------------------

function setBanner(key, level, message, actions = []) {
  if (!message) state.banners.delete(key);
  else state.banners.set(key, { level, message, actions });
  renderBanners();
}

function renderBanners() {
  const root = $('banners');
  root.replaceChildren(...[...state.banners].map(([key, b]) => h('div', { class: `banner ${b.level}`, role: b.level === 'error' ? 'alert' : 'status' },
    icon(b.level === 'info' ? 'info' : 'alert'),
    h('span', { class: 'msg' }, b.message),
    ...b.actions.map((a) => h('button', { class: 'btn btn-sm', onclick: a.run }, a.label)),
    h('button', { class: 'icon-btn', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: () => setBanner(key) }, icon('x')),
  )));
}

function showError(err, key = 'error') {
  const actions = [];
  if (err.code === 'setup' || err.code === 'consent') actions.push({ label: 'Settings', run: () => openSettings() });
  setBanner(key, 'error', err.message || String(err), actions);
}

// --- Session card ----------------------------------------------------------------------

function captureDescription(mode) {
  const s = state.settings;
  if (mode === 'captions') return 'Reads the meeting’s live captions';
  const stt = STT_PROVIDERS[s.stt.provider]?.label?.split(' (')[0] || 'speech-to-text';
  return `Transcribes tab audio${s.capture.includeMic ? ' + your mic' : ''} with ${stt}`;
}

function renderSessionCard() {
  const card = $('sessionCard');
  const s = state.settings;
  const session = state.session;
  const pill = $('sessionPill');

  if (session) {
    pill.dataset.state = session.status === 'live' ? 'live' : 'busy';
    updatePill();
    const title = state.meeting?.title || 'Meeting';
    card.replaceChildren(h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('div', { class: 'title', title }, title),
        h('div', { class: 'how' }, `${PLATFORM_LABELS[session.platform] || 'Browser tab'} · ${captureDescription(session.mode)}`)),
      h('button', {
        class: 'btn btn-danger',
        disabled: session.status === 'stopping',
        onclick: stopCapture,
      }, session.status === 'stopping' ? h('span', { class: 'spinner' }) : icon('stop'), session.status === 'stopping' ? 'Finishing' : 'Stop'),
    ));
    return;
  }

  pill.dataset.state = 'idle';
  pill.textContent = 'Not capturing';

  if (!isLlmConfigured(s) && !isTranscriptionConfigured(s)) {
    card.replaceChildren(h('div', { class: 'setup' },
      h('strong', {}, 'Connect your AI model'),
      h('p', {}, 'Add an API key for OpenAI, Claude, Gemini, Groq, OpenRouter or a local model. Keys stay in this browser.'),
      h('button', { class: 'btn btn-primary btn-block', onclick: () => openSettings() }, icon('settings'), 'Open settings')));
    return;
  }

  const tab = state.activeTab;
  const capturable = tab && (!tab.url || /^https?:/.test(tab.url));
  const platform = detectPlatform(tab?.url || '');
  const plan = resolveCaptureMode(s, CAPTION_PLATFORMS.has(platform));
  const title = tab?.title || 'Current tab';

  let how;
  if (!capturable) how = 'Open your Google Meet, Zoom, Teams or other meeting tab.';
  else if (!plan.mode) how = plan.reason;
  else how = captureDescription(plan.mode);

  card.replaceChildren(h('div', { class: 'row' },
    h('div', { class: 'grow' },
      h('div', { class: 'title', title }, capturable ? `${PLATFORM_LABELS[platform]} · ${title}` : 'No meeting tab selected'),
      h('div', { class: 'how' }, how)),
    plan.mode || !capturable
      ? h('button', {
        class: 'btn btn-primary',
        disabled: !capturable || state.starting,
        onclick: startCapture,
      }, state.starting ? h('span', { class: 'spinner' }) : icon('play'), 'Start')
      : h('button', { class: 'btn', onclick: () => openSettings() }, 'Settings'),
  ));
}

function updatePill() {
  const session = state.session;
  const pill = $('sessionPill');
  if (!session) return;
  if (session.status === 'starting') pill.textContent = 'Starting…';
  else if (session.status === 'stopping') pill.textContent = 'Finishing…';
  else pill.textContent = `Live ${formatOffset(Date.now() - session.startedAt)}`;
}

async function refreshActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.activeTab = tab ? { id: tab.id, url: tab.url, title: tab.title } : null;
  } catch {
    state.activeTab = null;
  }
  if (!state.session) renderSessionCard();
}

function askConsent() {
  const dialog = $('consentDialog');
  const check = $('consentCheck');
  const accept = $('consentAccept');
  check.checked = false;
  accept.disabled = true;
  check.onchange = () => { accept.disabled = !check.checked; };
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'accept'), { once: true });
  });
}

async function startCapture() {
  if (state.starting || state.session) return;
  await refreshActiveTab();
  const tab = state.activeTab;
  if (!tab) return;
  let settings = state.settings;

  if (!settings.consentAccepted) {
    if (!(await askConsent())) return;
    settings = await updateSettings((s) => { s.consentAccepted = true; });
    state.settings = settings;
  }

  const platform = detectPlatform(tab.url || '');
  const plan = resolveCaptureMode(settings, CAPTION_PLATFORMS.has(platform));
  if (!plan.mode) { showError({ message: plan.reason, code: 'setup' }); return; }

  state.starting = true;
  setBanner('error');
  renderSessionCard();
  try {
    let streamId = null;
    if (plan.mode === 'audio') {
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      } catch (err) {
        throw Object.assign(new Error(/invoked|activeTab/i.test(err.message)
          ? 'Chrome needs you to click the Smart Meet toolbar icon on the meeting tab first. Click it, then press Start.'
          : `Couldn’t capture this tab: ${err.message}`), { code: 'capture' });
      }
      if (settings.capture.includeMic) checkMicPermission();
    }
    const { session } = await send('session:start', { tabId: tab.id, streamId, title: tab.title, url: tab.url });
    state.drafts.clear();
    await onSessionChanged(session);
    setBanner('ended');
  } catch (err) {
    showError(err);
  } finally {
    state.starting = false;
    renderSessionCard();
  }
}

async function checkMicPermission() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    if (status.state !== 'granted') {
      setBanner('mic', 'warn', 'Your own voice isn’t captured until you allow microphone access (one time).', [
        { label: 'Allow', run: () => chrome.tabs.create({ url: chrome.runtime.getURL('src/permission/mic.html') }) },
      ]);
    }
  } catch { /* permissions API unavailable */ }
}

async function stopCapture() {
  try {
    await send('session:stop');
  } catch (err) {
    showError(err);
  }
}

async function onSessionChanged(session) {
  const prev = state.session;
  state.session = session;
  if (session && state.meeting?.id !== session.meetingId) {
    await loadLiveMeeting(session.meetingId);
  }
  if (!session && prev) {
    const id = prev.meetingId;
    await loadLiveMeeting(id);
    if (state.meeting) {
      setBanner('ended', 'info', 'Meeting saved. Ask AI anything about it, or open it in History.', [
        { label: 'Ask AI', run: () => { state.askMeetingId = id; switchView('ask'); } },
        { label: 'View', run: () => { switchView('history'); openDetail(id); } },
      ]);
    }
    for (const key of ['captions', 'transcription', 'analysis', 'mic']) state.banners.delete(key);
    renderBanners();
  }
  renderSessionCard();
  if (state.view === 'ask') refreshAskOptions();
  if (state.view === 'history') renderHistory();
}

// --- Live tab ----------------------------------------------------------------------

async function loadLiveMeeting(id) {
  const meeting = id ? await db.getMeeting(id) : null;
  state.meeting = meeting || null;
  state.segments = meeting ? await db.getSegments(id) : [];
  state.insights = meeting ? await db.getInsights(id) : [];
  $('notesInput').value = meeting?.notes || '';
  $('notesInput').disabled = !meeting;
  renderLive();
}

function renderLive() {
  renderChips();
  renderInsights();
  renderTranscript(true);
}

function enabledTypes() {
  return Object.keys(INSIGHT_TYPES).filter((t) => state.settings.insights.types[t]);
}

function renderChips() {
  const open = (type) => state.insights.filter((i) => i.type === type && (state.showDone || i.status === 'open')).length;
  const types = enabledTypes();
  if (state.filter !== 'all' && !types.includes(state.filter)) state.filter = 'all';
  const chip = (key, label, n) => h('button', {
    class: `chip${state.filter === key ? ' active' : ''}`,
    'aria-pressed': String(state.filter === key),
    onclick: () => { state.filter = key; renderChips(); renderInsights(); },
  }, label, n ? h('span', { class: 'n' }, ` ${n}`) : null);
  $('filterChips').replaceChildren(
    chip('all', 'All'),
    ...types.map((t) => chip(t, INSIGHT_TYPES[t].plural, open(t))),
  );
  $('filterChips').hidden = state.sub !== 'insights';
}

const TYPE_ORDER = ['question', 'clarification', 'action_item', 'decision', 'key_point'];

/** Open items first, then newest; within the same moment, questions before the rest. */
function sortInsights(items) {
  const rank = (i) => (i.status === 'open' ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b) || b.ts - a.ts
    || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || b.createdAt - a.createdAt);
}

function renderInsights() {
  const list = $('insightList');
  const openCount = state.insights.filter((i) => i.status === 'open').length;
  $('insightCount').textContent = String(openCount);

  if (!state.meeting) {
    list.replaceChildren(h('div', { class: 'empty' },
      icon('sparkles'),
      h('div', { class: 'big' }, 'Your meeting copilot'),
      h('div', {}, 'Press Start on your meeting tab. Questions and points worth clarifying appear here as people talk.')));
    return;
  }
  const items = sortInsights(state.insights.filter((i) => (state.showDone || i.status === 'open')
    && (state.filter === 'all' || i.type === state.filter)));
  if (!items.length) {
    const live = state.session?.meetingId === state.meeting.id;
    list.replaceChildren(h('div', { class: 'empty' },
      icon(live ? 'mic' : 'check'),
      h('div', { class: 'big' }, live ? 'Listening…' : 'Nothing open'),
      h('div', {}, live
        ? (state.segments.length ? 'Nothing flagged yet. New questions show up within a few seconds.' : 'Waiting for the conversation to start.')
        : 'No open items for this meeting.')));
    return;
  }
  list.replaceChildren(...items.map(insightCard));
}

function insightCard(i) {
  const label = INSIGHT_TYPES[i.type]?.label || i.type;
  const isOpen = i.status === 'open';
  const replyable = i.type === 'question' || i.type === 'clarification';
  const draft = state.drafts.get(i.id);
  const when = state.meeting ? formatOffset(i.ts - state.meeting.startedAt) : '';

  const setStatus = async (status) => {
    i.status = status;
    await db.updateInsight(i.id, { status });
    renderChips();
    renderInsights();
    send('badge:refresh').catch(() => {});
  };

  return h('article', {
    class: `insight t-${i.type}${i.directedAtUser && isOpen ? ' for-user' : ''}${isOpen ? '' : ' done'}`,
    dataset: { id: i.id },
  },
  h('div', { class: 'head' },
    h('span', { class: 'badge' }, label),
    i.directedAtUser && isOpen ? h('span', { class: 'badge you' }, 'For you') : null,
    i.priority === 'high' && isOpen && replyable ? h('span', { class: 'badge high' }, 'Respond now') : null,
    h('span', { class: 'meta' }, [i.speaker, when].filter(Boolean).join(' · '))),
  h('p', { class: 'text' }, i.text),
  i.quote ? h('p', { class: 'quote' }, `“${i.quote}”`) : null,
  i.suggestion && !draft ? h('div', { class: 'suggestion' }, h('span', { class: 'label' }, 'You could say'), i.suggestion) : null,
  draft ? h('div', { class: 'suggestion', dataset: { draft: i.id } },
    h('span', { class: 'label' }, draft.running ? 'Drafting…' : 'Suggested answer'),
    h('span', { class: 'draft-text' }, draft.error || draft.text || '…')) : null,
  h('div', { class: 'actions' },
    (i.suggestion || draft?.text) ? h('button', {
      class: 'btn btn-ghost btn-sm', title: 'Copy the suggested reply',
      onclick: () => copyText(draft?.text || i.suggestion),
    }, icon('copy'), 'Copy') : null,
    replyable ? h('button', {
      class: 'btn btn-ghost btn-sm', title: 'Write a fuller answer with AI',
      disabled: draft?.running,
      onclick: () => runDraft(i),
    }, icon('wand'), draft ? 'Redraft' : 'Draft answer') : null,
    i.segmentSeq !== null && i.segmentSeq !== undefined ? h('button', {
      class: 'btn btn-ghost btn-sm', title: 'Show in transcript',
      onclick: () => jumpToSegment(i.segmentSeq),
    }, icon('list'), 'Context') : null,
    h('span', { class: 'push' }),
    isOpen
      ? h('button', { class: 'icon-btn', title: 'Mark done', 'aria-label': 'Mark done', onclick: () => setStatus('done') }, icon('check'))
      : h('button', { class: 'btn btn-ghost btn-sm', onclick: () => setStatus('open') }, 'Reopen'),
    isOpen ? h('button', { class: 'icon-btn', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: () => setStatus('dismissed') }, icon('x')) : null));
}

async function runDraft(insight) {
  if (!isLlmConfigured(state.settings)) { showError({ message: 'Add an LLM API key in Settings to draft answers.', code: 'setup' }); return; }
  state.drafts.get(insight.id)?.controller?.abort();
  const draft = { text: '', running: true, controller: new AbortController(), error: '' };
  state.drafts.set(insight.id, draft);
  renderInsights();
  const update = () => {
    const el = document.querySelector(`[data-draft="${insight.id}"] .draft-text`);
    if (el) el.textContent = draft.text || '…';
  };
  try {
    const segments = await db.getSegments(insight.meetingId);
    const meeting = await db.getMeeting(insight.meetingId);
    for await (const delta of draftReply(llmConfig(state.settings), {
      meeting, segments, insight, profile: state.settings.profile,
    }, { signal: draft.controller.signal })) {
      draft.text += delta;
      update();
    }
  } catch (err) {
    if (err.name !== 'AbortError') draft.error = err.message;
  } finally {
    draft.running = false;
    renderInsights();
  }
}

let transcriptRenderQueued = false;
function renderTranscript(force = false) {
  if (state.sub !== 'transcript' && !force) return;
  if (transcriptRenderQueued) return;
  transcriptRenderQueued = true;
  requestAnimationFrame(() => {
    transcriptRenderQueued = false;
    const root = $('transcriptList');
    const scroller = document.scrollingElement;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    if (!state.meeting || !state.segments.length) {
      root.replaceChildren(h('div', { class: 'empty' }, icon('mic'),
        h('div', { class: 'big' }, 'No transcript yet'),
        h('div', {}, state.session ? 'Lines appear here as people speak.' : 'Start capturing to see the live transcript.')));
      return;
    }
    const lines = mergeForDisplay(state.segments);
    root.replaceChildren(...lines.map((l) => h('div', {
      class: 'line',
      dataset: { seqs: l.seqs.join(',') },
      style: { '--hue': String(speakerHue(l.speaker)) },
    },
    h('div', { class: 'who' },
      h('span', { class: 'name' }, l.speaker),
      h('span', { class: 'time' }, formatOffset(l.ts - state.meeting.startedAt))),
    h('div', { class: 'said' }, l.text))));
    if (nearBottom && state.sub === 'transcript' && state.view === 'live' && state.session) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  });
}

function setSub(sub) {
  state.sub = sub;
  document.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.sub === sub));
  $('insightList').hidden = sub !== 'insights';
  $('filterChips').hidden = sub !== 'insights';
  $('transcriptList').hidden = sub !== 'transcript';
  if (sub === 'transcript') renderTranscript(true);
}

function jumpToSegment(seq) {
  setSub('transcript');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const line = [...document.querySelectorAll('#transcriptList .line')]
      .find((el) => el.dataset.seqs.split(',').map(Number).includes(seq));
    if (!line) return;
    line.scrollIntoView({ block: 'center', behavior: 'smooth' });
    line.classList.remove('flash');
    void line.offsetWidth;
    line.classList.add('flash');
  }));
}

// --- Ask tab -----------------------------------------------------------------------

const SUGGESTED_QUESTIONS = [
  'Summarize the meeting so far',
  'What was I asked, and what should I follow up on?',
  'List the action items with owners and deadlines',
  'What decisions were made?',
  'What is still unclear or unresolved?',
];

async function refreshAskOptions() {
  const meetings = await db.listMeetings();
  const select = $('askMeeting');
  if (!meetings.length) {
    select.replaceChildren(h('option', { value: '' }, 'No meetings yet'));
    select.disabled = true;
    state.askMeetingId = null;
    state.chat = [];
    renderChat();
    return;
  }
  select.disabled = false;
  if (!meetings.some((m) => m.id === state.askMeetingId)) {
    state.askMeetingId = state.session?.meetingId || meetings[0].id;
  }
  select.replaceChildren(...meetings.map((m) => h('option', { value: m.id, selected: m.id === state.askMeetingId },
    `${m.status === 'live' ? '● Live – ' : ''}${m.summary?.title || m.title} · ${formatDateTime(m.startedAt)}`)));
  await loadChat();
}

async function loadChat() {
  state.chat = state.askMeetingId ? await db.getChat(state.askMeetingId) : [];
  renderChat();
}

function renderChat() {
  const log = $('chatLog');
  if (!state.chat.length) {
    log.replaceChildren(h('div', { class: 'empty' }, icon('chat'),
      h('div', { class: 'big' }, 'Ask about this meeting'),
      h('div', {}, state.askMeetingId
        ? 'Who said what, decisions, deadlines, follow-ups – answers cite timestamps from the transcript.'
        : 'Capture a meeting first, then ask questions about it here.')));
  } else {
    log.replaceChildren(...state.chat.map(messageBubble));
  }
  const suggestions = !state.askMeetingId ? [] : state.chat.length ? SUGGESTED_QUESTIONS.slice(1, 4) : SUGGESTED_QUESTIONS;
  $('askSuggestions').replaceChildren(...suggestions.map((q) => h('button', {
    class: 'chip', disabled: Boolean(state.asking), onclick: () => ask(q),
  }, q)));
  renderSendButton();
}

function messageBubble(m) {
  if (m.role === 'user') return h('div', { class: 'msg user' }, m.content);
  const body = h('div', { class: 'md' });
  if (m.pending && !m.content) body.append(h('span', { class: 'typing', 'aria-label': 'Thinking' }, h('span'), h('span'), h('span')));
  else body.innerHTML = renderMarkdown(m.content);
  return h('div', { class: `msg assistant${m.error ? ' error' : ''}`, dataset: { id: m.id } },
    body,
    !m.pending && !m.error ? h('div', { class: 'tools' },
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => copyText(m.content) }, icon('copy'), 'Copy')) : null);
}

function renderSendButton() {
  const btn = $('askSend');
  btn.replaceChildren(icon(state.asking ? 'stop' : 'send'));
  btn.title = state.asking ? 'Stop' : 'Send';
  btn.setAttribute('aria-label', btn.title);
}

async function ask(question) {
  question = question.trim();
  if (!question || state.asking) return;
  if (!state.askMeetingId) return;
  if (!isLlmConfigured(state.settings)) {
    showError({ message: 'Add an LLM API key in Settings to ask questions.', code: 'setup' });
    return;
  }
  const meetingId = state.askMeetingId;
  const [meeting, segments, insights] = await Promise.all([
    db.getMeeting(meetingId), db.getSegments(meetingId), db.getInsights(meetingId),
  ]);
  if (!meeting) return;

  const history = state.chat.filter((m) => !m.error && !m.pending).map(({ role, content }) => ({ role, content }));
  const userMsg = { id: uid(), meetingId, role: 'user', content: question, ts: Date.now() };
  await db.addChatMessage(userMsg);
  state.chat.push(userMsg);
  const reply = { id: uid(), meetingId, role: 'assistant', content: '', ts: Date.now() + 1, pending: true };
  state.chat.push(reply);
  state.asking = new AbortController();
  $('askInput').value = '';
  autosize();
  renderChat();
  scrollToBottom();

  let last = 0;
  const paint = (forceNow = false) => {
    const now = performance.now();
    if (!forceNow && now - last < 60) return;
    last = now;
    const el = document.querySelector(`.msg[data-id="${reply.id}"]`);
    if (el) el.replaceWith(messageBubble(reply));
    scrollToBottom(true);
  };

  try {
    if (!segments.length) throw new Error('There’s no transcript for this meeting yet.');
    for await (const delta of askMeeting(llmConfig(state.settings), {
      meeting, segments, insights: insights.filter((i) => i.status !== 'dismissed'),
      profile: state.settings.profile, history, question,
    }, { signal: state.asking.signal })) {
      reply.content += delta;
      paint();
    }
    reply.pending = false;
    if (!reply.content.trim()) reply.content = '_No answer was returned._';
    await db.addChatMessage({ id: reply.id, meetingId, role: 'assistant', content: reply.content, ts: reply.ts });
  } catch (err) {
    reply.pending = false;
    if (err.name === 'AbortError') {
      reply.content = reply.content ? `${reply.content}\n\n_(stopped)_` : '_(stopped)_';
      if (reply.content.length > 20) await db.addChatMessage({ id: reply.id, meetingId, role: 'assistant', content: reply.content, ts: reply.ts });
    } else {
      reply.error = true;
      reply.content = err.message || String(err);
    }
  } finally {
    state.asking = null;
    renderChat();
    scrollToBottom(true);
  }
}

function scrollToBottom(onlyIfNear = false) {
  const scroller = document.scrollingElement;
  if (onlyIfNear && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 200) return;
  scroller.scrollTop = scroller.scrollHeight;
}

function autosize() {
  const ta = $('askInput');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(160, ta.scrollHeight)}px`;
}

// --- History tab -------------------------------------------------------------------

async function renderHistory() {
  if (state.historyDetailId) { await openDetail(state.historyDetailId); return; }
  $('historyList').hidden = false;
  $('historyDetail').hidden = true;
  const q = $('historySearch').value.trim().toLowerCase();
  const meetings = (await db.listMeetings()).filter((m) => !q
    || `${m.title} ${m.summary?.title || ''} ${m.summary?.summary || ''}`.toLowerCase().includes(q));
  const root = $('historyItems');
  if (!meetings.length) {
    root.replaceChildren(h('div', { class: 'empty' }, icon('clock'),
      h('div', { class: 'big' }, q ? 'No matches' : 'No meetings yet'),
      h('div', {}, q ? 'Try a different search.' : 'Meetings you capture are saved here, on this device only.')));
    return;
  }
  root.replaceChildren(...meetings.map((m) => h('button', { class: 'meeting-card', onclick: () => openDetail(m.id) },
    h('div', { class: 't' }, `${m.status === 'live' ? '● ' : ''}${m.summary?.title || m.title}`),
    h('div', { class: 'm' }, [
      formatDateTime(m.startedAt),
      PLATFORM_LABELS[m.platform],
      m.endedAt ? formatDuration(m.endedAt - m.startedAt) : 'in progress',
    ].filter(Boolean).join(' · ')),
    m.summary?.summary ? h('div', { class: 's' }, m.summary.summary) : null)));
}

function listSection(title, items, render = (x) => x) {
  if (!items?.length) return null;
  return h('div', { class: 'section' }, h('h3', {}, title), h('ul', {}, ...items.map((x) => h('li', {}, render(x)))));
}

async function openDetail(id) {
  const meeting = await db.getMeeting(id);
  if (!meeting) { state.historyDetailId = null; renderHistory(); return; }
  state.historyDetailId = id;
  $('historyList').hidden = true;
  const root = $('historyDetail');
  root.hidden = false;
  const [segments, insights] = await Promise.all([db.getSegments(id), db.getInsights(id)]);
  const s = meeting.summary;
  const live = meeting.status === 'live';

  let summaryBlock;
  if (meeting.summaryStatus === 'pending') {
    summaryBlock = h('div', { class: 'section muted' }, h('span', { class: 'spinner' }), ' Writing summary…');
  } else if (s) {
    summaryBlock = h('div', {},
      s.summary ? h('div', { class: 'section' }, h('h3', {}, 'Summary'), h('p', {}, s.summary)) : null,
      listSection('Action items', s.action_items, (a) => [
        a.owner ? h('strong', {}, `${a.owner}: `) : null, a.task, a.due ? h('span', { class: 'subtle' }, ` (due ${a.due})`) : null,
      ]),
      listSection('Decisions', s.decisions),
      listSection('Open questions', s.open_questions),
      listSection('Key points', s.key_points));
  } else {
    summaryBlock = h('div', { class: 'section muted' },
      meeting.summaryError ? h('p', {}, `Summary failed: ${meeting.summaryError}`) : h('p', {}, live ? 'A summary is written when the meeting ends.' : 'No summary yet.'));
  }

  const flagged = insights.filter((i) => i.status !== 'dismissed');
  const transcript = mergeForDisplay(segments);

  root.replaceChildren(...[
    h('div', { class: 'detail-head' },
      h('button', { class: 'icon-btn', title: 'Back', 'aria-label': 'Back', onclick: () => { state.historyDetailId = null; renderHistory(); } }, icon('back')),
      h('h2', {}, s?.title || meeting.title)),
    h('div', { class: 'subtle' }, [
      formatDateTime(meeting.startedAt), PLATFORM_LABELS[meeting.platform],
      meeting.endedAt ? formatDuration(meeting.endedAt - meeting.startedAt) : 'in progress',
      `${segments.length} lines`,
    ].join(' · ')),
    h('div', { class: 'detail-actions' },
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => { state.askMeetingId = id; switchView('ask'); } }, icon('chat'), 'Ask AI'),
      h('button', { class: 'btn btn-sm', onclick: () => exportMeeting(meeting, 'md') }, icon('download'), 'Markdown'),
      h('button', { class: 'btn btn-sm', onclick: () => exportMeeting(meeting, 'json') }, icon('download'), 'JSON'),
      !live ? h('button', {
        class: 'btn btn-sm', disabled: meeting.summaryStatus === 'pending' || !segments.length,
        onclick: async () => {
          try { await send('summary:generate', { meetingId: id }); } catch (err) { showError(err); }
        },
      }, icon('refresh'), s ? 'Regenerate' : 'Summarize') : null,
      !live ? h('button', {
        class: 'btn btn-sm btn-ghost', title: 'Delete meeting',
        onclick: async () => {
          if (!confirm('Delete this meeting, its transcript and chat? This cannot be undone.')) return;
          await db.deleteMeeting(id);
          if (state.meeting?.id === id) await loadLiveMeeting(null);
          state.historyDetailId = null;
          toast('Meeting deleted');
          renderHistory();
        },
      }, icon('trash'), 'Delete') : null),
    summaryBlock,
    listSection(`Flagged during the meeting (${flagged.length})`, flagged, (i) => [
      h('strong', {}, `${INSIGHT_TYPES[i.type]?.label || i.type}: `), i.text,
      h('span', { class: 'subtle' }, ` ${formatOffset(i.ts - meeting.startedAt)}`)]),
    meeting.notes ? h('div', { class: 'section' }, h('h3', {}, 'My notes'), h('p', { style: { whiteSpace: 'pre-wrap' } }, meeting.notes)) : null,
    h('div', { class: 'section' }, h('details', {},
      h('summary', {}, `Transcript (${segments.length} lines)`),
      h('div', { class: 'transcript' }, ...transcript.map((l) => h('div', { class: 'line', style: { '--hue': String(speakerHue(l.speaker)) } },
        h('div', { class: 'who' }, h('span', { class: 'name' }, l.speaker), h('span', { class: 'time' }, formatOffset(l.ts - meeting.startedAt))),
        h('div', { class: 'said' }, l.text)))))),
  ].filter(Boolean));
}

async function exportMeeting(meeting, format) {
  const [segments, insights, chat] = await Promise.all([
    db.getSegments(meeting.id), db.getInsights(meeting.id), db.getChat(meeting.id),
  ]);
  const date = new Date(meeting.startedAt).toISOString().slice(0, 10);
  const name = safeFilename(`${date} ${meeting.summary?.title || meeting.title}`);
  if (format === 'md') downloadFile(`${name}.md`, meetingToMarkdown(meeting, segments, insights), 'text/markdown');
  else downloadFile(`${name}.json`, meetingToJson(meeting, segments, insights, chat), 'application/json');
}

// --- Navigation --------------------------------------------------------------------

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  for (const v of ['live', 'ask', 'history']) $(`view-${v}`).hidden = v !== view;
  if (view === 'ask') refreshAskOptions();
  if (view === 'history') renderHistory();
  if (view === 'live') renderLive();
}

// --- Broadcasts from the service worker ----------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg?.type) {
    case 'session:changed':
      onSessionChanged(msg.session);
      break;
    case 'segment:added':
      if (msg.meetingId === state.meeting?.id && !state.segments.some((s) => s.seq === msg.segment.seq)) {
        state.segments.push(msg.segment);
        renderTranscript();
        if (state.sub === 'insights' && !state.insights.length) renderInsights();
      }
      break;
    case 'insights:added':
      if (msg.meetingId === state.meeting?.id) {
        const known = new Set(state.insights.map((i) => i.id));
        state.insights.push(...msg.insights.filter((i) => !known.has(i.id)));
        renderChips();
        renderInsights();
      }
      break;
    case 'status':
      if (msg.meetingId && state.session && msg.meetingId !== state.session.meetingId) break;
      if (msg.level === 'ok') setBanner(msg.key);
      else {
        const actions = msg.key === 'mic'
          ? [{ label: 'Allow', run: () => chrome.tabs.create({ url: chrome.runtime.getURL('src/permission/mic.html') }) }]
          : msg.level === 'error' ? [{ label: 'Settings', run: () => openSettings() }] : [];
        setBanner(msg.key, msg.level, msg.message, actions);
      }
      break;
    case 'meeting:updated':
      if (msg.meetingId === state.meeting?.id) db.getMeeting(msg.meetingId).then((m) => { if (m) { state.meeting = m; renderSessionCard(); } });
      if (state.view === 'history') renderHistory();
      if (state.view === 'ask') refreshAskOptions();
      break;
    case 'meeting:deleted':
      if (msg.meetingId && msg.meetingId === state.meeting?.id) loadLiveMeeting(null);
      if (state.view === 'history') renderHistory();
      if (state.view === 'ask') refreshAskOptions();
      break;
    default:
      break;
  }
  return false;
});

// --- Init --------------------------------------------------------------------------

async function init() {
  $('settingsBtn').append(icon('settings'));
  $('clearChat').append(icon('trash'));
  renderSendButton();

  state.settings = await getSettings();
  onSettingsChanged((s) => { state.settings = s; renderSessionCard(); renderChips(); renderInsights(); });

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
  document.querySelectorAll('.seg').forEach((b) => b.addEventListener('click', () => setSub(b.dataset.sub)));
  $('settingsBtn').addEventListener('click', () => openSettings());
  $('showDone').addEventListener('change', (e) => { state.showDone = e.target.checked; renderChips(); renderInsights(); });

  const saveNotes = debounce((id, notes) => db.updateMeeting(id, { notes }), 600);
  $('notesInput').addEventListener('input', (e) => { if (state.meeting) { state.meeting.notes = e.target.value; saveNotes(state.meeting.id, e.target.value); } });

  $('askMeeting').addEventListener('change', (e) => { state.askMeetingId = e.target.value; loadChat(); });
  $('askForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.asking) state.asking.abort();
    else ask($('askInput').value);
  });
  $('askInput').addEventListener('input', autosize);
  $('askInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('askForm').requestSubmit();
    }
  });
  $('clearChat').addEventListener('click', async () => {
    if (!state.askMeetingId || !state.chat.length || !confirm('Clear this conversation?')) return;
    await db.clearChat(state.askMeetingId);
    await loadChat();
  });
  $('historySearch').addEventListener('input', debounce(() => renderHistory(), 150));

  chrome.tabs.onActivated.addListener(refreshActiveTab);
  chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (tab.active && (info.title || info.url || info.status === 'complete')) refreshActiveTab(); });
  setInterval(updatePill, 1000);

  try {
    const { session } = await send('session:get');
    state.session = session;
  } catch { state.session = null; }
  await refreshActiveTab();
  await loadLiveMeeting(state.session?.meetingId || null);
  renderSessionCard();
  if (state.settings.capture.includeMic && state.session?.mode === 'audio') checkMicPermission();
}

init().catch((err) => showError(err));
