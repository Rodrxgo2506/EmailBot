/*
 * Test-only preload (node --require) used by valkey-target.test.ts to observe a child
 * process: records EVERY socket connect (TCP host / port or IPC pipe path) and DNS lookup
 * to the file named by NET_BLOCK_HOOK_LOG, and BLOCKS all of them, so nothing ever leaves
 * the machine. Records host, port or path only: never credentials from a URL.
 */
const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");

const logFile = process.env.NET_BLOCK_HOOK_LOG;
const record = (entry) => {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};
const blocked = (what) => Object.assign(new Error(`net-block-hook: blocked ${what}`), { code: "E_NET_BLOCKED" });

net.Socket.prototype.connect = function blockedConnect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === "object" && first !== null ? first : typeof first === "string" ? { path: first } : { port: first, host: args[1] };
  const target = options.path !== undefined ? { kind: "pipe", path: String(options.path) } : { kind: "tcp", host: String(options.host ?? "localhost"), port: Number(options.port) };
  record(target);
  process.nextTick(() => this.destroy(blocked(target.kind)));
  return this;
};

const lookup = function blockedLookup(hostname, ...rest) {
  record({ kind: "dns", hostname: String(hostname) });
  const callback = rest.find((value) => typeof value === "function");
  if (callback) process.nextTick(() => callback(blocked("dns")));
  return {};
};
dns.lookup = lookup;
dns.promises.lookup = async (hostname) => {
  record({ kind: "dns", hostname: String(hostname) });
  throw blocked("dns");
};
