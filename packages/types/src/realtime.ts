/** Events pushed to browsers through Socket.IO (one room per organization). */
export type RealtimeEvent =
  | {
      type: "email.processed";
      organizationId: string;
      emailId: string;
      emailAccountId: string;
      categoryId: string | null;
      matchedRuleId: string | null;
      /** Bot selected by the rule engine (null = none or ambiguous). */
      botId: string | null;
      subject: string | null;
      important: boolean;
    }
  | {
      type: "notification";
      organizationId: string;
      emailId: string;
      title: string;
      body: string;
    }
  | {
      type: "email-account.status";
      organizationId: string;
      emailAccountId: string;
      status: string;
    };

/** Redis pub/sub channel the worker publishes to and the API relays from. */
export const REALTIME_REDIS_CHANNEL = "emailbot:realtime";

/**
 * Session control messages on the realtime socket.
 *  - client -> server `auth:refresh`: the browser renewed its Supabase session;
 *    the server re-verifies the new token and uses it for later revalidations.
 *  - server -> client `realtime:revoked`: sent right before the server closes
 *    the socket. `token` = the session is no longer valid (refresh and
 *    reconnect); `membership` = access to the organization was removed (do
 *    not reconnect).
 */
export const REALTIME_AUTH_REFRESH = "auth:refresh";
export const REALTIME_REVOKED = "realtime:revoked";

export type RealtimeRevokedReason = "token" | "membership";

export interface RealtimeAuthRefreshAck {
  ok: boolean;
}

export function organizationRoom(organizationId: string): string {
  return `org:${organizationId}`;
}
