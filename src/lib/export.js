// Meeting export to Markdown / JSON.

import { formatTranscript } from './transcript.js';
import { formatDuration, formatOffset, PLATFORM_LABELS } from './util.js';
import { INSIGHT_TYPES } from './settings.js';

export function meetingToMarkdown(meeting, segments, insights) {
  const s = meeting.summary;
  const out = [`# ${s?.title || meeting.title}`, ''];
  const meta = [
    new Date(meeting.startedAt).toLocaleString(),
    PLATFORM_LABELS[meeting.platform] || meeting.platform,
  ];
  if (meeting.endedAt) meta.push(formatDuration(meeting.endedAt - meeting.startedAt));
  out.push(`_${meta.join(' · ')}_`, '');

  if (s) {
    if (s.summary) out.push('## Summary', '', s.summary, '');
    const list = (title, items) => {
      if (items?.length) out.push(`## ${title}`, '', ...items.map((i) => `- ${i}`), '');
    };
    list('Key points', s.key_points);
    list('Decisions', s.decisions);
    if (s.action_items?.length) {
      out.push('## Action items', '');
      for (const a of s.action_items) {
        const owner = a.owner ? `**${a.owner}**: ` : '';
        const due = a.due ? ` _(due ${a.due})_` : '';
        out.push(`- [ ] ${owner}${a.task}${due}`);
      }
      out.push('');
    }
    list('Open questions', s.open_questions);
  }

  if (meeting.notes) out.push('## My notes', '', meeting.notes, '');

  const kept = insights.filter((i) => i.status !== 'dismissed');
  if (kept.length) {
    out.push('## Flagged during the meeting', '');
    for (const i of kept) {
      const when = formatOffset(i.ts - meeting.startedAt);
      out.push(`- **${INSIGHT_TYPES[i.type]?.label || i.type}** [${when}] ${i.text}${i.speaker ? ` — ${i.speaker}` : ''}`);
    }
    out.push('');
  }

  out.push('## Transcript', '', formatTranscript(segments, meeting.startedAt), '');
  return out.join('\n');
}

export function meetingToJson(meeting, segments, insights, chat) {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    app: 'Smart Meet',
    meeting,
    insights,
    transcript: segments.map(({ seq, speaker, text, ts, source }) => ({ seq, speaker, text, ts, source })),
    chat: chat.map(({ role, content, ts }) => ({ role, content, ts })),
  }, null, 2);
}
