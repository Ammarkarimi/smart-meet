// Background orchestrator: owns the capture session, stores the transcript,
// runs live insight detection and writes the post-meeting summary.

import * as db from '../lib/db.js';
import {
  getSettings, llmConfig, sttConfig, isLlmConfigured, resolveCaptureMode,
} from '../lib/settings.js';
import { analyzeTranscript, selectWindow, ALL_TYPES } from '../lib/analyzer.js';
import { summarizeMeeting } from '../lib/qa.js';
import { CAPTION_PLATFORMS, cleanMeetingTitle, detectPlatform, sleep, uid } from '../lib/util.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const CONTENT_SCRIPTS = ['src/content/caption-diff.js', 'src/content/captions.js'];

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// --- Helpers ------------------------------------------------------------------------

class UserError extends Error {
  constructor(message, code = '') {
    super(message);
    this.code = code;
  }
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* no page listening */ });
}

/** Extension API calls reset the service-worker idle timer; keeps long LLM calls alive. */
async function keepAlive(promise) {
  const t = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try { return await promise; } finally { clearInterval(t); }
}

async function getSession() {
  const { session } = await chrome.storage.session.get('session');
  return session || null;
}

async function setSession(session) {
  if (session) await chrome.storage.session.set({ session });
  else await chrome.storage.session.remove('session');
  broadcast({ type: 'session:changed', session: session || null });
}

async function updateBadge() {
  const session = await getSession();
  if (!session) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Open Smart Meet' });
    return;
  }
  const insights = await db.getInsights(session.meetingId);
  const open = insights.filter((i) => i.status === 'open' && (i.type === 'question' || i.type === 'clarification')).length;
  await chrome.action.setBadgeBackgroundColor({ color: open ? '#E5484D' : '#4F46E5' });
  await chrome.action.setBadgeText({ text: open ? String(Math.min(open, 99)) : 'REC' });
  await chrome.action.setTitle({ title: open ? `Smart Meet – ${open} open question(s)` : 'Smart Meet – capturing' });
}

// --- Offscreen document (tab + mic audio capture) -----------------------------------

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

let creatingOffscreen;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Record meeting tab and microphone audio for live transcription.',
  }).finally(() => { creatingOffscreen = undefined; });
  await creatingOffscreen;
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

async function sendToOffscreen(msg) {
  for (let i = 0; i < 20; i++) {
    try {
      return await chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
    } catch (err) {
      if (!/Receiving end does not exist|Could not establish connection/i.test(err.message)) throw err;
      await sleep(100);
    }
  }
  throw new Error('The audio recorder did not start. Reload the extension and try again.');
}

// --- Caption reading (content script) ------------------------------------------------

async function startCaptions(tabId, meetingId) {
  const msg = { type: 'captions:start', meetingId };
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // Tab was open before the extension was installed/updated: inject now.
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: CONTENT_SCRIPTS });
    await chrome.tabs.sendMessage(tabId, msg);
  }
}

// --- Session lifecycle ----------------------------------------------------------------

async function startSession({ tabId, streamId, title, url }) {
  if (await getSession()) throw new UserError('Smart Meet is already capturing a meeting. Stop it first.');
  const settings = await getSettings();
  if (!settings.consentAccepted) {
    throw new UserError('Please review the recording-consent notice in Settings before your first capture.', 'consent');
  }
  const platform = detectPlatform(url);
  const { mode, reason } = resolveCaptureMode(settings, CAPTION_PLATFORMS.has(platform));
  if (!mode) throw new UserError(reason, 'setup');
  if (mode === 'audio' && !streamId) {
    throw new UserError('Chrome did not grant access to this tab’s audio. Click the Smart Meet toolbar icon while on the meeting tab, then press Start.', 'capture');
  }

  const meeting = await db.createMeeting({
    id: uid(),
    title: cleanMeetingTitle(title, platform),
    platform,
    url: url || '',
    startedAt: Date.now(),
    mode,
  });
  const session = { meetingId: meeting.id, tabId, mode, platform, startedAt: meeting.startedAt, status: 'starting' };
  await setSession(session);

  try {
    if (mode === 'audio') {
      await ensureOffscreen();
      const res = await sendToOffscreen({
        type: 'capture:start',
        meetingId: meeting.id,
        streamId,
        stt: sttConfig(settings),
        capture: settings.capture,
      });
      if (!res?.ok) throw new UserError(res?.error || 'Could not start audio capture.', 'capture');
      if (res.warning) broadcast({ type: 'status', meetingId: meeting.id, key: 'mic', level: 'warn', message: res.warning });
    } else {
      await startCaptions(tabId, meeting.id);
    }
  } catch (err) {
    await closeOffscreen();
    await db.deleteMeeting(meeting.id);
    await setSession(null);
    throw err instanceof UserError ? err : new UserError(err.message || String(err), 'capture');
  }

  const live = { ...session, status: 'live' };
  await setSession(live);
  await updateBadge();
  if (!isLlmConfigured(settings)) {
    broadcast({ type: 'status', meetingId: meeting.id, key: 'analysis', level: 'warn', message: 'Transcribing only. Add an LLM API key in Settings to get live insights.' });
  }
  return live;
}

let stopping = null;
function stopSession(reason = 'user') {
  stopping ??= doStop(reason).finally(() => { stopping = null; });
  return stopping;
}

async function doStop(reason) {
  const session = await getSession();
  if (!session) return null;
  await setSession({ ...session, status: 'stopping' });

  if (session.mode === 'audio') {
    // The recorder flushes its last chunk and waits for pending transcriptions.
    await sendToOffscreen({ type: 'capture:stop' }).catch(() => {});
    await closeOffscreen();
  } else {
    await chrome.tabs.sendMessage(session.tabId, { type: 'captions:stop' }).catch(() => {});
  }

  const segments = await db.getSegments(session.meetingId);
  const endedAt = segments.length ? Math.max(Date.now() - 1000, segments[segments.length - 1].ts) : Date.now();
  await db.updateMeeting(session.meetingId, { status: 'ended', endedAt, endReason: reason });
  await setSession(null);
  await updateBadge();
  broadcast({ type: 'meeting:updated', meetingId: session.meetingId });

  if (segments.length) keepAlive(finalize(session.meetingId)).catch((e) => console.warn('finalize failed', e));
  else await db.deleteMeeting(session.meetingId).then(() => broadcast({ type: 'meeting:deleted', meetingId: session.meetingId }));
  return session.meetingId;
}

async function finalize(meetingId) {
  await lockedAnalysis(() => analyzeIfDue(meetingId, { force: true }));
  const settings = await getSettings();
  if (settings.insights.autoSummary && isLlmConfigured(settings)) await generateSummary(meetingId);
}

async function generateSummary(meetingId) {
  const settings = await getSettings();
  if (!isLlmConfigured(settings)) throw new UserError('Add an LLM API key in Settings to generate summaries.', 'setup');
  const meeting = await db.getMeeting(meetingId);
  if (!meeting) throw new UserError('Meeting not found.');
  const segments = await db.getSegments(meetingId);
  if (!segments.length) throw new UserError('This meeting has no transcript to summarize.');

  await db.updateMeeting(meetingId, { summaryStatus: 'pending', summaryError: null });
  broadcast({ type: 'meeting:updated', meetingId });
  try {
    const summary = await keepAlive(summarizeMeeting(llmConfig(settings), { meeting, segments, profile: settings.profile }));
    await db.updateMeeting(meetingId, { summary, summaryStatus: 'done', summaryError: null });
  } catch (err) {
    await db.updateMeeting(meetingId, { summaryStatus: 'error', summaryError: err.message || String(err) });
  }
  broadcast({ type: 'meeting:updated', meetingId });
}

// --- Transcript intake ----------------------------------------------------------------

async function onSegment({ meetingId, speaker, text, ts, source }) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  const seg = await db.appendSegment(meetingId, {
    speaker: String(speaker || 'Speaker').slice(0, 80),
    text: clean.slice(0, 5000),
    ts: Number(ts) || Date.now(),
    source,
  });
  if (!seg) return;
  broadcast({ type: 'segment:added', meetingId, segment: seg });
  const session = await getSession();
  if (session?.meetingId === meetingId && session.status === 'live') scheduleAnalysis(meetingId);
}

// --- Live analysis ----------------------------------------------------------------------

let analysisChain = Promise.resolve();
let analysisPending = false;
let analysisTimer;

function lockedAnalysis(fn) {
  const run = analysisChain.then(fn, fn);
  analysisChain = run.catch(() => {});
  return run;
}

function scheduleAnalysis(meetingId) {
  if (analysisPending) return;
  analysisPending = true;
  lockedAnalysis(async () => {
    analysisPending = false;
    await keepAlive(analyzeIfDue(meetingId, { force: false }));
  }).catch((e) => console.warn('analysis failed', e));
}

function armTimer(meetingId, ms) {
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(() => scheduleAnalysis(meetingId), ms);
}

const warned = new Set();

async function analyzeIfDue(meetingId, { force }) {
  const settings = await getSettings();
  if (!isLlmConfigured(settings)) return;
  const meeting = await db.getMeeting(meetingId);
  if (!meeting) return;
  const all = await db.getSegments(meetingId);
  const fresh = all.filter((s) => s.seq > meeting.analysis.lastSeq);
  if (!fresh.length) return;

  const newChars = fresh.reduce((n, s) => n + s.text.length, 0);
  const since = Date.now() - (meeting.analysis.lastRunAt || meeting.startedAt);
  const interval = settings.insights.intervalSec * 1000;
  if (!force) {
    const inBackoff = meeting.analysis.error && since < 30000;
    if (inBackoff || (newChars < settings.insights.minNewChars && since < interval)) {
      armTimer(meetingId, Math.max(2000, (inBackoff ? 30000 : interval) - since));
      return;
    }
  }

  const lastSeq = fresh[fresh.length - 1].seq;
  const enabledTypes = ALL_TYPES.filter((t) => settings.insights.types[t]);
  const markDone = (error = null) => db.updateMeeting(meetingId, (m) => {
    m.analysis = error
      ? { ...m.analysis, lastRunAt: Date.now(), error }
      : { lastSeq: Math.max(m.analysis.lastSeq, lastSeq), lastRunAt: Date.now(), error: null };
    return m;
  });
  if (!enabledTypes.length) { await markDone(); return; }

  const { fresh: window, context } = selectWindow(all, meeting.analysis.lastSeq);
  const existing = (await db.getInsights(meetingId)).slice(-40);
  try {
    const items = await analyzeTranscript(llmConfig(settings, 'live'), {
      meeting,
      profile: settings.profile,
      enabledTypes,
      suggestReplies: settings.insights.suggestReplies,
      existing,
      context,
      fresh: window,
    });
    await db.addInsights(items);
    await markDone();
    if (items.length) broadcast({ type: 'insights:added', meetingId, insights: items });
    if (meeting.analysis.error) broadcast({ type: 'status', meetingId, key: 'analysis', level: 'ok' });
    await updateBadge();
  } catch (err) {
    await markDone(err.message || String(err));
    broadcast({ type: 'status', meetingId, key: 'analysis', level: 'error', message: `Insights paused: ${err.message}` });
    if (!force) armTimer(meetingId, 30000);
  }
}

// --- Housekeeping -----------------------------------------------------------------------

async function recoverStaleMeetings() {
  const session = await getSession();
  const meetings = await db.listMeetings();
  for (const m of meetings) {
    if (m.status === 'live' && m.id !== session?.meetingId) {
      const segs = await db.getSegments(m.id);
      if (!segs.length) { await db.deleteMeeting(m.id); continue; }
      await db.updateMeeting(m.id, { status: 'ended', endedAt: segs[segs.length - 1].ts, endReason: 'interrupted' });
    }
  }
  if (session?.mode === 'audio' && !(await hasOffscreen())) {
    await db.updateMeeting(session.meetingId, { status: 'ended', endedAt: Date.now(), endReason: 'interrupted' });
    await setSession(null);
  }
  await updateBadge();
}

async function applyRetention() {
  const settings = await getSettings();
  const removed = await db.purgeOlderThan(settings.privacy.retentionDays);
  if (removed) broadcast({ type: 'meeting:deleted' });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.alarms.create('retention', { periodInMinutes: 720, delayInMinutes: 1 });
  await recoverStaleMeetings().catch(() => {});
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html?welcome=1') });
});

chrome.runtime.onStartup.addListener(() => {
  recoverStaleMeetings().catch(() => {});
  applyRetention().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'retention') applyRetention().catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await getSession();
  if (session?.tabId === tabId) stopSession('tab-closed');
});

// --- Messaging ----------------------------------------------------------------------------

const handlers = {
  'session:get': async () => ({ session: await getSession() }),
  'session:start': async (msg) => ({ session: await startSession(msg) }),
  'session:stop': async () => ({ meetingId: await stopSession('user') }),
  'summary:generate': async (msg) => { await generateSummary(msg.meetingId); return {}; },
  'badge:refresh': async () => { await updateBadge(); return {}; },
  'analysis:run': async (msg) => {
    await lockedAnalysis(() => analyzeIfDue(msg.meetingId, { force: true }));
    return {};
  },

  // From the offscreen recorder.
  'offscreen:segment': async (msg) => { await onSegment(msg); return {}; },
  'offscreen:error': async (msg) => {
    const session = await getSession();
    broadcast({ type: 'status', meetingId: session?.meetingId, key: 'transcription', level: 'error', message: msg.message });
    if (msg.fatal && session) await stopSession('error');
    return {};
  },
  'offscreen:ok': async () => {
    const session = await getSession();
    broadcast({ type: 'status', meetingId: session?.meetingId, key: 'transcription', level: 'ok' });
    return {};
  },
  'offscreen:ended': async () => { await stopSession('capture-ended'); return {}; },
  'offscreen:ping': async () => ({}),

  // From the caption content script.
  'captions:segment': async (msg, sender) => {
    const session = await getSession();
    if (!session || session.mode !== 'captions' || session.tabId !== sender.tab?.id) return {};
    if (msg.meetingId !== session.meetingId) return {};
    await onSegment({ ...msg, source: 'captions' });
    return {};
  },
  'captions:status': async (msg, sender) => {
    const session = await getSession();
    if (!session || session.tabId !== sender.tab?.id) return {};
    broadcast({
      type: 'status',
      meetingId: session.meetingId,
      key: 'captions',
      level: msg.state === 'active' ? 'ok' : 'warn',
      message: msg.hint,
    });
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler(msg, sender).then(
    (result) => sendResponse({ ok: true, ...result }),
    (err) => {
      if (!(err instanceof UserError)) console.error(`[smart-meet] ${msg.type} failed`, err);
      sendResponse({ ok: false, error: err.message || String(err), code: err.code || '' });
    },
  );
  return true;
});
