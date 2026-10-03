// Minimal Server-Sent Events parser for fetch() response bodies.

/**
 * Feeds text chunks in, yields complete events out. Exposed separately from
 * readSSE so it can be unit-tested without streams.
 */
export class SSEParser {
  constructor() {
    this.buffer = '';
    this.event = '';
    this.data = [];
  }

  /** @returns {{event: string, data: string}[]} */
  push(chunk) {
    this.buffer += chunk;
    const out = [];
    let idx;
    while ((idx = this.buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.buffer.slice(0, idx);
      const nlLen = this.buffer.startsWith('\r\n', idx) ? 2 : 1;
      this.buffer = this.buffer.slice(idx + nlLen);
      const ev = this.#line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** Flush a trailing event that wasn't terminated by a blank line. */
  end() {
    const out = [];
    if (this.buffer) {
      const ev = this.#line(this.buffer);
      this.buffer = '';
      if (ev) out.push(ev);
    }
    const ev = this.#line('');
    if (ev) out.push(ev);
    return out;
  }

  #line(line) {
    if (line === '') {
      if (!this.data.length) { this.event = ''; return null; }
      const ev = { event: this.event || 'message', data: this.data.join('\n') };
      this.event = '';
      this.data = [];
      return ev;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    return null;
  }
}

/** Async-iterates SSE events from a fetch Response. */
export async function* readSSE(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) yield ev;
    }
    for (const ev of parser.push(decoder.decode())) yield ev;
    for (const ev of parser.end()) yield ev;
  } finally {
    reader.releaseLock();
  }
}
