import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * How imap-integration.test.ts runs apps/worker/scripts/imap-integration-dovecot.sh
 * (pure functions, unit-tested in imap-unit.test.ts; nothing here starts a process).
 *
 *   Linux / macOS   bash <script>
 *   Windows         wsl.exe -e env [IMAP_E2_WORK=<wsl path>] bash <wsl path of the script>
 *                   (Docker runs inside WSL; wsl.exe does not forward environment
 *                   variables, so IMAP_E2_WORK is passed explicitly)
 *
 * IMAP_E2_SCRIPT is optional: by default the script next to this package is used,
 * whatever the current directory (monorepo root or apps/worker). A relative value is
 * resolved against the current directory.
 */

/** apps/worker/scripts/imap-integration-dovecot.sh, located from this file (not from the cwd). */
export const DEFAULT_IMAP_E2_SCRIPT = fileURLToPath(new URL("../../scripts/imap-integration-dovecot.sh", import.meta.url));

export interface ScriptCommand {
  command: string;
  args: string[];
}

/**
 * Windows path -> WSL path ("C:\a b\x.sh" -> "/mnt/c/a b/x.sh"). A POSIX path is kept,
 * including one Git Bash rewrote ("C:/Program Files/Git/mnt/c/x" -> "/mnt/c/x"; MSYS
 * converts POSIX-looking values of environment variables unless MSYS_NO_PATHCONV=1).
 */
export function toWslPath(value: string): string {
  const slashed = value.replace(/\\/g, "/");
  const mangled = /^[A-Za-z]:\/(?:.*\/)?(mnt\/[A-Za-z]\/.*)$/.exec(slashed);
  if (mangled) return `/${mangled[1]}`;
  const drive = /^([A-Za-z]):\/(.*)$/.exec(slashed);
  if (drive) return `/mnt/${(drive[1] as string).toLowerCase()}/${drive[2]}`;
  return slashed;
}

export function integrationScriptCommand(
  env: { IMAP_E2_SCRIPT?: string; IMAP_E2_WORK?: string },
  options: { platform: NodeJS.Platform; cwd: string; defaultScript?: string }
): ScriptCommand {
  const configured = env.IMAP_E2_SCRIPT?.trim() ?? "";
  const work = env.IMAP_E2_WORK?.trim() ?? "";
  if (options.platform === "win32") {
    const resolved =
      configured === "" ? (options.defaultScript ?? DEFAULT_IMAP_E2_SCRIPT) : configured.startsWith("/") ? configured : path.win32.resolve(options.cwd, configured);
    return { command: "wsl.exe", args: ["-e", "env", ...(work ? [`IMAP_E2_WORK=${toWslPath(work)}`] : []), "bash", toWslPath(resolved)] };
  }
  const resolved = configured === "" ? (options.defaultScript ?? DEFAULT_IMAP_E2_SCRIPT) : path.posix.resolve(options.cwd, configured);
  return { command: "bash", args: [resolved] };
}
