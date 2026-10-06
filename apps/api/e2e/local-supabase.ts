import { execFileSync } from "node:child_process";

/**
 * Connection data of the LOCAL Supabase stack for the end-to-end checks:
 * LOCAL_* variables or `supabase status`. Refuses anything but 127.0.0.1 /
 * localhost, so an E2E can never run against a remote project.
 */
export function localEnv(): { url: string; anonKey: string; serviceKey: string } {
  let url = process.env.LOCAL_SUPABASE_URL ?? "";
  let anonKey = process.env.LOCAL_ANON_KEY ?? "";
  let serviceKey = process.env.LOCAL_SERVICE_ROLE_KEY ?? "";
  if (!url || !anonKey || !serviceKey) {
    const status = execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: process.platform === "win32" });
    const read = (name: string) => /^(?:export )?NAME="?([^"\n]*)"?$/m.source.replace("NAME", name);
    url ||= new RegExp(read("API_URL"), "m").exec(status)?.[1] ?? "";
    anonKey ||= new RegExp(read("ANON_KEY"), "m").exec(status)?.[1] ?? "";
    serviceKey ||= new RegExp(read("SERVICE_ROLE_KEY"), "m").exec(status)?.[1] ?? "";
  }
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("refusing to run: the E2E only runs against a local Supabase stack");
  if (!anonKey || !serviceKey) throw new Error("missing local Supabase keys (supabase start)");
  return { url, anonKey, serviceKey };
}

/**
 * Runs SQL as `postgres` in the LOCAL database container (`docker exec`),
 * for fixtures the service role may not write (organizations, platform
 * tables). Container: LOCAL_DB_CONTAINER or supabase_db_<project_id>.
 */
export function localSql(sql: string): string {
  const container = process.env.LOCAL_DB_CONTAINER ?? "supabase_db_EmailBot";
  return execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-q"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
}
