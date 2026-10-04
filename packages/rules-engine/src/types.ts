import type { RuleMatchMode } from "@emailbot/types";
import type { RuleAction, RuleCondition } from "@emailbot/validation";

/** A validated rule ready to be evaluated. */
export interface EngineRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Lower number = evaluated first. */
  priority: number;
  stopProcessing: boolean;
  matchMode: RuleMatchMode;
  categoryId: string | null;
  /** Bot the rule belongs to (EmailBot V2); null/undefined = general rule. */
  botId?: string | null | undefined;
  /** false = the rule's bot is PAUSED: the rule is not evaluated at all. Default true. */
  botActive?: boolean | undefined;
  conditions: RuleCondition[];
  actions: RuleAction[];
  /** Tie-breaker for rules with the same priority (older first). Never decides the bot. */
  createdAt?: string | undefined;
}

/**
 * How the bot of an email was decided:
 *  - NONE: no matching rule belongs to a bot;
 *  - SELECTED: the matching bot rules with the highest priority all belong to one bot;
 *  - AMBIGUOUS: different bots tie at that priority. No bot is chosen
 *    (creation order must never route an email to a customer).
 */
export type BotSelection = "NONE" | "SELECTED" | "AMBIGUOUS";

export interface MatchedRuleSummary {
  id: string;
  name: string;
  priority: number;
}

export interface NotificationRequest {
  ruleId: string;
  channel: "in_app" | "email";
  title: string | null;
}

export interface RuleEvaluationResult {
  matched: boolean;
  matchedRules: MatchedRuleSummary[];
  /** Highest-priority matching rule; stored as emails.matched_rule_id. */
  primaryRuleId: string | null;
  /** Category of the highest-priority matching rule that defines one. */
  categoryId: string | null;
  markImportant: boolean;
  markRead: boolean;
  archive: boolean;
  notifications: NotificationRequest[];
  /** First value found for each extractor name (highest priority wins). */
  extracted: Record<string, string>;
  /** Rule whose stop_processing flag halted evaluation, if any. */
  stoppedByRuleId: string | null;
  /** Selected bot (stored as emails.bot_id); null when NONE or AMBIGUOUS. */
  botId: string | null;
  botSelection: BotSelection;
  /** AMBIGUOUS only: the tied bots, sorted (diagnostics). */
  botCandidateIds: string[];
  /** A user regex hit its timeout or the evaluation budget (treated as no match). */
  regexTimedOut: boolean;
}

export interface SingleRuleEvaluation {
  matched: boolean;
  /** Result of each condition, in order (useful to explain a test run). */
  conditionResults: boolean[];
  /** A user regex hit its timeout or the evaluation budget (treated as no match). */
  regexTimedOut: boolean;
}
