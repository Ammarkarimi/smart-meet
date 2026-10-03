import { renderMarkdown } from '../lib/markdown.js';

const el = document.getElementById('content');
fetch(chrome.runtime.getURL('PRIVACY.md'))
  .then((r) => r.text())
  .then((md) => { el.innerHTML = renderMarkdown(md); })
  .catch(() => { el.textContent = 'The privacy policy could not be loaded.'; });
