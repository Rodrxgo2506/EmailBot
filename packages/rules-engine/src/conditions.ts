import type { NormalizedEmail } from "@emailbot/types";
import type { RuleCondition, RuleField } from "@emailbot/validation";
import { createEvaluationContext, foldCached, type EvaluationContext } from "./context.js";
import { htmlToText, MAX_EVALUATED_TEXT_LENGTH, MAX_REGEX_INPUT_LENGTH } from "./text.js";

/**
 * Returns every value a field exposes. Multi-valued fields (recipient,
 * attachment) are matched with "any" semantics for positive operators and
 * "none" semantics for negative operators (not_equals, not_contains).
 */
export function resolveFieldValues(
  email: NormalizedEmail,
  field: RuleField,
  context: EvaluationContext = createEvaluationContext()
): string[] {
  const cached = context.values.get(field);
  if (cached) return cached;
  const values = computeFieldValues(email, field);
  context.values.set(field, values);
  return values;
}

function computeFieldValues(email: NormalizedEmail, field: RuleField): string[] {
  switch (field) {
    case "sender":
      return nonEmpty([email.sender.address, email.sender.name]);
    case "recipient":
      return nonEmpty([...email.recipients, ...email.cc, ...email.bcc].map((recipient) => recipient.address));
    case "subject":
      return nonEmpty([email.subject]);
    case "body": {
      const body = email.textBody ?? (email.htmlBody ? htmlToText(email.htmlBody) : null);
      return nonEmpty([body?.slice(0, MAX_EVALUATED_TEXT_LENGTH) ?? null]);
    }
    case "date":
      return nonEmpty([email.receivedAt]);
    case "attachment":
      return nonEmpty(email.attachments.map((attachment) => attachment.filename));
  }
}

function nonEmpty(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

const regexCache = new Map<string, RegExp>();
const REGEX_CACHE_LIMIT = 500;

export function compileUserRegex(pattern: string, caseSensitive: boolean): RegExp | null {
  const flags = caseSensitive ? "u" : "iu";
  const key = `${flags}/${pattern}`;
  const cached = regexCache.get(key);
  if (cached) return cached;

  try {
    const regex = new RegExp(pattern, flags);
    if (regexCache.size >= REGEX_CACHE_LIMIT) regexCache.clear();
    regexCache.set(key, regex);
    return regex;
  } catch {
    return null;
  }
}

function compareText(
  operator: RuleCondition["operator"],
  actual: string,
  expected: string,
  caseSensitive: boolean,
  context: EvaluationContext
) {
  const a = caseSensitive ? actual.normalize("NFC") : foldCached(context, actual);
  const e = caseSensitive ? expected.normalize("NFC") : foldCached(context, expected);

  switch (operator) {
    case "equals":
    case "not_equals":
      return a === e;
    case "contains":
    case "not_contains":
      return a.includes(e);
    case "starts_with":
      return a.startsWith(e);
    case "ends_with":
      return a.endsWith(e);
    default:
      return false;
  }
}

function compareDate(operator: RuleCondition["operator"], actualIso: string, expected: string): boolean {
  const actual = Date.parse(actualIso);
  if (Number.isNaN(actual)) return false;

  // A date-only value ("2026-10-02") compares calendar days in UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(expected)) {
    const actualDay = new Date(actual).toISOString().slice(0, 10);
    switch (operator) {
      case "equals":
      case "not_equals":
        return actualDay === expected;
      case "before":
        return actualDay < expected;
      case "after":
        return actualDay > expected;
      default:
        return false;
    }
  }

  const expectedTime = Date.parse(expected);
  if (Number.isNaN(expectedTime)) return false;

  switch (operator) {
    case "equals":
    case "not_equals":
      return actual === expectedTime;
    case "before":
      return actual < expectedTime;
    case "after":
      return actual > expectedTime;
    default:
      return false;
  }
}

/** Evaluates one condition. Invalid/unsupported combinations never match. */
export function evaluateCondition(
  email: NormalizedEmail,
  condition: RuleCondition,
  context: EvaluationContext = createEvaluationContext()
): boolean {
  const values = resolveFieldValues(email, condition.field, context);
  const caseSensitive = condition.caseSensitive === true;

  switch (condition.operator) {
    case "exists":
      return values.length > 0;
    case "not_exists":
      return values.length === 0;
  }

  const expected = condition.value;
  if (expected === undefined || expected.length === 0) return false;

  if (condition.operator === "regex") {
    const regex = compileUserRegex(expected, caseSensitive);
    if (!regex) return false;
    // User regex: executed with a timeout and a per-evaluation budget.
    return values.some((value) => context.guard.test(regex, value.slice(0, MAX_REGEX_INPUT_LENGTH)));
  }

  const isNegative = condition.operator === "not_equals" || condition.operator === "not_contains";

  const matchesAny =
    condition.field === "date"
      ? values.some((value) =>
          condition.operator === "equals" ||
          condition.operator === "not_equals" ||
          condition.operator === "before" ||
          condition.operator === "after"
            ? compareDate(condition.operator, value, expected)
            : compareText(condition.operator, value, expected, caseSensitive, context)
        )
      : values.some((value) => compareText(condition.operator, value, expected, caseSensitive, context));

  return isNegative ? !matchesAny : matchesAny;
}
