import net from "node:net";

/*
 * F5.2 test helper (not a test file): a loopback TCP proxy in front of the throwaway Valkey that can
 *   freeze()  keep the connections open but hold every byte the clients send (Redis "accepts and never answers";
 *             the held commands are NOT lost),
 *   thaw()    deliver the held bytes in order (commands that timed out on the client run late, as on a slow server),
 *   mute()    the opposite direction: commands reach Redis and run, their ANSWERS are held (unmute() delivers them),
 *   drop()    close the current connections, keep listening (the clients reconnect at once),
 *   refuse()  stop listening and drop the connections (new connections are refused),
 *   listen()  accept again (same port).
 * Only bytes move through it; credentials stay in the clients' URLs and are never logged.
 */

export interface FreezeProxy {
  port: number;
  /** The target URL with the proxy's port (same credentials). */
  url(targetUrl: string): string;
  freeze(): void;
  thaw(): void;
  mute(): void;
  unmute(): void;
  drop(): void;
  refuse(): Promise<void>;
  listen(): Promise<void>;
  stop(): Promise<void>;
}

export async function startFreezeProxy(target: { host: string; port: number }): Promise<FreezeProxy> {
  let frozen = false;
  let muted = false;
  const pairs = new Set<{ client: net.Socket; upstream: net.Socket; held: Buffer[]; answers: Buffer[] }>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    const pair = { client, upstream, held: [] as Buffer[], answers: [] as Buffer[] };
    pairs.add(pair);
    const close = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
    client.on("data", (chunk: Buffer) => (frozen ? pair.held.push(chunk) : upstream.write(chunk)));
    upstream.on("data", (chunk: Buffer) => (muted ? pair.answers.push(chunk) : client.write(chunk)));
  });
  const listen = (port: number) => new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", () => resolve()));
  await listen(0);
  const port = (server.address() as net.AddressInfo).port;
  const dropAll = () => {
    for (const pair of pairs) {
      pair.client.destroy();
      pair.upstream.destroy();
    }
    pairs.clear();
  };
  return {
    port,
    url(targetUrl) {
      const url = new URL(targetUrl);
      url.port = String(port);
      return url.toString();
    },
    freeze: () => {
      frozen = true;
    },
    thaw: () => {
      frozen = false;
      for (const pair of pairs) for (const chunk of pair.held.splice(0)) pair.upstream.write(chunk);
    },
    mute: () => {
      muted = true;
    },
    unmute: () => {
      muted = false;
      for (const pair of pairs) for (const chunk of pair.answers.splice(0)) pair.client.write(chunk);
    },
    drop: dropAll,
    refuse: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        dropAll();
      });
    },
    listen: () => listen(port),
    stop: async () => {
      dropAll();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
