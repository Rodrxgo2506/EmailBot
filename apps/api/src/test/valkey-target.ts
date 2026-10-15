import { parseURL } from "ioredis/built/utils/index.js";

/*
 * Guard of the opt-in Valkey suites (imap-valkey-integration.test.ts and its
 * helper process imap-valkey-process.ts). Those tests write keys, run KEYS / DEL
 * and CLIENT PAUSE, so IMAP_VALKEY_URL may only ever name a throwaway server on
 * THIS machine, over TCP:
 *
 *   redis://[user:password@]<127.0.0.1 | localhost | [::1]>[:port][/db]
 *   rediss://… (same shape)
 *
 * Why so strict (ioredis 5.11.1, built/utils parseURL):
 *   - a scheme other than redis: / rediss: is re-parsed as "redis://" + url, so
 *     "x://localhost:1" connects to host "x" through the IPC / pipe path "//localhost:1";
 *   - query parameters become connection options: "redis://localhost?path=//host/pipe"
 *     connects to that pipe (a network share path on Windows), whatever the host;
 *   - redis: is a non-special URL scheme: hosts are not normalized
 *     ("2130706433", "%6c%6fcalhost", "0x7f.1" stay as written), so only these exact
 *     spellings are accepted.
 * The input is checked against a strict shape, then parsed with ioredis's OWN parser:
 * the effective connection options must be a loopback TCP host and nothing else
 * (no path, no query-derived option). Anything that cannot be shown to stay on
 * loopback is rejected. The value is returned unchanged (never normalized after the
 * check). Errors never contain the URL nor its credentials.
 */

export const ALLOWED_VALKEY_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;

const SHAPE = /^rediss?:\/\/(?:[A-Za-z0-9._~!$&'()*+,;=:%-]*@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?(?:\/\d{1,2})?$/;
const ALLOWED_OPTIONS = new Set(["host", "port", "username", "password", "db"]);

export class UnsafeValkeyTargetError extends Error {
  constructor(reason: string) {
    super(`IMAP_VALKEY_URL rejected (${reason}): only redis:// or rediss:// over TCP to 127.0.0.1, localhost or [::1] is allowed (see docs/imap.md)`);
    this.name = "UnsafeValkeyTargetError";
  }
}

/** Returns `raw` unchanged when it can only reach a loopback Valkey over TCP; throws (without echoing it) otherwise. */
export function assertLocalValkeyUrl(raw: string | undefined): string {
  if (typeof raw !== "string" || raw.length === 0) throw new UnsafeValkeyTargetError("empty");
  if (raw.length > 512) throw new UnsafeValkeyTargetError("too long");
  if (/[\s\\\u0000-\u001f\u007f]/.test(raw)) throw new UnsafeValkeyTargetError("whitespace, control characters or backslashes");
  if (!/^rediss?:\/\//.test(raw)) throw new UnsafeValkeyTargetError("scheme not allowed");
  if (!SHAPE.test(raw)) throw new UnsafeValkeyTargetError("not a plain loopback TCP address: no query, fragment, socket path or other host");

  // ioredis 5.11.1 parses redis: / rediss: URLs with WHATWG URL: check that view...
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeValkeyTargetError("malformed");
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new UnsafeValkeyTargetError("scheme not allowed");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new UnsafeValkeyTargetError("host not loopback");
  if (url.search !== "" || url.hash !== "") throw new UnsafeValkeyTargetError("query or fragment");
  if (!/^(?:\/\d{0,2})?$/.test(url.pathname)) throw new UnsafeValkeyTargetError("path");

  // ...and the effective connection options from ioredis's own parser.
  let options: Record<string, unknown>;
  try {
    options = parseURL(raw);
  } catch {
    throw new UnsafeValkeyTargetError("malformed");
  }
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.has(key)) throw new UnsafeValkeyTargetError(key === "path" ? "socket / pipe path" : "unexpected connection option");
  }
  if (!(ALLOWED_VALKEY_HOSTS as readonly string[]).includes(String(options.host))) throw new UnsafeValkeyTargetError("host not loopback");
  if (options.port !== undefined && !(Number(options.port) >= 1 && Number(options.port) <= 65535)) throw new UnsafeValkeyTargetError("port");
  return raw;
}
