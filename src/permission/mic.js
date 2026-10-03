// Extension pages in a tab can show the microphone prompt; the offscreen
// recorder can't. Granting here applies to the whole extension origin.

const status = document.getElementById('status');

async function request() {
  status.className = 'status';
  status.textContent = 'Waiting for your choice…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    status.className = 'status ok';
    status.textContent = '✓ Microphone allowed. You can close this tab. Restart the capture to include your voice.';
    setTimeout(() => window.close(), 2500);
  } catch (err) {
    status.className = 'status err';
    status.textContent = err.name === 'NotAllowedError'
      ? 'Microphone is blocked. Click the icon at the right of the address bar to allow it, then try again.'
      : `Microphone unavailable: ${err.message}`;
  }
}

document.getElementById('allow').addEventListener('click', request);
request();
