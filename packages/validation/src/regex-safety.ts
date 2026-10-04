/**
 * User-defined regular expressions run inside the worker against untrusted
 * email content. JavaScript has no regex timeout, so we reduce the risk of
 * catastrophic backtracking (ReDoS) by:
 *
 *  1. limiting pattern length,
 *  2. rejecting nested quantifiers such as (a+)+ or (\w*)*,
 *  3. capping the size of the text the engine evaluates (see rules-engine).
 *
 * This static check is only a first filter: it cannot recognize every
 * catastrophic pattern. The real protection is the execution guard in
 * @emailbot/rules-engine (RegexGuard: per-regex timeout + per-email budget).
 */
export const MAX_USER_REGEX_LENGTH = 300;

const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/;

const QUANTIFIED_ALTERNATION = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/;

export function validateUserRegex(pattern: string): string | null {
  if (pattern.length === 0) {
    return "Regular expression cannot be empty";
  }

  if (pattern.length > MAX_USER_REGEX_LENGTH) {
    return `Regular expression cannot exceed ${MAX_USER_REGEX_LENGTH} characters`;
  }

  if (NESTED_QUANTIFIER.test(pattern)) {
    return "Nested quantifiers like (a+)+ are not allowed";
  }

  // (a|aa)+ or (\w|\d)* backtrack exponentially on non-matching input.
  if (QUANTIFIED_ALTERNATION.test(pattern)) {
    return "Repeated groups with alternatives like (a|b)+ are not allowed";
  }

  if (/\\[1-9]/.test(pattern)) {
    return "Backreferences are not allowed";
  }

  try {
    new RegExp(pattern, "iu");
  } catch {
    return "Invalid regular expression";
  }

  return null;
}
