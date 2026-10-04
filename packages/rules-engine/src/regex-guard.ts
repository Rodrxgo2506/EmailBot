import vm from "node:vm";

/*
 * User-defined regular expressions run against untrusted email content.
 * JavaScript regexes backtrack, so a pattern such as (a|a)+$ can block the
 * event loop for minutes (measured: 9 s with only 27 characters). Static
 * validation alone cannot catch every catastrophic pattern.
 *
 * RegexGuard executes user regexes through node:vm with a timeout (V8
 * interrupts regex backtracking when the watchdog fires) and enforces a
 * total time budget per evaluation. When the budget is exhausted, remaining
 * user regexes are treated as "no match" instead of running.
 *
 * Built-in regexes (extract presets, HTML conversion) do not go through the
 * guard; they are written to run in linear time.
 */

export const DEFAULT_REGEX_TIMEOUT_MS = 50;
export const DEFAULT_REGEX_BUDGET_MS = 250;

const context = vm.createContext(Object.create(null));
const testScript = new vm.Script("__re.lastIndex = 0; __re.test(__input)");
const execScript = new vm.Script("__re.lastIndex = 0; __re.exec(__input)");

export interface RegexGuardOptions {
  /** Maximum time of a single regex execution. */
  timeoutMs?: number;
  /** Maximum cumulative regex time for one evaluation. */
  budgetMs?: number;
}

export class RegexGuard {
  readonly #timeoutMs: number;
  readonly #budgetMs: number;
  #spentMs = 0;
  /** True when at least one regex was interrupted or skipped. */
  timedOut = false;

  constructor(options: RegexGuardOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_REGEX_TIMEOUT_MS;
    this.#budgetMs = options.budgetMs ?? DEFAULT_REGEX_BUDGET_MS;
  }

  #run<T>(script: vm.Script, regex: RegExp, input: string, fallback: T): T {
    const remaining = this.#budgetMs - this.#spentMs;
    if (remaining <= 0) {
      this.timedOut = true;
      return fallback;
    }

    const started = performance.now();
    try {
      const sandbox = context as { __re?: RegExp | undefined; __input?: string | undefined };
      sandbox.__re = regex;
      sandbox.__input = input;
      return script.runInContext(context, { timeout: Math.max(1, Math.min(this.#timeoutMs, Math.ceil(remaining))) }) as T;
    } catch {
      // ERR_SCRIPT_EXECUTION_TIMEOUT (or any regex runtime error): treat as no match.
      this.timedOut = true;
      return fallback;
    } finally {
      this.#spentMs += performance.now() - started;
      const sandbox = context as { __re?: RegExp | undefined; __input?: string | undefined };
      sandbox.__re = undefined;
      sandbox.__input = undefined;
    }
  }

  test(regex: RegExp, input: string): boolean {
    return this.#run<boolean>(testScript, regex, input, false) === true;
  }

  exec(regex: RegExp, input: string): RegExpExecArray | null {
    return this.#run<RegExpExecArray | null>(execScript, regex, input, null);
  }
}
