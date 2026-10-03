// Offscreen recorder: captures the meeting tab (other participants) and the
// microphone (the user), cuts both into chunks and transcribes them.
// Offscreen documents only get chrome.runtime, so all config arrives in the start message.

import { ChunkedRecorder } from '../lib/recorder.js';
import { transcribe } from '../lib/transcription.js';
import { cleanTranscriptText, isLikelyHallucination } from '../lib/transcript.js';

let state = null;

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => {});
}

class SourcePipeline {
  constructor({ source, speaker, stream, ctx, meetingId, stt, capture }) {
    this.source = source;
    this.speaker = speaker;
    this.meetingId = meetingId;
    this.stt = stt;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.lastText = '';
    this.failures = 0;
    this.recorder = new ChunkedRecorder(stream, {
      audioContext: ctx,
      minMs: capture.minChunkSec * 1000,
      maxMs: capture.maxChunkSec * 1000,
      silenceMs: capture.silenceMs,
      onChunk: (blob, info) => this.enqueue(blob, info),
    });
  }

  start() { this.recorder.start(); }

  enqueue(blob, info) {
    this.pending++;
    // Serial per source keeps segments in order and gives the model the previous text as a prompt.
    this.queue = this.queue.then(() => this.process(blob, info)).finally(() => { this.pending--; });
  }

  async process(blob, info) {
    try {
      const raw = await transcribe(this.stt, blob, { prompt: this.lastText, language: this.stt.language });
      const text = cleanTranscriptText(raw);
      if (this.failures) { this.failures = 0; send({ type: 'offscreen:ok' }); }
      if (!text || isLikelyHallucination(text)) return;
      this.lastText = `${this.lastText} ${text}`.slice(-600);
      await send({
        type: 'offscreen:segment',
        meetingId: this.meetingId,
        source: this.source,
        speaker: this.speaker,
        text,
        ts: info.startedAt,
      });
    } catch (err) {
      this.failures++;
      await send({ type: 'offscreen:error', message: err.message || String(err), fatal: Boolean(err.fatal) });
    }
  }

  async stop() {
    await this.recorder.stop();
    // Wait for in-flight transcriptions (bounded so stopping never hangs).
    await Promise.race([this.queue, new Promise((r) => setTimeout(r, 25000))]);
  }
}

async function start({ meetingId, streamId, stt, capture }) {
  if (state) await stop();
  const ctx = new AudioContext();
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  // Capturing a tab mutes it for the user; route the audio back to the speakers.
  ctx.createMediaStreamSource(tabStream).connect(ctx.destination);

  const pipelines = [new SourcePipeline({ source: 'tab', speaker: 'Others', stream: tabStream, ctx, meetingId, stt, capture })];
  const streams = [tabStream];
  let warning = '';

  if (capture.includeMic) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streams.push(micStream);
      pipelines.push(new SourcePipeline({ source: 'mic', speaker: 'You', stream: micStream, ctx, meetingId, stt, capture }));
    } catch (err) {
      warning = err.name === 'NotAllowedError'
        ? 'Microphone access isn’t granted, so only other participants are transcribed. Grant it in Settings → Capture.'
        : `Microphone unavailable (${err.message}). Only other participants are transcribed.`;
    }
  }

  for (const track of tabStream.getAudioTracks()) {
    track.addEventListener('ended', () => { if (state) send({ type: 'offscreen:ended' }); });
  }

  pipelines.forEach((p) => p.start());
  const ping = setInterval(() => send({ type: 'offscreen:ping' }), 20000);
  state = { ctx, streams, pipelines, ping };
  return { warning };
}

async function stop() {
  if (!state) return;
  const { ctx, streams, pipelines, ping } = state;
  state = null;
  clearInterval(ping);
  await Promise.all(pipelines.map((p) => p.stop()));
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  await ctx.close().catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'capture:start') {
    start(msg).then(
      ({ warning }) => sendResponse({ ok: true, warning }),
      (err) => sendResponse({ ok: false, error: describeCaptureError(err) }),
    );
    return true;
  }
  if (msg.type === 'capture:stop') {
    stop().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

function describeCaptureError(err) {
  if (err?.name === 'NotAllowedError' || /Permission/i.test(err?.message)) {
    return 'Chrome blocked tab audio capture. Click the Smart Meet toolbar icon on the meeting tab and press Start again.';
  }
  return `Could not capture tab audio: ${err?.message || err}`;
}
