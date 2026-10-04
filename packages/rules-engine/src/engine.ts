import type { NormalizedEmail } from "@emailbot/types";
import { evaluateCondition } from "./conditions.js";
import { createEvaluationContext, type EvaluationContext } from "./context.js";
import { runExtractor } from "./extractors.js";
import type { EngineRule, RuleEvaluationResult, SingleRuleEvaluation } from "./types.js";

/**
 * Evaluates a single rule, ignoring its `enabled` flag (used by the
 * "test rule" feature). A rule without conditions never matches: EmailBot
 * must not capture mail indiscriminately.
 */
export function evaluateRule(
  email: NormalizedEmail,
  rule: EngineRule,
  context: EvaluationContext = createEvaluationContext()
): SingleRuleEvaluation {
  if (rule.conditions.length === 0) {
    return { matched: false, conditionResults: [], regexTimedOut: context.guard.timedOut };
  }

  const conditionResults = rule.conditions.map((condition) => evaluateCondition(email, condition, context));

  const matched =
    rule.matchMode === "AND" ? conditionResults.every(Boolean) : conditionResults.some(Boolean);

  return { matched, conditionResults, regexTimedOut: context.guard.timedOut };
}

/** Lower priority value first, then oldest first, then id for determinism. */
export function sortRules(rules: readonly EngineRule[]): EngineRule[] {
  return [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const byDate = (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
    if (byDate !== 0) return byDate;
    return a.id.localeCompare(b.id);
  });
}

export function emptyResult(): RuleEvaluationResult {
  return {
    matched: false,
    matchedRules: [],
    primaryRuleId: null,
    categoryId: null,
    markImportant: false,
    markRead: false,
    archive: false,
    notifications: [],
    extracted: {},
    stoppedByRuleId: null,
    regexTimedOut: false
  };
}

/**
 * Evaluates all enabled rules against an email, in priority order, and
 * merges the resulting actions. Disabled rules are skipped. When a matching
 * rule has stopProcessing = true, no further rules are evaluated.
 */
export function evaluateRules(
  email: NormalizedEmail,
  rules: readonly EngineRule[],
  context: EvaluationContext = createEvaluationContext()
): RuleEvaluationResult {
  const result = emptyResult();

  for (const rule of sortRules(rules)) {
    if (!rule.enabled) continue;

    if (!evaluateRule(email, rule, context).matched) continue;

    result.matched = true;
    result.matchedRules.push({ id: rule.id, name: rule.name, priority: rule.priority });
    result.primaryRuleId ??= rule.id;

    if (result.categoryId === null && rule.categoryId !== null) {
      result.categoryId = rule.categoryId;
    }

    for (const action of rule.actions) {
      switch (action.type) {
        case "MARK_IMPORTANT":
          result.markImportant = true;
          break;
        case "MARK_READ":
          result.markRead = true;
          break;
        case "ARCHIVE":
          result.archive = true;
          break;
        case "NOTIFY":
          result.notifications.push({
            ruleId: rule.id,
            channel: action.channel,
            title: action.title ?? null
          });
          break;
        case "EXTRACT": {
          if (action.name in result.extracted) break;
          const value = runExtractor(email, action, context);
          if (value !== null) result.extracted[action.name] = value;
          break;
        }
      }
    }

    if (rule.stopProcessing) {
      result.stoppedByRuleId = rule.id;
      break;
    }
  }

  result.regexTimedOut = context.guard.timedOut;
  return result;
}
