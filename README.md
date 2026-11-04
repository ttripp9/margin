# Margin

Meeting notes split by job, with live suggested answers. Runs entirely on your phone: open the link, add your keys, put the phone next to your laptop.

**Live app:** https://ttripp9.github.io/margin/

## Setup (2 minutes)

1. Open the link in **Safari** on your iPhone.
2. Tap the settings button (bottom left) and paste your **Claude API key** from console.anthropic.com.
3. Pick transcription:
   - **iPhone speech**: free, no key. Fine for a first try.
   - **Deepgram**: paste a key from console.deepgram.com. More accurate and faster, which matters for live answers.
4. Optional: Share → Add to Home Screen.
5. Open **My job** → settings (sliders icon) and fill in "What the AI should know." Live answers lean on it.

## Using it

- Laptop speakers on, not headphones. Phone face up, a foot or two from the laptop.
- Keep Margin on screen while recording. It holds the screen awake; iOS stops the mic if the phone locks.
- Flip **Live answers** on to get suggested replies a few seconds after someone asks a question. **Answer now** forces one on the latest topic.
- **Enhance notes** after the call merges your rough notes with the transcript. Your lines stay dark; lines Claude added are lighter with a blue bullet.

## Where data goes

- Meetings, notes and API keys live in this browser's storage on your phone. There is no Margin server.
- Audio goes to Apple (iPhone speech) or Deepgram for transcription. Transcript text goes to Anthropic for notes and answers.
- Clearing Safari's website data deletes your meetings. Use **Export backup** in Settings.
- Every GitHub Pages site under `ttripp9.github.io` shares one browser origin, so another Pages site on this account could read these keys. Fine for testing; a product version would proxy keys through a backend.

## Files

Plain HTML, CSS and JS, no build step: `index.html`, `styles.css`, `app.js`, `sw.js`, `manifest.webmanifest`.
