# Smart Meet – AI Meeting Copilot

A Chrome/Edge extension that listens to your online meetings with you. It flags **questions that need an answer** and **points worth clarifying** in a side panel while people talk. When the meeting ends, you can **ask anything about the conversation**. It runs on your own LLM API key, and there is no backend.

- **Live insights.** Questions, clarification points (vague deadlines, undefined acronyms, conflicting statements), action items, decisions and key facts. Items aimed at you are highlighted, and each comes with a suggested reply you can say out loud. A one-click "Draft answer" streams a fuller reply.
- **Works anywhere.**
  - *Audio mode* captures the meeting tab plus your mic on any site (Google Meet, Zoom web, Teams, Webex, Whereby…), with your voice labelled "You".
  - *Caption mode* reads Meet, Zoom web or Teams web captions for free, with speaker names.
- **Ask AI.** Chat with any meeting, live or past. Answers cite `[mm:ss]` timestamps. Long meetings fall back to BM25 retrieval over the transcript.
- **Summaries.** Title, summary, decisions, action items (owner and due date) and open questions are written automatically when the meeting ends.
- **History and export.** Search past meetings and export them to Markdown or JSON. Automatic deletion is optional.
- **Bring your own model.** OpenAI, Anthropic Claude, Google Gemini, OpenRouter, Groq, Ollama (local), or any OpenAI-compatible endpoint. Speech-to-text runs on OpenAI, Groq, Deepgram, or a self-hosted Whisper server.
- **Private by design.** Data stays in IndexedDB on the device. Requests go straight from the browser to the provider you chose. There is no analytics or tracking. See [PRIVACY.md](PRIVACY.md).

## Install

**From a release:** download `smart-meet-<version>.zip` from [Releases](https://github.com/Ammarkarimi/smart-meet/releases) and unzip it. Then follow steps 2–4 below, selecting the unzipped folder.

**From source:**

1. `npm run icons` (only needed if you change the icon; the PNGs are committed).
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. The settings page opens. Add an API key, pick a capture mode, then open a meeting, click the toolbar icon, and press **Start**.

Requires Chrome or Edge 116+. Firefox and Safari don't support the side panel and tab-capture APIs this extension uses.

## Quick start configurations

| Goal | AI model | Transcription | Capture mode |
| --- | --- | --- | --- |
| One key, best quality | OpenAI `gpt-5-mini` | OpenAI `gpt-4o-mini-transcribe` | Automatic |
| Claude | Anthropic `claude-opus-5-5` (optionally a faster live model such as `claude-haiku-4-5`) | Groq or OpenAI | Automatic |
| Cheapest | Groq `llama-3.3-70b-versatile` | Groq `whisper-large-v3-turbo` | Automatic |
| No speech-to-text bill | Any | None | Live captions (turn on CC in the meeting) |
| Fully local | Ollama | Custom → local Whisper server (e.g. speaches / faster-whisper-server) | Audio |

For Ollama, start it with `OLLAMA_ORIGINS=chrome-extension://*` so the extension is allowed to call it.

## How it works

```
 Meeting tab ──tabCapture──▶ offscreen document ──▶ speech-to-text API
      │                     (VAD-chunked webm/opus,     │
      │                      tab audio + mic)           ▼
      └─ caption content script ───────────────▶ service worker ──▶ IndexedDB
                                                  │  (session, transcript,
                                                  │   insight scheduling,
                                                  ▼   summary)
                                              LLM provider
                                                  ▲
 Side panel (Live · Ask AI · History) ────────────┘ streaming Q&A, draft replies
```

- `src/background/service-worker.js`: session lifecycle, transcript intake, debounced live analysis (it runs every *N* seconds or after *M* new characters, whichever comes first), and the summary at the end of the meeting.
- `src/offscreen/offscreen.js` and `src/lib/recorder.js`: record tab and mic audio, cut it into chunks at natural pauses, skip silent chunks, transcribe chunks in order, and filter out common Whisper hallucinations.
- `src/content/captions.js`: reads live captions in Meet, Teams and Zoom web, sending text once it has stopped changing and de-duplicating text that grows or gets revised (`caption-diff.js`).
- `src/lib/providers.js`: one `complete` / `stream` / `listModels` interface over every LLM provider, with retries, JSON mode and a fallback when an endpoint rejects JSON mode.
- `src/lib/analyzer.js` and `src/lib/qa.js`: prompts, schemas, parsing, de-duplication, retrieval and summarisation.
- `src/sidepanel/`, `src/options/`: the UI, written in plain ES modules with no framework and no build step.

### Claude-specific behaviour

For Anthropic models, the extension calls the Messages API directly from the browser with the `anthropic-dangerous-direct-browser-access` header. It caches the transcript-bearing system prompt (`cache_control`) so follow-up questions are cheaper. Effort is set only on models that support it: `low` for live detection and draft replies, `medium` for Q&A and summaries. JSON comes from structured outputs (`output_config.format`).

On Claude Opus 5 / 5.5, Sonnet 5.5 and Fable 5.1, requests opt in to server-side refusal fallback (`fallbacks: "default"`), and a `refusal` stop reason produces a clear error message. To turn the fallback off, remove `anthropicSupportsFallback` in `providers.js`.

## Development

```bash
npm test          # unit tests (node:test, no dependencies)
npm run check     # validates manifest + every file reference
npm run build     # check, then package dist/smart-meet-<version>.zip
```

There are no runtime or dev dependencies. CI (`.github/workflows/ci.yml`) runs the tests and uploads the store zip as a build artifact on every push. Pushing a `v<version>` tag runs `.github/workflows/release.yml`, which publishes the zip as a GitHub release.

### Manual test checklist before a release

- [ ] Google Meet, audio mode: Start from the toolbar icon, confirm others are transcribed as "Others" and you as "You", and that you can still hear the meeting.
- [ ] Google Meet, caption mode: turn on CC; speaker names appear; the "turn on captions" hint shows when CC is off.
- [ ] Zoom web client (`app.zoom.us/wc`) and Teams web in both modes.
- [ ] An insight appears within about 20 s of someone asking you a question; Draft answer streams; Done, dismiss and the badge count update.
- [ ] Stop: the summary appears in History; Ask AI answers with timestamps; Markdown and JSON export open correctly.
- [ ] Closing the meeting tab stops the capture; an invalid API key shows a banner rather than failing silently.
- [ ] Settings: Test connection works for each provider you support; Delete all clears History.

## Deployment

Smart Meet has no backend. Deploying it means publishing the privacy policy on GitHub Pages, tagging a release, and submitting the zip to the Chrome Web Store and Microsoft Edge Add-ons. The full step-by-step guide is in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

In short:

1. Bump `version` in **both** `manifest.json` and `package.json` (`npm run check` enforces that they match), then update `CHANGELOG.md`.
2. Run `npm run verify` and go through the manual test checklist above.
3. Commit, then `git tag v<version>` and `git push origin main v<version>`. The Release workflow builds `smart-meet-<version>.zip` and attaches it to a GitHub release.
4. Upload the zip to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) and [Edge Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview). The listing text is in [docs/STORE_LISTING.md](docs/STORE_LISTING.md), and the screenshots, promo tile and logo are in [docs/store/](docs/store/).
5. Privacy policy URL for both stores: `https://ammarkarimi.github.io/smart-meet/PRIVACY.html`. Enable it once under **Settings → Pages** (main branch, root folder).

## Limitations

- The Zoom and Teams **desktop apps** can't be captured by a browser extension. Join from the browser instead.
- Caption selectors depend on each web client's markup. If a vendor redesign breaks caption reading, audio mode still works. Selectors are listed at the top of `src/content/captions.js`.
- In audio mode, all remote participants are labelled "Others". Use caption mode on Meet or Teams if you need per-speaker names.
- Chrome allows tab capture only after you invoke the extension on that tab. If Start reports this, click the toolbar icon on the meeting tab, then press Start.
