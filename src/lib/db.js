// IndexedDB persistence for meetings, transcript segments, insights and Q&A chats.
// Shared by the service worker (writer during capture) and the UI pages.

const DB_NAME = 'smart-meet';
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const meetings = db.createObjectStore('meetings', { keyPath: 'id' });
      meetings.createIndex('startedAt', 'startedAt');
      const segments = db.createObjectStore('segments', { keyPath: ['meetingId', 'seq'] });
      segments.createIndex('meetingId', 'meetingId');
      const insights = db.createObjectStore('insights', { keyPath: 'id' });
      insights.createIndex('meetingId', 'meetingId');
      const chats = db.createObjectStore('chats', { keyPath: 'id' });
      chats.createIndex('meetingId', 'meetingId');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = undefined; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = undefined; reject(req.error); };
    req.onblocked = () => reject(new Error('Database upgrade blocked by another open Smart Meet page.'));
  });
  return dbPromise;
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
});

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

// --- Meetings -----------------------------------------------------------------------

export async function createMeeting(meeting) {
  const record = {
    endedAt: null,
    status: 'live',
    notes: '',
    summary: null,
    segmentCount: 0,
    analysis: { lastSeq: -1, lastRunAt: 0, error: null },
    ...meeting,
  };
  await wrap((await store('meetings', 'readwrite')).put(record));
  return record;
}

export async function getMeeting(id) {
  return wrap((await store('meetings')).get(id));
}

export async function updateMeeting(id, patch) {
  const db = await open();
  const tx = db.transaction('meetings', 'readwrite');
  const os = tx.objectStore('meetings');
  const current = await wrap(os.get(id));
  if (!current) return null;
  const next = typeof patch === 'function' ? patch(structuredClone(current)) : { ...current, ...patch };
  os.put(next);
  await done(tx);
  return next;
}

export async function listMeetings() {
  const all = await wrap((await store('meetings')).index('startedAt').getAll());
  return all.reverse();
}

export async function deleteMeeting(id) {
  const db = await open();
  const tx = db.transaction(['meetings', 'segments', 'insights', 'chats'], 'readwrite');
  tx.objectStore('meetings').delete(id);
  tx.objectStore('segments').delete(IDBKeyRange.bound([id, -Infinity], [id, Infinity]));
  for (const name of ['insights', 'chats']) {
    const keys = await wrap(tx.objectStore(name).index('meetingId').getAllKeys(id));
    for (const k of keys) tx.objectStore(name).delete(k);
  }
  await done(tx);
}

export async function deleteAll() {
  const db = await open();
  const tx = db.transaction(['meetings', 'segments', 'insights', 'chats'], 'readwrite');
  for (const name of ['meetings', 'segments', 'insights', 'chats']) tx.objectStore(name).clear();
  await done(tx);
}

// --- Segments -----------------------------------------------------------------------

/**
 * Atomically assigns the next sequence number and stores the segment.
 * @returns {Promise<object|null>} the stored segment, or null if the meeting is gone.
 */
export async function appendSegment(meetingId, { speaker, text, ts, source }) {
  const db = await open();
  const tx = db.transaction(['meetings', 'segments'], 'readwrite');
  const meetings = tx.objectStore('meetings');
  const meeting = await wrap(meetings.get(meetingId));
  if (!meeting) { tx.abort(); return null; }
  const seg = { meetingId, seq: meeting.segmentCount, speaker, text, ts, source };
  tx.objectStore('segments').add(seg);
  meeting.segmentCount += 1;
  meetings.put(meeting);
  await done(tx);
  return seg;
}

export async function getSegments(meetingId, fromSeq = 0) {
  const range = IDBKeyRange.bound([meetingId, fromSeq], [meetingId, Infinity]);
  return wrap((await store('segments')).getAll(range));
}

// --- Insights -----------------------------------------------------------------------

export async function addInsights(items) {
  if (!items.length) return;
  const db = await open();
  const tx = db.transaction('insights', 'readwrite');
  for (const item of items) tx.objectStore('insights').put(item);
  await done(tx);
}

export async function getInsights(meetingId) {
  const items = await wrap((await store('insights')).index('meetingId').getAll(meetingId));
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

export async function updateInsight(id, patch) {
  const db = await open();
  const tx = db.transaction('insights', 'readwrite');
  const os = tx.objectStore('insights');
  const current = await wrap(os.get(id));
  if (current) os.put({ ...current, ...patch });
  await done(tx);
}

// --- Chats --------------------------------------------------------------------------

export async function addChatMessage(msg) {
  await wrap((await store('chats', 'readwrite')).put(msg));
}

export async function getChat(meetingId) {
  const items = await wrap((await store('chats')).index('meetingId').getAll(meetingId));
  return items.sort((a, b) => a.ts - b.ts);
}

export async function clearChat(meetingId) {
  const db = await open();
  const tx = db.transaction('chats', 'readwrite');
  const keys = await wrap(tx.objectStore('chats').index('meetingId').getAllKeys(meetingId));
  for (const k of keys) tx.objectStore('chats').delete(k);
  await done(tx);
}

// --- Retention ----------------------------------------------------------------------

export async function purgeOlderThan(days) {
  if (!days || days <= 0) return 0;
  const cutoff = Date.now() - days * 86400000;
  const old = (await listMeetings()).filter((m) => m.status !== 'live' && m.startedAt < cutoff);
  for (const m of old) await deleteMeeting(m.id);
  return old.length;
}
