// Classic script (content scripts can't be ES modules). Exposes helpers on
// globalThis.SmartMeetCaptionDiff; also importable from Node tests.

(function init(root) {
  function norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Live captions grow and get revised in place, and older text scrolls off
   * the front. Given what we already emitted for a caption block and its
   * current text, returns only the new tail.
   */
  function newTextSince(emitted, current) {
    const prev = norm(emitted);
    const cur = norm(current);
    if (!cur) return '';
    if (!prev) return cur;
    if (cur === prev) return '';
    const lp = prev.toLowerCase();
    const lc = cur.toLowerCase();
    if (lc.startsWith(lp)) {
      const rest = cur.slice(prev.length);
      // "Friday" -> "Fridays": the recognizer finished a word we already sent; drop the fragment.
      const midWord = /[\p{L}\p{N}]$/u.test(prev) && /^[\p{L}\p{N}]/u.test(rest);
      return (midWord ? rest.replace(/^\S*/, '') : rest).trim();
    }
    if (lp.includes(lc)) return '';

    // Older text was trimmed from the front: find where the end of `prev` sits in `cur`.
    for (let len = Math.min(80, lp.length); len >= 12; len -= 4) {
      const tail = lp.slice(-len);
      const at = lc.lastIndexOf(tail);
      if (at !== -1) return cur.slice(at + len).trim();
    }

    // Recognizers revise the last few words in place: treat a mostly-matching prefix as the same text.
    let common = 0;
    while (common < lp.length && common < lc.length && lp[common] === lc[common]) common++;
    if (common >= lp.length * 0.6) {
      if (cur.length <= prev.length) return '';
      const rest = cur.slice(prev.length);
      return (/^\s/.test(rest) ? rest : rest.replace(/^\S*/, '')).trim();
    }
    return cur;
  }

  root.SmartMeetCaptionDiff = { norm, newTextSince };
}(globalThis));
