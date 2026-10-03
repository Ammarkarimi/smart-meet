// Tiny, XSS-safe Markdown renderer for model answers. All input is HTML-escaped
// first; only a fixed set of formatting constructs is turned back into tags.

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text) {
  const codes = [];
  let s = escapeHtml(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, '<span class="ts" data-ts="$1">$1</span>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let para = [];
  let inCode = false;
  let code = [];

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };

  const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));
  const isTableSep = (row) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(row || '');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!inCode && raw.includes('|') && isTableSep(lines[i + 1])) {
      flushPara(); closeList();
      const head = cells(raw).map((c) => `<th>${c}</th>`).join('');
      const body = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        body.push(`<tr>${cells(lines[i]).map((c) => `<td>${c}</td>`).join('')}</tr>`);
        i++;
      }
      i--;
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table>`);
      continue;
    }
    if (raw.trim().startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        flushPara(); closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { code.push(raw); continue; }

    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); closeList(); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara(); closeList();
      const level = Math.min(6, heading[1].length + 2); // keep headings small in the panel
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const type = ul ? 'ul' : 'ol';
      if (list !== type) { closeList(); out.push(`<${type}>`); list = type; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara(); closeList();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  if (inCode) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushPara();
  closeList();
  return out.join('');
}
