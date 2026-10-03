// Small, dependency-free helpers shared by every extension context.

export function uid() {
  return crypto.randomUUID();
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

/** "75s" -> "01:15", "3725s" -> "1:02:05". Takes milliseconds. */
export function formatOffset(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatDateTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

const STOPWORDS = new Set(('a an the and or but if then of to in on at by for with from as is are was were be been ' +
  'it its this that these those i you he she we they me him her us them my your our their do does did ' +
  'so not no yes can could would should will just about what when where who why how which there here').split(' '));

export function tokenize(text) {
  return String(text).toLowerCase().normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
}

/** Jaccard similarity of the content-word sets of two strings (0..1). */
export function similarity(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Rough token estimate good enough for budgeting prompts (~4 chars/token for English). */
export function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

export function truncate(text, max) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

export function detectPlatform(url) {
  const host = hostnameOf(url);
  if (host === 'meet.google.com') return 'meet';
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'zoom';
  if (/(^|\.)teams\.(microsoft|live)\.com$/.test(host) || host === 'teams.cloud.microsoft') return 'teams';
  if (host.endsWith('webex.com')) return 'webex';
  return 'other';
}

export const PLATFORM_LABELS = {
  meet: 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams', webex: 'Webex', other: 'Browser tab',
};

/** Platforms whose web client shows live captions we can read from the page. */
export const CAPTION_PLATFORMS = new Set(['meet', 'zoom', 'teams']);

export function cleanMeetingTitle(title, platform) {
  let t = String(title || '').trim();
  t = t.replace(/^\(\d+\)\s*/, '');                       // unread-count prefix
  t = t.replace(/\s*[-|–]\s*(Google Meet|Zoom|Microsoft Teams)$/i, '');
  t = t.replace(/^(Meet|Zoom)\s*[-–]\s*/i, '');
  if (!t || /^(meet|zoom|microsoft teams)$/i.test(t)) {
    t = `${PLATFORM_LABELS[platform] || 'Meeting'} meeting`;
  }
  return truncate(t, 120);
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function downloadFile(filename, content, type = 'text/plain') {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'meeting';
}
