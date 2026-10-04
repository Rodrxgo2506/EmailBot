/** Maximum characters of a body the engine looks at. */
export const MAX_EVALUATED_TEXT_LENGTH = 100_000;

/** Regexes run on a smaller window to limit worst-case backtracking cost. */
export const MAX_REGEX_INPUT_LENGTH = 64_000;

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'"
};

/*
 * Every regex below runs on attacker-controlled email HTML, so all of them
 * must be linear-time. Quantifiers are bounded or stop at the next "<", and
 * paired blocks are removed with indexOf instead of a lazy backreference.
 */
const BLOCK_OPEN = /<(script|style|head)\b[^<>]{0,2000}>/gi;

/** Removes <script>/<style>/<head> blocks in a single linear pass. */
function stripBlocks(html: string): string {
  const lower = html.toLowerCase();
  let output = "";
  let cursor = 0;
  BLOCK_OPEN.lastIndex = 0;

  for (let match = BLOCK_OPEN.exec(html); match; match = BLOCK_OPEN.exec(html)) {
    output += `${html.slice(cursor, match.index)} `;
    const close = lower.indexOf(`</${(match[1] as string).toLowerCase()}`, BLOCK_OPEN.lastIndex);
    if (close === -1) {
      cursor = html.length;
      break;
    }
    const end = lower.indexOf(">", close);
    cursor = end === -1 ? html.length : end + 1;
    BLOCK_OPEN.lastIndex = cursor;
  }

  return output + html.slice(cursor);
}

/** Lightweight HTML -> text conversion for rule evaluation (not for display). */
export function htmlToText(html: string): string {
  return stripBlocks(html.slice(0, MAX_EVALUATED_TEXT_LENGTH * 2))
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s{0,20}\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^<>]*>/g, " ")
    .replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z0-9]{1,32});/gi, (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower in NAMED_ENTITIES) return NAMED_ENTITIES[lower] as string;
      if (lower.startsWith("#x")) return safeFromCodePoint(Number.parseInt(lower.slice(2), 16), match);
      if (lower.startsWith("#")) return safeFromCodePoint(Number.parseInt(lower.slice(1), 10), match);
      return match;
    })
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ ?\n[ \n]*/g, "\n")
    .trim();
}

function safeFromCodePoint(codePoint: number, fallback: string): string {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

/** Case- and accent-insensitive comparison key: "Código" -> "codigo". */
export function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}
