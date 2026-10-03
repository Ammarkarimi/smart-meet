// Transcript cleanup and formatting.

import { formatOffset } from './util.js';

// Whisper-family models invent these on silence or music.
const HALLUCINATIONS = [
  /^(thank you|thanks)( (so|very) much)?( for watching| for listening)?[.!]*$/i,
  /^(please )?(like and )?subscribe.*$/i,
  /^subtitles? (by|created by|provided by).*$/i,
  /^(transcribed|translated|captioned) by.*$/i,
  /amara\.org/i,
  /^you[.!]*$/i,
  /^bye[.!]*$/i,
  /^\.+$/,
  /^\[(music|silence|blank_audio|inaudible|applause|laughter)\]$/i,
  /^\((music|silence|inaudible|applause|laughter)\)$/i,
  /^♪+.*$/,
];

export function cleanTranscriptText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\[(BLANK_AUDIO|MUSIC|SILENCE)\]/gi, '')
    .trim();
}

export function isLikelyHallucination(text) {
  const t = cleanTranscriptText(text);
  if (!t) return true;
  if (HALLUCINATIONS.some((re) => re.test(t))) return true;
  // Degenerate repetition loops: "okay okay okay okay okay okay ..."
  const words = t.toLowerCase().split(/\s+/);
  if (words.length >= 8) {
    const counts = new Map();
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    const top = Math.max(...counts.values());
    if (top / words.length > 0.6) return true;
  }
  return false;
}

/** "[05:12] Alice: Hello" – the format every prompt and export uses. */
export function formatSegment(seg, startedAt, { withSeq = false } = {}) {
  const when = formatOffset(seg.ts - startedAt);
  const tag = withSeq ? `#${seg.seq} ${when}` : when;
  return `[${tag}] ${seg.speaker || 'Speaker'}: ${seg.text}`;
}

export function formatTranscript(segments, startedAt, opts) {
  return segments.map((s) => formatSegment(s, startedAt, opts)).join('\n');
}

/**
 * Merges consecutive segments from the same speaker that are close in time,
 * for a more readable transcript view. Returns new objects.
 */
export function mergeForDisplay(segments, gapMs = 20000) {
  const out = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker && s.ts - last.endTs <= gapMs && last.text.length < 1200) {
      last.text = `${last.text} ${s.text}`;
      last.endTs = s.ts;
      last.seqs.push(s.seq);
    } else {
      out.push({ ...s, endTs: s.ts, seqs: [s.seq] });
    }
  }
  return out;
}

/** Last `maxChars` characters of transcript lines, keeping whole lines. */
export function tailLines(segments, startedAt, maxChars) {
  const lines = [];
  let total = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    const line = formatSegment(segments[i], startedAt);
    if (total + line.length > maxChars && lines.length) break;
    lines.unshift(line);
    total += line.length + 1;
  }
  return lines.join('\n');
}
