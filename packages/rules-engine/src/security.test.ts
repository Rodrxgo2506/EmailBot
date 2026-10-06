import vm from "node:vm";
import type { NormalizedEmail } from "@emailbot/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvaluationContext } from "./context.js";
import { evaluateRule, evaluateRules } from "./engine.js";
import { DEFAULT_REGEX_BUDGET_MS, DEFAULT_REGEX_TIMEOUT_MS, RegexGuard } from "./regex-guard.js";
import { htmlToText } from "./text.js";
import type { EngineRule } from "./types.js";

/*
 * Denial-of-service regression tests. Rules are user-controlled and email
 * content is attacker-controlled; neither may block the API/worker.
 */

function email(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    provider: "GMAIL",
    providerMessageId: "m",
    threadId: null,
    internetMessageId: null,
    accountId: "a",
    direction: "INBOUND",
    sender: { address: "x@example.com", name: null },
    recipients: [],
    cc: [],
    bcc: [],
    subject: "subject",
    snippet: null,
    textBody: "body",
    htmlBody: null,
    receivedAt: "2026-10-02T00:00:00.000Z",
    sentAt: null,
    attachments: [],
    headers: {},
    ...overrides
  };
}

function rule(overrides: Partial<EngineRule>): EngineRule {
  return {
    id: "r",
    name: "r",
    enabled: true,
    priority: 1,
    stopProcessing: false,
    matchMode: "AND",
    categoryId: null,
    conditions: [{ field: "subject", operator: "exists" }],
    actions: [],
    ...overrides
  };
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

const CATASTROPHIC = "(a|a)+$";

describe("RegexGuard", () => {
  it("interrupts catastrophic backtracking (unguarded this takes minutes)", () => {
    const guard = new RegexGuard({ timeoutMs: 50, budgetMs: 200 });
    const { value, ms } = timed(() => guard.test(new RegExp(CATASTROPHIC, "u"), `${"a".repeat(60_000)}!`));
    expect(value).toBe(false);
    expect(guard.timedOut).toBe(true);
    expect(ms).toBeLessThan(1_000);
  });

  it("enforces a total budget across many evaluations", () => {
    const guard = new RegexGuard({ timeoutMs: 50, budgetMs: 120 });
    const regex = new RegExp(CATASTROPHIC, "u");
    const { ms } = timed(() => {
      for (let i = 0; i < 20; i++) guard.test(regex, `${"a".repeat(40)}!`);
    });
    expect(ms).toBeLessThan(1_000);
  });

});

/*
 * The guard's limits are wall-clock: the vm watchdog (per execution) and
 * performance.now() (budget). On a loaded machine (the whole monorepo testing
 * in parallel) the process can be descheduled for more than 50 ms in the middle
 * of a trivial regex, so a test relying on real time could see a "timeout" that
 * has nothing to do with the regex. These tests control both clocks: the
 * production guard and its default limits run unchanged, but how much time
 * passes, and whether the watchdog fires, is decided by the test, not by the
 * machine's load.
 */
describe("RegexGuard with controlled clocks (deterministic)", () => {
  const runInContext = vm.Script.prototype.runInContext;

  /**
   * Every guarded regex still runs for real in the guard's sandbox; the test
   * records the per-execution limit the guard requested and decides how much
   * time each execution takes and whether the watchdog fires.
   */
  function controlClocks(options: { timesOut?: (call: number) => boolean; elapsedMs?: (call: number) => number } = {}) {
    let now = 1_000;
    const requested: Array<number | undefined> = [];
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(vm.Script.prototype, "runInContext").mockImplementation(function (this: vm.Script, context, runOptions) {
      const call = requested.length;
      requested.push(runOptions?.timeout);
      now += options.elapsedMs?.(call) ?? 0;
      if (options.timesOut?.(call)) {
        throw Object.assign(new Error(`Script execution timed out after ${runOptions?.timeout}ms`), { code: "ERR_SCRIPT_EXECUTION_TIMEOUT" });
      }
      return runInContext.call(this, context, { ...runOptions, timeout: undefined });
    });
    return { requested };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("A. still returns correct results for normal patterns, requesting the production limit", () => {
    const { requested } = controlClocks();
    const guard = new RegexGuard();
    expect(guard.test(/\b\d{6}\b/u, "code 482913")).toBe(true);
    expect(guard.exec(/code (\d+)/u, "code 77")?.[1]).toBe("77");
    expect(guard.test(/\b\d{6}\b/u, "code 12")).toBe(false);
    expect(guard.exec(/code (\d+)/u, "nothing")).toBeNull();
    expect(guard.timedOut).toBe(false);
    // Every execution asked the vm for the production per-regex limit.
    expect(requested).toEqual([DEFAULT_REGEX_TIMEOUT_MS, DEFAULT_REGEX_TIMEOUT_MS, DEFAULT_REGEX_TIMEOUT_MS, DEFAULT_REGEX_TIMEOUT_MS]);
  });

  it("B. a regex interrupted by the per-execution limit is a non-match and is reported", () => {
    controlClocks({ timesOut: (call) => call === 0, elapsedMs: (call) => (call === 0 ? DEFAULT_REGEX_TIMEOUT_MS : 0) });
    const guard = new RegexGuard();
    expect(guard.test(/(a|a)+$/u, "aaaa!")).toBe(false);
    expect(guard.timedOut).toBe(true);
    // The next (normal) regex still runs while budget remains.
    expect(guard.exec(/code (\d+)/u, "code 77")?.[1]).toBe("77");
  });

  it("B. once the evaluation budget is spent, the remaining regexes are not executed at all", () => {
    const { requested } = controlClocks({ elapsedMs: () => DEFAULT_REGEX_BUDGET_MS });
    const guard = new RegexGuard();
    expect(guard.test(/\b\d{6}\b/u, "code 482913")).toBe(true); // runs, and spends the whole budget
    expect(guard.test(/\b\d{6}\b/u, "code 482913")).toBe(false); // skipped
    expect(guard.exec(/code (\d+)/u, "code 77")).toBeNull(); // skipped
    expect(guard.timedOut).toBe(true);
    expect(requested).toHaveLength(1);
  });

  it("B. the per-execution limit never exceeds the remaining budget", () => {
    const { requested } = controlClocks({ elapsedMs: (call) => (call === 0 ? DEFAULT_REGEX_BUDGET_MS - 10 : 0) });
    const guard = new RegexGuard();
    guard.test(/a/u, "a");
    guard.test(/a/u, "a");
    expect(requested).toEqual([DEFAULT_REGEX_TIMEOUT_MS, 10]);
  });
});

describe("engine under malicious rules", () => {
  it("a catastrophic condition regex cannot block evaluation and reports the timeout", () => {
    const malicious = rule({ conditions: [{ field: "body", operator: "regex", value: CATASTROPHIC }] });
    // 40 characters are enough: unguarded, this pattern needs years on this input.
    const { value, ms } = timed(() => evaluateRules(email({ textBody: `${"a".repeat(40)}!` }), [malicious]));
    expect(value.matched).toBe(false);
    expect(value.regexTimedOut).toBe(true);
    expect(ms).toBeLessThan(2_000);
  });

  it("many malicious rules share one budget per email", () => {
    const rules = Array.from({ length: 50 }, (_, index) =>
      rule({
        id: `r${index}`,
        conditions: [{ field: "body", operator: "regex", value: CATASTROPHIC }],
        actions: [{ type: "EXTRACT", name: `x${index}`, pattern: CATASTROPHIC, source: "any" }]
      })
    );
    const { ms } = timed(() => evaluateRules(email({ textBody: `${"a".repeat(30)}!` }), rules));
    expect(ms).toBeLessThan(2_000);
  });

  it("evaluateRule exposes the timeout flag for the test endpoint", () => {
    const context = createEvaluationContext({ budgetMs: 100 });
    const result = evaluateRule(
      email({ textBody: `${"a".repeat(30)}!` }),
      rule({ conditions: [{ field: "body", operator: "regex", value: CATASTROPHIC }] }),
      context
    );
    expect(result.regexTimedOut).toBe(true);
  });
});

describe("built-in processing stays linear on adversarial email content", () => {
  const LIMIT_MS = 1_500;

  it.each([
    ["unclosed <script> tags", "<script>".repeat(25_000)],
    ["unterminated tags", "<".repeat(200_000)],
    ["carriage returns", "\r".repeat(200_000)],
    ["whitespace runs", `${" \t".repeat(100_000)}x`],
    ["unterminated block open tag", `<script ${"a".repeat(200_000)}`],
    ["entities without terminator", `&${"a".repeat(200_000)}`]
  ])("htmlToText: %s", (_label, html) => {
    expect(timed(() => htmlToText(html)).ms).toBeLessThan(LIMIT_MS);
  });

  it.each([
    ["verification_code", "a".repeat(100_000)],
    ["email", "a".repeat(100_000)],
    ["email", `${"a.".repeat(50_000)}@`],
    ["amount", `$${"1,".repeat(50_000)}`],
    ["url", "http".repeat(25_000)]
  ] as const)("extract preset %s on adversarial input", (preset, body) => {
    const extractor = rule({ actions: [{ type: "EXTRACT", name: "v", preset, source: "any" }] });
    expect(timed(() => evaluateRules(email({ textBody: body }), [extractor])).ms).toBeLessThan(LIMIT_MS);
  });

  it("html-only bodies are converted once per email, not once per condition", () => {
    const conditions = Array.from({ length: 25 }, () => ({ field: "body" as const, operator: "contains" as const, value: "zzz" }));
    const rules = Array.from({ length: 40 }, (_, index) => rule({ id: `r${index}`, matchMode: "OR", conditions }));
    const big = email({ textBody: null, htmlBody: `<p>${"palabra ".repeat(25_000)}</p>` });
    expect(timed(() => evaluateRules(big, rules)).ms).toBeLessThan(LIMIT_MS);
  });

  it("keeps html conversion semantics", () => {
    expect(htmlToText("<style>x{}</style><p>Hola</p>\r\n<p>código <b>123</b></p><script>alert(1)</script>fin")).toBe(
      "Hola\ncódigo 123\nfin"
    );
  });
});
