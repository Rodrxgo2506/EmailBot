import { randomBytes, randomUUID } from "node:crypto";
import { SecretBox } from "@emailbot/shared";
import type { OrganizationRole } from "@emailbot/types";
import { vi } from "vitest";
import { buildApp } from "../app.js";
import type { ApiConfig } from "../config/env.js";
import { createMemoryNonceStore } from "../infrastructure/nonces.js";
import type { RateLimitRedis } from "../infrastructure/rate-limit-store.js";
import type { AppDeps, AuthenticatedUser } from "../deps.js";
import type { PrivilegedOperations, Repositories } from "../repositories/types.js";

export const ORG_A = "11111111-1111-4111-8111-111111111111";
export const ORG_B = "22222222-2222-4222-8222-222222222222";

export function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    env: "test",
    logLevel: "silent",
    host: "127.0.0.1",
    port: 0,
    apiPublicUrl: "http://localhost:3000",
    webAppUrl: "http://localhost:5173",
    corsOrigins: ["http://localhost:5173"],
    trustProxy: false,
    rateLimitMax: 10_000,
    supabase: { url: "http://localhost:54321", anonKey: "anon", serviceRoleKey: "service" },
    attachmentsBucket: "email-attachments",
    redisUrl: "redis://localhost:6379",
    providerHttpTimeoutMs: 20_000,
    supabaseHttpTimeoutMs: 60_000,
    tokenEncryptionKey: randomBytes(32).toString("base64"),
    oauthStateSecret: "s".repeat(40),
    google: null,
    microsoft: null,
    gmailPubSubVerificationToken: null,
    microsoftWebhookClientState: null,
    sentryDsn: null,
    ...overrides
  };
}

type DeepMock<T> = { [K in keyof T]: { [M in keyof T[K]]: ReturnType<typeof vi.fn> } };

function unexpected(name: string) {
  return vi.fn(async () => {
    throw new Error(`Unexpected repository call: ${name}`);
  });
}

/** Repositories whose methods fail loudly unless a test overrides them. */
export function createFakeRepositories(): DeepMock<Repositories> {
  const groups: Record<string, string[]> = {
    memberships: ["listForUser", "findRole"],
    organizations: ["create", "get", "update", "getSettings", "updateSettings", "transferOwnership"],
    members: ["list", "get", "add", "updateRole", "remove"],
    emailAccounts: ["list", "get", "update", "remove"],
    categories: ["list", "get", "create", "update", "remove"],
    rules: ["list", "get", "create", "update", "remove"],
    emails: ["list", "get", "update", "remove"],
    attachments: ["get", "listStoredObjects"],
    audit: ["list"]
  };

  return Object.fromEntries(
    Object.entries(groups).map(([group, methods]) => [
      group,
      Object.fromEntries(methods.map((method) => [method, unexpected(`${group}.${method}`)]))
    ])
  ) as unknown as DeepMock<Repositories>;
}

export function createFakePrivileged(): { [K in keyof PrivilegedOperations]: ReturnType<typeof vi.fn> } {
  return {
    findProfileIdByEmail: unexpected("privileged.findProfileIdByEmail"),
    getMemberRole: unexpected("privileged.getMemberRole"),
    upsertOAuthEmailAccount: unexpected("privileged.upsertOAuthEmailAccount"),
    createImapEmailAccount: unexpected("privileged.createImapEmailAccount"),
    disconnectEmailAccount: unexpected("privileged.disconnectEmailAccount"),
    insertAuditLog: vi.fn(async () => undefined),
    createSignedDownloadUrl: unexpected("privileged.createSignedDownloadUrl"),
    removeStorageObjects: vi.fn(async () => ({ failed: 0 }))
  };
}

export interface TestUser extends AuthenticatedUser {
  token: string;
  /** organizationId -> role */
  roles: Record<string, OrganizationRole>;
}

export function makeUser(roles: Record<string, OrganizationRole>): TestUser {
  const id = randomUUID();
  return { id, email: `${id.slice(0, 8)}@example.com`, token: `token-${id}`, roles };
}

/**
 * Builds the real Fastify app with fake infrastructure. Membership lookups
 * are answered from the users' `roles` maps, like RLS would.
 */
export async function createTestApp(
  options: { users?: TestUser[]; config?: Partial<ApiConfig>; fetch?: typeof fetch; rateLimitRedis?: RateLimitRedis } = {}
) {
  const users = options.users ?? [];
  const repos = createFakeRepositories();
  const privileged = createFakePrivileged();
  const queue = { enqueueEmailEvent: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  const config = testConfig(options.config);

  repos.memberships.findRole.mockImplementation(async (userId: string, organizationId: string) => {
    return users.find((user) => user.id === userId)?.roles[organizationId] ?? null;
  });
  repos.memberships.listForUser.mockImplementation(async (userId: string) => {
    const user = users.find((candidate) => candidate.id === userId);
    return Object.entries(user?.roles ?? {}).map(([organizationId, role]) => ({
      role,
      organization: {
        id: organizationId,
        name: `Org ${organizationId.slice(0, 4)}`,
        slug: `org-${organizationId.slice(0, 4)}`,
        plan: "FREE",
        status: "ACTIVE",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z"
      }
    }));
  });

  const deps: AppDeps = {
    config,
    identity: {
      async verifyAccessToken(token) {
        const user = users.find((candidate) => candidate.token === token);
        return user ? { id: user.id, email: user.email } : null;
      }
    },
    repositories: () => repos as unknown as Repositories,
    privileged: privileged as unknown as PrivilegedOperations,
    queue,
    secretBox: SecretBox.fromBase64(config.tokenEncryptionKey),
    fetch: options.fetch ?? (vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch),
    readinessChecks: [],
    oauthNonces: createMemoryNonceStore(),
    ...(options.rateLimitRedis ? { rateLimitRedis: options.rateLimitRedis } : {})
  };

  const app = await buildApp(deps, { logger: false });
  return { app, deps, repos, privileged, queue };
}

export function authHeaders(user: TestUser, organizationId?: string): Record<string, string> {
  return {
    authorization: `Bearer ${user.token}`,
    ...(organizationId ? { "x-organization-id": organizationId } : {})
  };
}
