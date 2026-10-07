import type { CustomerResolutionSource } from "@emailbot/types";
import { describe, expect, it, vi } from "vitest";
import { processEmail, type ProcessEmailDeps } from "../pipeline/process-email.js";
import type { Logger } from "../pipeline/ports.js";
import {
  makeAccount,
  makeAccountStore,
  makeAdapter,
  makeAudit,
  makeEmail,
  makeProducer,
  makeRealtime,
  makeRegistry,
  makeRuleRow,
  MemoryEmailStore,
  MemoryRoutingStore,
  ORG
} from "./fakes.js";

/*
 * Email -> bot -> customer -> portal, end to end through processEmail, with
 * the shape of a real report: a bot rule that only matches the sender and
 * only marks the email important, a customer with an EMAIL identifier and an
 * active assignment to the bot. Whether the email reaches the portal depends
 * ONLY on the bot's customer_resolution (never on the rule's actions): with
 * the default (NONE) it is stored for the panel but never delivered.
 */

const SENDER = "someone@gmail.example";
const MAILBOX = "owner@hotmail.example";
const BOT = "bot-netflix";

function scenario(source: CustomerResolutionSource, identifier: string) {
  const account = makeAccount({ provider: "MICROSOFT" });
  const emails = new MemoryEmailStore();
  emails.rules = [
    makeRuleRow({
      id: "verification-code",
      bot_id: BOT,
      bot: { status: "ACTIVE" },
      category_id: null,
      conditions: { conditions: [{ field: "sender", operator: "contains", value: SENDER }] },
      actions: { actions: [{ type: "MARK_IMPORTANT" }] }
    })
  ];
  const routing = new MemoryRoutingStore(emails);
  routing.addBot(BOT, { source, onMultipleMatches: "LEAVE_UNASSIGNED" });
  routing.addCustomer("customer-1", { normalizedValue: identifier }, { bots: [BOT] });

  const info = vi.fn();
  const logger: Logger = { debug: () => undefined, info, warn: () => undefined, error: () => undefined };
  const realtime = makeRealtime();
  const adapter = makeAdapter({
    fetchMessage: vi.fn(async (_context, id: string) =>
      makeEmail({ provider: "MICROSOFT", providerMessageId: id, sender: { address: SENDER, name: null }, recipients: [{ address: MAILBOX, name: null }], subject: "PRUEBA" })
    )
  });
  const deps: ProcessEmailDeps = {
    accounts: makeAccountStore([account]),
    emails,
    routing,
    audit: makeAudit(),
    storage: { upload: vi.fn(async () => undefined), exists: vi.fn(async () => false) },
    realtime,
    producer: makeProducer(),
    providers: makeRegistry(adapter),
    createContext: (acc) => ({ account: acc, getAccessToken: async () => "token" }),
    attachmentsBucket: "email-attachments",
    maxAttachmentBytes: 1000,
    logger,
    storageRetryDelayMs: 0
  };
  const job = { organizationId: ORG, emailAccountId: account.id, provider: "MICROSOFT" as const, providerMessageId: "msg-1" };
  const routingEvents = () => info.mock.calls.map(([fields]) => fields as Record<string, unknown>).filter((fields) => String(fields.event).startsWith("routing."));
  return { deps, job, emails, routing, realtime, routingEvents };
}

describe("email -> bot -> customer -> portal (processEmail)", () => {
  it("bot with the default resolution (NONE): stored and marked important for the panel, never delivered (NOT_CONFIGURED)", async () => {
    const { deps, job, emails, routing, realtime, routingEvents } = scenario("NONE", MAILBOX);

    await expect(processEmail(job, deps)).resolves.toMatchObject({ status: "processed", matchedRuleIds: ["verification-code"] });

    expect(emails.rows[0]).toMatchObject({ bot_id: BOT, is_important: true, processing_status: "PROCESSED" });
    expect(routing.deliveries).toEqual([]);
    expect(routing.findCandidates).not.toHaveBeenCalled();
    expect(routingEvents()).toEqual([expect.objectContaining({ event: "routing.unassigned", botId: BOT, reason: "NOT_CONFIGURED" })]);
    expect(realtime.publish).not.toHaveBeenCalledWith(expect.objectContaining({ type: "portal.deliveries" }));
  });

  it("RECIPIENT + identifier = the receiving mailbox: delivered to the customer, portal notified", async () => {
    const { deps, job, routing, realtime, routingEvents } = scenario("RECIPIENT", MAILBOX);

    await processEmail(job, deps);

    expect(routing.deliveries).toEqual([expect.objectContaining({ email_id: "email-1", customer_id: "customer-1", bot_id: BOT, resolution: "AUTOMATIC" })]);
    expect(routingEvents()).toEqual([expect.objectContaining({ event: "routing.delivered", customers: 1 })]);
    expect(realtime.publish).toHaveBeenCalledWith({ type: "portal.deliveries", organizationId: ORG, customerIds: ["customer-1"] });
  });

  it("SENDER + identifier = the sender address: delivered", async () => {
    const { deps, job, routing } = scenario("SENDER", SENDER);
    await processEmail(job, deps);
    expect(routing.deliveries).toEqual([expect.objectContaining({ customer_id: "customer-1", resolution: "AUTOMATIC" })]);
  });

  it("source and identifier must agree: RECIPIENT with the sender's address as identifier is NO_MATCH", async () => {
    const { deps, job, routing, routingEvents } = scenario("RECIPIENT", SENDER);
    await processEmail(job, deps);
    expect(routing.deliveries).toEqual([]);
    expect(routingEvents()).toEqual([expect.objectContaining({ event: "routing.unassigned", reason: "NO_MATCH" })]);
  });
});
