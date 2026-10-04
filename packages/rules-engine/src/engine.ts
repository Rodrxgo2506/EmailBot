import type { NormalizedEmail } from "@emailbot/types";
import { evaluateCondition } from "./conditions.js";
import { createEvaluationContext, type EvaluationContext } from "./context.js";
import { runExtractor } from "./extractors.js";
import type { BotSelection, EngineRule, RuleEvaluationResult, SingleRuleEvaluation } from "./types.js";

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
    botId: null,
    botSelection: "NONE",
    botCandidateIds: [],
    regexTimedOut: false
  };
}

const isEvaluable = (rule: EngineRule) => rule.enabled && rule.botActive !== false;

/**
 * Bot of the email: among matching rules that belong to a bot, the highest
 * priority (lowest value) wins only if every rule at that priority belongs to
 * the same bot. A tie between different bots is AMBIGUOUS: created_at / id are
 * deliberately NOT used to break it (rule creation order must never decide
 * which customer receives an email).
 */
function selectBot(matches: ReadonlyArray<{ priority: number; botId: string }>): {
  botId: string | null;
  botSelection: BotSelection;
  botCandidateIds: string[];
} {
  if (matches.length === 0) return { botId: null, botSelection: "NONE", botCandidateIds: [] };
  const top = Math.min(...matches.map((match) => match.priority));
  const bots = [...new Set(matches.filter((match) => match.priority === top).map((match) => match.botId))].sort();
  if (bots.length === 1) return { botId: bots[0] as string, botSelection: "SELECTED", botCandidateIds: [] };
  return { botId: null, botSelection: "AMBIGUOUS", botCandidateIds: bots };
}

/**
 * Evaluates all enabled rules against an email, in priority order, and
 * merges the resulting actions. Disabled rules and rules of PAUSED bots are
 * skipped. When a matching rule has stopProcessing = true, no further rules
 * apply their actions.
 *
 * Bot selection (see selectBot) only considers rules that belong to a bot.
 * When a rule stops processing, the remaining rules with the SAME priority
 * are still checked (conditions only, no actions) for other bots, so the
 * order in which tied rules were created cannot hide an ambiguity.
 */
export function evaluateRules(
  email: NormalizedEmail,
  rules: readonly EngineRule[],
  context: EvaluationContext = createEvaluationContext()
): RuleEvaluationResult {
  const result = emptyResult();
  const botMatches: Array<{ priority: number; botId: string }> = [];
  const sorted = sortRules(rules);
  let stoppedAt = -1;

  for (const [index, rule] of sorted.entries()) {
    if (!isEvaluable(rule)) continue;

    if (!evaluateRule(email, rule, context).matched) continue;

    if (rule.botId) botMatches.push({ priority: rule.priority, botId: rule.botId });

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
      stoppedAt = index;
      break;
    }
  }

  if (stoppedAt >= 0) {
    const stopper = sorted[stoppedAt] as EngineRule;
    for (const rule of sorted.slice(stoppedAt + 1)) {
      if (rule.priority !== stopper.priority) break;
      if (!isEvaluable(rule) || !rule.botId || rule.botId === stopper.botId) continue;
      if (evaluateRule(email, rule, context).matched) botMatches.push({ priority: rule.priority, botId: rule.botId });
    }
  }

  Object.assign(result, selectBot(botMatches));
  result.regexTimedOut = context.guard.timedOut;
  return result;
}
