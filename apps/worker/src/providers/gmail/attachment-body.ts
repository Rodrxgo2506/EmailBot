/*
 * F5.7: incremental decoding of a Gmail attachment body (users.messages.attachments.get: a MessagePartBody,
 * {"size": n, "data": "<base64url>", "attachmentId": "..."}, any key order).
 *
 * Before, a 25 MiB attachment lived several times at once: the JSON text (~33 MiB string), the parsed `data` string,
 * two more strings to turn base64url into base64, the decoded bytes and a copy of them. Here the content is decoded
 * straight from the bytes of the response, which boundedDownloadFetch already holds (F5.5: read with its limits,
 * handed back chunk by chunk): no JSON / `data` / base64 string of the whole content is ever built (only short-lived
 * slices of one chunk).
 *
 * Two passes over the chunks: the first validates the whole body and counts the decoded bytes; the second decodes
 * into one buffer of exactly that size, releasing each chunk once decoded. The rest of the body (the envelope, with
 * `data` emptied; bounded by the download size limit) is validated by JSON.parse: it must be an object.
 *
 * Accepted exactly as by the previous chain (response.json() + Buffer.from(.., "base64"); same bytes), because it
 * decoded them correctly: the base64url and the standard alphabets (mixed), with or without `=` padding, any number of
 * `=` after the last group, whitespace inside `data` (a raw space, or a JSON escape of tab, line feed, vertical tab,
 * form feed, carriage return or space: line-wrapped base64), the escapes `\/` and `\u00XX` of those characters, and up
 * to two UTF-8 byte order marks before the body (what undici's response.json() strips).
 *
 * Rejected with MalformedAttachmentError (the content stays pending, like a SyntaxError / ZodError before), although
 * the previous chain accepted them, because its bytes could not be trusted: any other character inside `data` (it
 * was skipped silently: the bytes were right only if that character was noise), a last group of a single character
 * (silently dropped), data after the padding (silently truncated at the first `=`), and a repeated top-level `data`
 * (JSON.parse kept the last one; duplicate names are ambiguous, RFC 8259 section 4). Still rejected, as before: a body
 * that is not JSON, not an object, or without a string `data`. Decoding is local work on bytes already received: it
 * cannot be cancelled, as before; the download itself keeps its limits and cancellation.
 */

export class MalformedAttachmentError extends Error {
  constructor(reason: string) {
    super(`Malformed attachment body: ${reason}`);
    this.name = "MalformedAttachmentError";
  }
}

const MAX_KEY_BYTES = 64; // longer raw keys cannot be "data", even with escapes
const MAX_BYTE_ORDER_MARKS = 2; // undici's response.json() accepts up to two before the JSON

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const EQUALS = 0x3d;
const SPACE = 0x20;
const BYTE_ORDER_MARK = [0xef, 0xbb, 0xbf];
/** Raw bytes allowed inside `data` besides `=`: both base64 alphabets and the space (other whitespace is not valid raw JSON). */
const NOT_RAW_BASE64 = /[^A-Za-z0-9+/_\- ]/;
const SPACES = / /g;
const BASE64 = new Uint8Array(256);
for (const character of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_") BASE64[character.charCodeAt(0)] = 1;
/** JSON escapes (the letter after the backslash) and the character each one stands for. */
const ESCAPES = new Map([
  [0x22, 0x22], // \"
  [0x5c, 0x5c], // \\
  [0x2f, 0x2f], // \/
  [0x62, 0x08], // \b
  [0x66, 0x0c], // \f
  [0x6e, 0x0a], // \n
  [0x72, 0x0d], // \r
  [0x74, 0x09] // \t
]);

/** JSON whitespace between tokens. */
function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

/** Whitespace ignored inside base64 (tab, line feed, vertical tab, form feed, carriage return, space). */
function isBase64Whitespace(code: number): boolean {
  return code === SPACE || (code >= 0x09 && code <= 0x0d);
}

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  return -1;
}

function countSpaces(text: string): number {
  let count = 0;
  for (let index = text.indexOf(" "); index >= 0; index = text.indexOf(" ", index + 1)) count++;
  return count;
}

const notBase64 = () => new MalformedAttachmentError("data is not base64");

/** The characters of `data`: the first pass validates and counts them, the second decodes them. */
interface Base64Text {
  /** Raw characters view[start, end) (no quote, no backslash). */
  chars(view: Buffer, start: number, end: number): void;
  /** One character written as a JSON escape. */
  char(code: number): void;
  /** End of `data`; returns the decoded size. */
  end(): number;
}

/**
 * First pass. `data` = base64 characters, then only `=`, with whitespace anywhere; the number of base64 characters
 * must not leave a single one in the last group (it cannot encode a byte).
 */
function counter(): Base64Text & { characters(): number } {
  let characters = 0;
  let padded = false;
  const padding = (view: Buffer, start: number, end: number) => {
    for (let offset = start; offset < end; offset++) {
      const byte = view[offset];
      if (byte === EQUALS) padded = true;
      else if (byte !== SPACE) throw notBase64();
    }
  };
  return {
    chars(view, start, end) {
      if (padded) return padding(view, start, end);
      const equals = view.indexOf(EQUALS, start);
      const last = equals < 0 || equals >= end ? end : equals;
      const text = view.toString("latin1", start, last);
      if (NOT_RAW_BASE64.test(text)) throw notBase64();
      characters += text.length - countSpaces(text);
      if (last < end) padding(view, last, end);
    },
    char(code) {
      if (isBase64Whitespace(code)) return;
      if (code === EQUALS) padded = true;
      else if (padded || code > 0xff || !BASE64[code]) throw notBase64();
      else characters++;
    },
    end() {
      const rest = characters % 4;
      if (rest === 1) throw notBase64();
      return Math.floor(characters / 4) * 3 + (rest === 0 ? 0 : rest - 1);
    },
    characters: () => characters
  };
}

/** Second pass: decodes the base64 characters counted by the first pass (whitespace and padding left out) into `out`, 4 at a time. */
function decoder(out: Buffer, characters: number): Base64Text {
  let fed = 0;
  let carry = "";
  let written = 0;
  const feed = (text: string) => {
    const usable = text.length - (text.length % 4);
    if (usable > 0) written += out.write(usable === text.length ? text : text.substring(0, usable), written, "base64");
    carry = usable === text.length ? "" : text.substring(usable);
  };
  return {
    chars(view, start, end) {
      if (fed >= characters) return; // only padding / whitespace left
      let text = view.toString("latin1", start, end);
      if (text.includes(" ")) text = text.replace(SPACES, "");
      const count = Math.min(text.length, characters - fed); // the padding comes after every base64 character
      if (count <= 0) return;
      fed += count;
      feed(carry + (count === text.length ? text : text.substring(0, count)));
    },
    char(code) {
      if (isBase64Whitespace(code) || fed >= characters) return;
      fed++;
      feed(carry + String.fromCharCode(code));
    },
    end() {
      if (carry) written += out.write(carry, written, "base64");
      carry = "";
      return written;
    }
  };
}

/** One pass over the body (see the header); returns the decoded size. */
function scan(chunks: Array<Uint8Array | undefined>, text: Base64Text, validate: boolean): number {
  const envelope: Uint8Array[] = [];
  let pending: number[] = []; // envelope bytes not yet moved into `envelope`
  const flush = () => {
    if (pending.length === 0) return;
    envelope.push(Uint8Array.from(pending));
    pending = [];
  };
  const keep = (byte: number) => {
    if (!validate) return;
    pending.push(byte);
    if (pending.length >= 4096) flush();
  };

  let leading = true; // still before the JSON: byte order marks are skipped
  let marks = 0; // byte order mark bytes skipped
  let started = false; // the first non-whitespace byte was seen (must be '{')
  let depth = 0;
  let expectKey = false; // depth 1: the next string is a key
  let inString = false;
  let stringEscape = false;
  let inKey = false;
  let key: number[] = [];
  let afterDataKey = false; // "data" key read: its value comes after ':'
  let inData = false;
  let seenData = false;
  let size = 0;
  let escape = 0; // inside `data`: 0 none, 1 after '\', 2..5 reading the \u hex digits
  let escaped = 0;

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index] as Uint8Array;
    if (!validate) chunks[index] = undefined; // released once decoded
    const view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    // next quote / backslash of this chunk at or after the current offset (-2 unknown, -1 none left): each search
    // starts where the previous one ended, so the scan stays linear however many escapes `data` has
    let nextQuote = -2;
    let nextBackslash = -2;
    for (let offset = 0; offset < view.length; offset++) {
      const byte = view[offset] as number;

      if (leading) {
        if (marks < MAX_BYTE_ORDER_MARKS * 3 && byte === BYTE_ORDER_MARK[marks % 3]) {
          marks++;
          continue;
        }
        if (marks % 3 !== 0) throw new MalformedAttachmentError("invalid JSON"); // an incomplete byte order mark
        leading = false;
      }

      if (inData) {
        if (escape === 0) {
          // plain base64 characters up to the next quote or backslash
          if (nextQuote !== -1 && nextQuote < offset) nextQuote = view.indexOf(QUOTE, offset);
          if (nextBackslash !== -1 && nextBackslash < offset) nextBackslash = view.indexOf(BACKSLASH, offset);
          let stop = view.length;
          if (nextQuote >= 0) stop = nextQuote;
          if (nextBackslash >= 0 && nextBackslash < stop) stop = nextBackslash;
          if (stop > offset) text.chars(view, offset, stop);
          offset = stop;
          if (stop === view.length) break;
          if (stop === nextQuote) {
            size = text.end();
            inData = false;
            seenData = true;
            keep(QUOTE);
            keep(QUOTE); // the envelope keeps an empty string in its place
          } else {
            escape = 1;
          }
        } else if (escape === 1) {
          if (byte === 0x75) {
            escape = 2; // "\u"
            escaped = 0;
          } else {
            const code = ESCAPES.get(byte);
            if (code === undefined) throw new MalformedAttachmentError("invalid JSON escape");
            text.char(code);
            escape = 0;
          }
        } else {
          const digit = hexValue(byte);
          if (digit < 0) throw new MalformedAttachmentError("invalid JSON escape");
          escaped = escaped * 16 + digit;
          if (++escape === 6) {
            text.char(escaped);
            escape = 0;
          }
        }
        continue;
      }

      if (inString) {
        keep(byte);
        if (stringEscape) stringEscape = false;
        else if (byte === BACKSLASH) stringEscape = true;
        else if (byte === QUOTE) {
          inString = false;
          if (inKey) {
            inKey = false;
            afterDataKey = isDataKey(key);
          }
          continue;
        }
        if (inKey && key.length <= MAX_KEY_BYTES) key.push(byte);
        continue;
      }

      if (isJsonWhitespace(byte)) {
        keep(byte);
        continue;
      }
      if (!started) {
        if (byte !== 0x7b) throw new MalformedAttachmentError("not a JSON object");
        started = true;
      }
      if (afterDataKey && byte !== 0x3a) {
        afterDataKey = false;
        if (byte !== QUOTE) throw new MalformedAttachmentError("data is not a string");
        if (seenData) throw new MalformedAttachmentError("repeated data");
        inData = true;
        continue;
      }
      keep(byte);
      if (byte === QUOTE) {
        inString = true;
        inKey = depth === 1 && expectKey;
        if (inKey) {
          expectKey = false;
          key = [];
        }
      } else if (byte === 0x7b || byte === 0x5b) {
        depth++;
        if (depth === 1) expectKey = true;
      } else if (byte === 0x7d || byte === 0x5d) {
        depth--;
      } else if (byte === 0x2c && depth === 1) {
        expectKey = true;
      }
    }
  }

  if (!validate) return size;
  if (inData || inString || (leading && marks % 3 !== 0)) throw new MalformedAttachmentError("truncated body");
  if (!seenData) throw new MalformedAttachmentError("no data");
  flush();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(envelope).toString("utf8"));
  } catch {
    throw new MalformedAttachmentError("invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new MalformedAttachmentError("not a JSON object");
  return size;
}

/** The raw bytes of a top-level key (between its quotes) name "data", also when written with JSON escapes. */
function isDataKey(raw: number[]): boolean {
  if (raw.length > MAX_KEY_BYTES) return false;
  const name = Buffer.from(raw).toString("utf8");
  if (name === "data") return true;
  if (!raw.includes(BACKSLASH)) return false;
  try {
    return JSON.parse(`"${name}"`) === "data";
  } catch {
    return false; // the envelope check rejects it
  }
}

/** Decodes `data` from the chunks of a Gmail attachment body (see the header); the chunks are released on the way. */
export function decodeGmailAttachmentChunks(chunks: Array<Uint8Array | undefined>): Uint8Array {
  const count = counter();
  const size = scan(chunks, count, true);
  const content = new Uint8Array(size);
  const written = scan(chunks, decoder(Buffer.from(content.buffer, content.byteOffset, content.byteLength), count.characters()), false);
  if (written !== size) throw new MalformedAttachmentError("inconsistent body"); // cannot happen: same bytes, same rules
  return content;
}

/** Reads a successful attachments.get response and decodes its content (see the header). */
export async function readGmailAttachment(response: Response): Promise<Uint8Array> {
  const chunks: Array<Uint8Array | undefined> = [];
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  }
  return decodeGmailAttachmentChunks(chunks);
}
