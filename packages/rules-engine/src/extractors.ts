import type { NormalizedEmail } from "@emailbot/types";
import type { ExtractPreset, RuleAction } from "@emailbot/validation";
import { compileUserRegex } from "./conditions.js";
import { createEvaluationContext, type EvaluationContext } from "./context.js";
import { htmlToText, MAX_REGEX_INPUT_LENGTH } from "./text.js";

type ExtractAction = Extract<RuleAction, { type: "EXTRACT" }>;

const MAX_EXTRACTED_VALUE_LENGTH = 500;

/*
 * Generic extractors. They are deliberately provider/brand agnostic: a
 * verification code is located by common keywords in several languages,
 * never by sender.
 */
const CODE_KEYWORDS =
  "(?:c[oó]digo|code|otp|pin|passcode|token|clave|contrase[nñ]a|verification|verificaci[oó]n|security|seguridad)";

/** A candidate code: "123 456", "123-456" or 4-8 alphanumerics containing a digit. */
// The lookahead is bounded ({0,7}) so long alphanumeric runs stay linear.
const CODE_TOKEN = "\\b(\\d{3}[- ]\\d{3}|(?=[A-Z0-9]{0,7}\\d)[A-Z0-9]{4,8})\\b";

const CODE_AFTER_KEYWORD = new RegExp(`${CODE_KEYWORDS}[\\s\\S]{0,40}?${CODE_TOKEN}`, "iu");
const CODE_BEFORE_KEYWORD = new RegExp(`${CODE_TOKEN}[\\s\\S]{0,40}?${CODE_KEYWORDS}`, "iu");
const STANDALONE_CODE = /\b(\d{6}|\d{3}[- ]\d{3})\b/u;

const PRESETS: Record<ExtractPreset, (text: string) => string | null> = {
  verification_code(text) {
    const match =
      CODE_AFTER_KEYWORD.exec(text) ?? CODE_BEFORE_KEYWORD.exec(text) ?? STANDALONE_CODE.exec(text);
    return match?.[1]?.replace(/[- ]/g, "") ?? null;
  },
  url(text) {
    return /https?:\/\/[^\s<>"')\]]+/iu.exec(text)?.[0] ?? null;
  },
  amount(text) {
    return (
      /(?:[$€£]|S\/\.?|USD|EUR|PEN|MXN|COP)\s?\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?/iu.exec(text)?.[0] ?? null
    );
  },
  email(text) {
    // Bounded quantifiers keep this linear on long runs without "@".
    return /[A-Z0-9._%+-]{1,64}@[A-Z0-9-]{1,63}(?:\.[A-Z0-9-]{1,63}){0,8}\.[A-Z]{2,24}/iu.exec(text)?.[0] ?? null;
  }
};

function sourceText(email: NormalizedEmail, source: ExtractAction["source"]): string {
  const body = email.textBody ?? (email.htmlBody ? htmlToText(email.htmlBody) : "");
  const text =
    source === "subject" ? email.subject : source === "body" ? body : `${email.subject}\n${body}`;
  return text.slice(0, MAX_REGEX_INPUT_LENGTH);
}

export function runExtractor(
  email: NormalizedEmail,
  action: ExtractAction,
  context: EvaluationContext = createEvaluationContext()
): string | null {
  let text = context.sources.get(action.source);
  if (text === undefined) {
    text = sourceText(email, action.source);
    context.sources.set(action.source, text);
  }
  let value: string | null = null;

  if (action.preset) {
    value = PRESETS[action.preset](text);
  } else if (action.pattern) {
    const regex = compileUserRegex(action.pattern, false);
    if (regex) {
      const match = context.guard.exec(regex, text);
      value = match ? (match[1] ?? match[0]) : null;
    }
  }

  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, MAX_EXTRACTED_VALUE_LENGTH) : null;
}
