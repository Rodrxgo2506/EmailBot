import { describe, expect, it } from "vitest";
import { emailDeliveryParamsSchema, manualDeliveryCreateSchema, portalAttachmentParamsSchema, portalInboxQuerySchema } from "./index.js";

/* EmailBot V2 phase 5: portal and manual delivery request schemas. */

const ID = "11111111-1111-4111-8111-111111111111";

describe("portalInboxQuerySchema", () => {
  it("parses filters and defaults; unknown parameters (customerId, organizationId, botId) are dropped", () => {
    const parsed = portalInboxQuerySchema.parse({ unread: "true", important: "false", bot: "netflix", customerId: ID, organizationId: ID, botId: ID });
    expect(parsed).toEqual({ unread: true, important: false, bot: "netflix", limit: 25 });
    expect(parsed).not.toHaveProperty("customerId");
  });

  it.each([{ limit: "0" }, { limit: "51" }, { unread: "yes" }, { bot: "Not A Slug" }, { from: "yesterday" }, { search: "x".repeat(101) }, { cursor: "" }])(
    "rejects %j",
    (query) => {
      expect(portalInboxQuerySchema.safeParse(query).success).toBe(false);
    }
  );
});

describe("manual delivery and portal params", () => {
  it("the body carries only the customer; the organization comes from the session", () => {
    expect(manualDeliveryCreateSchema.safeParse({ customerId: ID }).success).toBe(true);
    expect(manualDeliveryCreateSchema.safeParse({ customerId: ID, organizationId: ID }).success).toBe(false);
    expect(manualDeliveryCreateSchema.safeParse({ customerId: "x" }).success).toBe(false);
  });

  it("path ids must be uuids", () => {
    expect(emailDeliveryParamsSchema.safeParse({ id: ID, deliveryId: ID }).success).toBe(true);
    expect(portalAttachmentParamsSchema.safeParse({ deliveryId: ID, attachmentId: "../x" }).success).toBe(false);
  });
});
