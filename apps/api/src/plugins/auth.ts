import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps, AuthenticatedUser } from "../deps.js";
import { unauthorized } from "../lib/errors.js";
import type { Repositories } from "../repositories/types.js";

export interface RequestAuth {
  user: AuthenticatedUser;
  accessToken: string;
  /** Repositories bound to this user's JWT (created lazily, once per request). */
  readonly repos: Repositories;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: RequestAuth | null;
  }
  interface FastifyInstance {
    authenticate(request: FastifyRequest): Promise<void>;
  }
}

const MAX_TOKEN_LENGTH = 8192;

function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  return token;
}

/**
 * Supabase Auth is the only identity source. The API validates the bearer
 * token with Supabase and then talks to PostgREST *as that user*, so RLS
 * applies to every query.
 */
export function registerAuth(app: FastifyInstance, deps: AppDeps): void {
  app.decorateRequest("auth", null);

  app.decorate("authenticate", async (request: FastifyRequest) => {
    const accessToken = extractBearerToken(request);
    if (!accessToken) throw unauthorized();

    const user = await deps.identity.verifyAccessToken(accessToken);
    if (!user) throw unauthorized("Invalid or expired access token");

    let repos: Repositories | undefined;
    request.auth = {
      user,
      accessToken,
      get repos() {
        repos ??= deps.repositories(accessToken);
        return repos;
      }
    };
    request.log = request.log.child({ userId: user.id });
  });
}

export function getAuth(request: FastifyRequest): RequestAuth {
  if (!request.auth) throw unauthorized();
  return request.auth;
}
