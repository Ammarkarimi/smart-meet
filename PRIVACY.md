# Smart Meet Privacy Policy

_Last updated: October 3, 2026_

Smart Meet is a browser extension that helps you follow online meetings. It transcribes the meeting, flags questions and points to clarify, and answers questions about the conversation. It runs on **your own API keys**, and there is **no Smart Meet server**.

## What the extension handles

- **Meeting audio.** This is captured only while you are actively capturing a meeting. It comes from the meeting tab and, if you allow it, your microphone. The audio is split into short chunks and sent to the speech-to-text provider you selected. Audio is never written to disk.
- **Live captions.** In caption mode, the extension reads the caption text the meeting website shows on screen.
- **Transcripts, flagged items, summaries and chat history.** These are stored locally in your browser (IndexedDB) on this device.
- **Settings and API keys.** These are stored locally in the extension's storage (`chrome.storage.local`). They are never synced to your Google account and never sent anywhere except to the provider each key belongs to.
- **Profile text.** Your name and role are optional. They are included in prompts so the AI can recognise questions aimed at you.

## Where data is sent

Data leaves your browser only to reach the AI providers **you** configure. Requests go directly from your browser, authenticated with your API key:

| Purpose | Destination (depending on your choice) |
| --- | --- |
| Speech-to-text | OpenAI, Groq, Deepgram, or a server URL you enter |
| Insights, answers, summaries | OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Ollama (local), or a server URL you enter |

Each provider handles that data under its own terms and privacy policy. Review them before you use the extension, especially for confidential meetings.

The developer of Smart Meet does not receive, collect, sell or share any of your data. The extension contains no analytics, tracking or advertising code.

## Retention and deletion

- Meetings stay on your device until you delete them. You can also set automatic deletion after 7, 30, 90 or 365 days.
- You can delete one meeting from **History**, or everything at once under **Settings → Privacy & data → Delete all meetings**.
- Uninstalling the extension removes all of its stored data.

## Permissions and why they are needed

| Permission | Why |
| --- | --- |
| `tabCapture`, `offscreen` | Record the meeting tab's audio for transcription, only after you press Start |
| `activeTab`, `scripting` | Access the meeting tab you start capturing on, and read its captions |
| `sidePanel` | Show the Smart Meet panel next to your meeting |
| `storage`, `unlimitedStorage` | Save settings and long meeting transcripts locally |
| `alarms` | Run your automatic-deletion schedule |
| Host access to meeting sites | Read live captions on Google Meet, Zoom and Microsoft Teams web clients |
| Host access to AI provider APIs | Send transcription and AI requests directly to the provider you chose |
| Optional host access | Granted only if you enter a custom or local AI endpoint |

## Consent

Recording or transcribing a conversation can require consent from everyone in it. You are responsible for telling participants and for following the laws and policies that apply to you. Smart Meet asks you to confirm this before your first capture.

## Children

Smart Meet is not directed at children under 13 and does not knowingly process their data.

## Changes

If this policy changes, the updated version will ship with the extension and the date above will change.

## Contact

Questions about privacy: open an issue at https://github.com/Ammarkarimi/smart-meet/issues, or email the publisher at the address listed on the Chrome Web Store or Edge Add-ons page.
