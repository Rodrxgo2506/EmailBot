import { RegexGuard, type RegexGuardOptions } from "./regex-guard.js";
import { foldText } from "./text.js";

/**
 * Per-evaluation state: the regex time budget and caches so that large
 * bodies are converted/folded once per email instead of once per condition.
 */
export interface EvaluationContext {
  guard: RegexGuard;
  values: Map<string, string[]>;
  sources: Map<string, string>;
  folded: Map<string, string>;
}

export function createEvaluationContext(options: RegexGuardOptions = {}): EvaluationContext {
  return { guard: new RegexGuard(options), values: new Map(), sources: new Map(), folded: new Map() };
}

export function foldCached(context: EvaluationContext, value: string): string {
  let folded = context.folded.get(value);
  if (folded === undefined) {
    folded = foldText(value);
    context.folded.set(value, folded);
  }
  return folded;
}
