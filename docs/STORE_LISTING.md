# Store listing (Chrome Web Store and Edge Add-ons)

Copy these fields into the store dashboards. The upload steps are in [DEPLOYMENT.md](DEPLOYMENT.md).

## Name
Smart Meet – AI Meeting Copilot

## Summary (≤132 chars)
Spots questions and points to clarify in your Google Meet, Zoom and Teams calls, live. Bring your own LLM API key.

## Category
Productivity → Tools

## Description

Never miss a question asked in a meeting again.

Smart Meet follows your online meetings with you and shows a side panel with:

• **Questions that need an answer**, highlighted when they're aimed at you, with a suggested reply you can say right away
• **Points worth clarifying**: vague deadlines, unclear owners, undefined acronyms, conflicting numbers
• **Action items, decisions and key facts** as they happen
• A **live transcript** with speaker labels

After the meeting, ask anything: "What did I commit to?", "What was decided about pricing?", "Who owns the launch?" Answers cite timestamps from the transcript. A summary with action items and open questions is written automatically.

**Works with**
Google Meet, Zoom (web client), Microsoft Teams (web), and any other meeting that runs in a browser tab.

**Your AI, your key**
Connect OpenAI, Anthropic Claude, Google Gemini, OpenRouter, Groq, a local Ollama model, or any OpenAI-compatible endpoint. Transcription uses OpenAI, Groq, Deepgram or your own Whisper server. Want no transcription bill? Caption mode reads the meeting's built-in live captions instead.

**Private by design**
• There is no Smart Meet server and no account to create
• Transcripts are stored only in your browser
• Audio and text go directly to the provider you chose, under your own API key
• No analytics, no tracking, no ads

Please let meeting participants know you're using an AI note-taker, and follow local recording-consent laws.

## Single purpose
Helps the user follow online meetings by transcribing them and using the user's own AI provider to highlight questions and clarification points, and to answer questions about the meeting.

## Permission justifications

| Permission | Justification |
| --- | --- |
| tabCapture | Records the audio of the meeting tab, after the user presses Start, so it can be transcribed. |
| offscreen | Hosts the audio recorder (MediaRecorder and Web Audio), which Manifest V3 service workers cannot run. |
| activeTab | Grants access to the tab the user invokes the extension on, which tab capture requires. |
| scripting | Injects the caption reader into a meeting tab that was already open before the extension was installed. |
| sidePanel | Shows the extension's UI next to the meeting. |
| storage | Saves settings and the user's API keys locally. |
| unlimitedStorage | Long meetings produce large transcripts, which are stored locally in IndexedDB. |
| alarms | Runs the optional automatic deletion of old meetings. |
| Host: meet.google.com, *.zoom.us, teams.microsoft.com, teams.live.com, teams.cloud.microsoft | Reads the live captions these web clients display, for caption mode. |
| Host: api.openai.com, api.anthropic.com, generativelanguage.googleapis.com, openrouter.ai, api.groq.com, api.deepgram.com | Sends transcription and AI requests directly to the provider the user configured. |
| Optional host: https://*/*, http://localhost/*, http://127.0.0.1/* | Requested at runtime, and only for the specific origin, when the user enters a custom or local AI endpoint. |

Remote code: **No**. All code is packaged in the extension.

## Data usage disclosures

Data collected and handled (it stays on the device, or goes to the provider the user configured):
- **Website content**: meeting captions and transcripts
- **Personal communications**: meeting audio, processed by the user's chosen speech-to-text provider
- **Authentication information**: the user's own API keys, stored locally and sent only to their provider

Certifications:
- [x] Data is not sold to third parties
- [x] Data is not used or transferred for purposes unrelated to the item's single purpose
- [x] Data is not used or transferred to determine creditworthiness or for lending

## URLs

| Field | Value |
| --- | --- |
| Privacy policy | https://ammarkarimi.github.io/smart-meet/PRIVACY.html (GitHub Pages; see DEPLOYMENT.md step 1) |
| Homepage / website | https://github.com/Ammarkarimi/smart-meet |
| Support | https://github.com/Ammarkarimi/smart-meet/issues |

## Images

All images are in [`docs/store/`](store/). Upload screenshots in this order.

| File | Size | Used for |
| --- | --- | --- |
| `screenshot-1-live.png` | 1280×800 | Live questions and clarification points with suggested replies |
| `screenshot-2-transcript.png` | 1280×800 | Live transcript with speaker names |
| `screenshot-3-ask.png` | 1280×800 | Ask AI answering with a timestamp |
| `screenshot-4-summary.png` | 1280×800 | Meeting summary and action items in History |
| `screenshot-5-settings.png` | 1280×800 | Provider and capture settings |
| `promo-small-440x280.png` | 440×280 | Small promo tile (Chrome; optional on Edge) |
| `logo-300.png` | 300×300 | Edge extension logo (Chrome uses `assets/icons/icon128.png`) |

`logo-300.png` is regenerated by `npm run icons`. The screenshots are composed from real captures of the side panel and settings page. If the UI changes noticeably, retake them.

## Notes for reviewers (Edge "Notes for certification" / Chrome test instructions)

Smart Meet needs the tester's own API key from any supported provider (OpenAI, Gemini, Groq, OpenRouter, and others). The quickest free test is caption mode: open a Google Meet call, turn on captions (CC), click the Smart Meet toolbar icon and press Start. Live captions and flagged questions appear in the side panel. Audio mode also needs a speech-to-text key (OpenAI, Groq or Deepgram).
