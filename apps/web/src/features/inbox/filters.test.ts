import { emailListQuerySchema } from "@emailbot/validation";
import { describe, expect, it } from "vitest";
import { buildQuery } from "@/lib/api-client";
import { defaultView, parseInboxFilters, serializeInboxFilters, toEmailQuery } from "./filters";

const CATEGORY = "77777777-7777-4777-8777-777777777777";

describe("inbox filters", () => {
  it("parses URL params with safe defaults", () => {
    expect(parseInboxFilters(new URLSearchParams("view=bogus&page=-3"))).toEqual({
      view: "all",
      categoryId: null,
      accountId: null,
      search: "",
      page: 1
    });
    expect(parseInboxFilters(new URLSearchParams(""), "unread").view).toBe("unread");
  });

  it("round-trips through the URL", () => {
    const filters = { view: "important" as const, categoryId: CATEGORY, accountId: null, search: "código", page: 3 };
    expect(parseInboxFilters(serializeInboxFilters(filters))).toEqual(filters);
  });

  it("maps views to the API query and the API schema accepts it", () => {
    const query = toEmailQuery({ view: "unread", categoryId: CATEGORY, accountId: null, search: " codigo ", page: 2 });
    expect(query).toMatchObject({ isRead: false, isArchived: false, categoryId: CATEGORY, search: "codigo", page: 2 });

    const params = Object.fromEntries(new URLSearchParams(buildQuery(query).slice(1)));
    const parsed = emailListQuerySchema.safeParse(params);
    expect(parsed.success).toBe(true);
  });

  it("only shows archived mail in the archived view", () => {
    expect(toEmailQuery({ view: "all", categoryId: null, accountId: null, search: "", page: 1 }).isArchived).toBe(false);
    expect(toEmailQuery({ view: "archived", categoryId: null, accountId: null, search: "", page: 1 }).isArchived).toBe(true);
    expect(toEmailQuery({ view: "attachments", categoryId: null, accountId: null, search: "", page: 1 }).hasAttachments).toBe(true);
  });

  it("uses the organization default inbox filter", () => {
    expect(defaultView("IMPORTANT")).toBe("important");
    expect(defaultView(undefined)).toBe("all");
  });
});
