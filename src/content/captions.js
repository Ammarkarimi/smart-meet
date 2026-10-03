// Reads live captions from Google Meet, Zoom (web client) and Microsoft Teams
// (web). Idle until the service worker sends "captions:start".

(function smartMeetCaptions() {
  if (globalThis.__smartMeetCaptionsLoaded) return;
  globalThis.__smartMeetCaptionsLoaded = true;

  const { newTextSince, norm } = globalThis.SmartMeetCaptionDiff;
  const STABLE_MS = 1800;   // emit a caption once it stops changing for this long
  const POLL_MS = 400;
  const host = location.hostname;

  // Selectors are layered from most to least specific; web clients change markup often.
  const PLATFORMS = [
    {
      id: 'meet',
      match: () => host === 'meet.google.com',
      roots: ['div[role="region"][aria-label*="aption" i]', 'div[jsname="dsyhDe"]', '.a4cQT'],
      block: null, // direct children of the root
      speaker: ['.NWpY1d', '.KcIKyf', '.zs7s8d'],
      text: ['.ygicle', '.bh44bd', '.VbkSUe', '.iTTPOb'],
    },
    {
      id: 'teams',
      match: () => /(^|\.)teams\.(microsoft|live)\.com$/.test(host) || host === 'teams.cloud.microsoft',
      roots: ['[data-tid="closed-caption-v2-window-wrapper"]', '[data-tid="closed-captions-renderer"]', '[data-tid="closed-caption-renderer-wrapper"]'],
      block: '[data-tid="closed-caption-message"], .fui-ChatMessageCompact, [data-tid="closed-caption-item"]',
      speaker: ['[data-tid="author"]', '.ui-chat__message__author'],
      text: ['[data-tid="closed-caption-text"]', '.ui-chat__message__content'],
    },
    {
      id: 'zoom',
      match: () => host === 'zoom.us' || host.endsWith('.zoom.us'),
      roots: ['#live-transcription-subtitle', '.live-transcription-subtitle__box', '[class*="live-transcription-subtitle"]', '[class*="closed-caption"]'],
      block: '.live-transcription-subtitle__item, [class*="subtitle__item"], [class*="caption-item"]',
      speaker: ['[class*="speaker"]', '[class*="name"]'],
      text: ['[class*="text"]'],
    },
  ];

  const platform = PLATFORMS.find((p) => p.match());
  if (!platform) return;

  let meetingId = null;
  let timer = null;
  let tracked = new Map();        // element -> {speaker, emitted, last, changedAt}
  let foundRoot = false;
  let startedAt = 0;
  let hinted = false;

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // Extension was reloaded; this script is orphaned.
      stop(false);
      return Promise.resolve();
    }
  }

  function queryFirst(rootEl, selectors) {
    for (const sel of selectors) {
      try {
        const el = rootEl.querySelector(sel);
        if (el) return el;
      } catch { /* invalid selector in this browser */ }
    }
    return null;
  }

  function findRoot() {
    for (const sel of platform.roots) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.offsetParent !== null || el.getClientRects().length) return el;
      }
    }
    return null;
  }

  function leafTexts(el) {
    const out = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || parent.closest('button, [role="button"], style, script, [aria-hidden="true"]')) continue;
      const t = norm(node.textContent);
      if (t) out.push({ t, parent });
    }
    return out;
  }

  function extract(block) {
    const speakerEl = queryFirst(block, platform.speaker);
    const textEl = queryFirst(block, platform.text);
    if (textEl) {
      const speaker = speakerEl && !speakerEl.contains(textEl) ? norm(speakerEl.textContent) : '';
      return { speaker, text: norm(textEl.textContent) };
    }
    // Heuristic fallback: first short leaf is the speaker name, the rest is the caption.
    const leaves = leafTexts(block);
    if (!leaves.length) return null;
    if (leaves.length === 1) return { speaker: '', text: leaves[0].t };
    const first = leaves[0].t;
    const rest = leaves.slice(1).map((l) => l.t).join(' ');
    if (first.length <= 60 && rest) return { speaker: first, text: rest };
    return { speaker: '', text: leaves.map((l) => l.t).join(' ') };
  }

  function blocksOf(rootEl) {
    if (platform.block) {
      const list = rootEl.querySelectorAll(platform.block);
      if (list.length) return [...list];
    }
    return [...rootEl.children].filter((c) => norm(c.textContent));
  }

  function emit(entry, text) {
    const delta = newTextSince(entry.emitted, text);
    entry.emitted = text;
    if (!delta || delta.length < 2) return Promise.resolve();
    return send({
      type: 'captions:segment',
      meetingId,
      speaker: entry.speaker || 'Speaker',
      text: delta,
      ts: entry.firstSeenAt,
    }).then(() => { entry.firstSeenAt = Date.now(); });
  }

  function poll() {
    const now = Date.now();
    const rootEl = findRoot();
    if (!rootEl) {
      // Only the top frame nags; caption-less iframes stay quiet.
      if (!hinted && window === window.top && now - startedAt > 8000) {
        hinted = true;
        send({ type: 'captions:status', state: 'waiting', hint: 'Turn on captions (CC) in the meeting so Smart Meet can read the conversation.' });
      }
      if (foundRoot) flushAll();
      return;
    }
    if (!foundRoot || hinted) {
      foundRoot = true;
      hinted = false;
      send({ type: 'captions:status', state: 'active', hint: 'Reading live captions.' });
    }

    const seen = new Set();
    for (const block of blocksOf(rootEl)) {
      const data = extract(block);
      if (!data?.text) continue;
      seen.add(block);
      let entry = tracked.get(block);
      if (!entry) {
        entry = { speaker: data.speaker, emitted: '', last: '', changedAt: now, firstSeenAt: now };
        tracked.set(block, entry);
      }
      if (data.speaker) entry.speaker = data.speaker;
      if (data.text !== entry.last) {
        entry.last = data.text;
        entry.changedAt = now;
      } else if (now - entry.changedAt >= STABLE_MS && entry.last !== entry.emitted) {
        emit(entry, entry.last);
      }
    }
    // Blocks that disappeared are final.
    for (const [block, entry] of tracked) {
      if (!seen.has(block)) {
        if (entry.last !== entry.emitted) emit(entry, entry.last);
        tracked.delete(block);
      }
    }
  }

  function flushAll() {
    const pending = [];
    for (const entry of tracked.values()) {
      if (entry.last && entry.last !== entry.emitted) pending.push(emit(entry, entry.last));
    }
    tracked = new Map();
    return Promise.all(pending);
  }

  function start(id) {
    stop(false);
    meetingId = id;
    startedAt = Date.now();
    foundRoot = false;
    hinted = false;
    timer = setInterval(poll, POLL_MS);
    poll();
  }

  async function stop(flush = true) {
    if (timer) clearInterval(timer);
    timer = null;
    if (flush && meetingId) await flushAll();
    tracked = new Map();
    meetingId = null;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'captions:start') {
      start(msg.meetingId);
      sendResponse({ ok: true, platform: platform.id, frame: window === window.top ? 'top' : 'child' });
      return false;
    }
    if (msg?.type === 'captions:stop') {
      stop(true).then(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  });
}());
