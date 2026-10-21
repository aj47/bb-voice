// Turns streamed markdown deltas into speakable sentences.
// Code fences are skipped entirely; inline markdown is stripped.

const MAX_CHUNK = 280;

export class SentenceChunker {
  private buffer = '';
  private inFence = false;

  // Feed a delta; returns sentences that are complete and ready to speak.
  push(delta: string): string[] {
    this.buffer += delta;
    return this.drain(false);
  }

  // Flush whatever is left at the end of a message.
  flush(): string[] {
    const out = this.drain(true);
    this.buffer = '';
    this.inFence = false;
    return out;
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      if (this.inFence) {
        const end = this.buffer.indexOf('```');
        if (end === -1) {
          if (final) this.buffer = '';
          return out;
        }
        this.buffer = this.buffer.slice(end + 3).replace(/^[^\n]*\n?/, '');
        this.inFence = false;
        continue;
      }

      const fence = this.buffer.indexOf('```');
      const scope = fence === -1 ? this.buffer : this.buffer.slice(0, fence);
      const cut = findSentenceEnd(scope, final || fence !== -1);
      if (cut > 0) {
        pushSpeakable(out, scope.slice(0, cut));
        this.buffer = this.buffer.slice(cut);
        continue;
      }
      if (fence !== -1) {
        pushSpeakable(out, scope);
        this.buffer = this.buffer.slice(fence + 3);
        this.inFence = true;
        continue;
      }
      return out;
    }
  }
}

function findSentenceEnd(text: string, takeAll: boolean): number {
  const newline = text.indexOf('\n');
  const match = /[.!?…:;](?=\s)/.exec(text);
  let end = -1;
  if (match) end = match.index + 1;
  if (newline !== -1 && (end === -1 || newline < end)) end = newline + 1;
  if (end === -1 && text.length > MAX_CHUNK) {
    const space = text.lastIndexOf(' ', MAX_CHUNK);
    end = space > 0 ? space + 1 : MAX_CHUNK;
  }
  if (end === -1 && takeAll) end = text.length;
  return end;
}

function pushSpeakable(out: string[], raw: string) {
  const text = toSpeakable(raw);
  if (/[a-z0-9]/i.test(text)) out.push(text);
}

export function toSpeakable(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
