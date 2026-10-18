// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * Culqi Custom Checkout wrapper: Culqi's official script, cards only, and the
 * page receives nothing but the token id (card data stays in Culqi's iframe).
 */

type Instance = { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; culqi?: () => void; closeCheckout?: () => void; token?: { id?: string } | null; error?: unknown };

function installFakeCulqi() {
  const created: Array<{ publicKey: string; config: Record<string, unknown>; instance: Instance }> = [];
  window.CulqiCheckout = vi.fn(function (this: Instance, publicKey: string, config: Record<string, unknown>) {
    this.open = vi.fn();
    this.close = vi.fn();
    created.push({ publicKey, config, instance: this });
  }) as unknown as typeof window.CulqiCheckout;
  return created;
}

afterEach(() => {
  delete window.CulqiCheckout;
  document.head.querySelectorAll("script").forEach((script) => script.remove());
  vi.resetModules();
});

describe("Culqi Custom Checkout", () => {
  it("loads Culqi's official script once", async () => {
    const { loadCulqiCheckout, CULQI_CHECKOUT_SCRIPT } = await import("./culqi-checkout");
    expect(CULQI_CHECKOUT_SCRIPT).toBe("https://js.culqi.com/checkout-js");
    const first = loadCulqiCheckout();
    const second = loadCulqiCheckout();
    const scripts = document.head.querySelectorAll(`script[src="${CULQI_CHECKOUT_SCRIPT}"]`);
    expect(scripts).toHaveLength(1);
    installFakeCulqi();
    scripts[0]?.dispatchEvent(new Event("load"));
    await expect(first).resolves.toBe(window.CulqiCheckout);
    await expect(second).resolves.toBe(window.CulqiCheckout);
  });

  it("opens with the public key, the API's amount and cards only; resolves with the token id", async () => {
    const created = installFakeCulqi();
    const { requestCardToken } = await import("./culqi-checkout");
    const pending = requestCardToken({ publicKey: "pk_test_PUBLIC", amountCents: 3990, currency: "PEN", email: "ana@example.com" });
    await vi.waitFor(() => expect(created).toHaveLength(1));
    const { publicKey, config, instance } = created[0]!;
    expect(publicKey).toBe("pk_test_PUBLIC");
    expect(config).toMatchObject({
      settings: { title: "EmailBot", currency: "PEN", amount: 3990 },
      client: { email: "ana@example.com" },
      options: { installments: false, paymentMethods: { tarjeta: true, yape: false, billetera: false, bancaMovil: false, agente: false, cuotealo: false } }
    });
    expect(instance.open).toHaveBeenCalled();

    instance.token = { id: "tkn_test_TOKEN1" };
    instance.culqi?.();
    await expect(pending).resolves.toBe("tkn_test_TOKEN1");
    expect(instance.close).toHaveBeenCalled();
  });

  it("rejects with Culqi's user message when no token is produced", async () => {
    const created = installFakeCulqi();
    const { requestCardToken } = await import("./culqi-checkout");
    const pending = requestCardToken({ publicKey: "pk_test_PUBLIC", amountCents: 1990, currency: "PEN", email: null });
    await vi.waitFor(() => expect(created).toHaveLength(1));
    created[0]!.instance.error = { user_message: "Tarjeta inválida" };
    created[0]!.instance.culqi?.();
    await expect(pending).rejects.toThrow("Tarjeta inválida");
  });

  it("the user closes Culqi's form without paying: rejects (nothing tokenized), a late callback is ignored", async () => {
    const created = installFakeCulqi();
    const { requestCardToken, CHECKOUT_CLOSED_MESSAGE } = await import("./culqi-checkout");
    const pending = requestCardToken({ publicKey: "pk_test_PUBLIC", amountCents: 1990, currency: "PEN", email: null });
    await vi.waitFor(() => expect(created).toHaveLength(1));
    const { instance } = created[0]!;
    expect(typeof instance.closeCheckout).toBe("function");
    instance.closeCheckout?.();
    await expect(pending).rejects.toThrow(CHECKOUT_CLOSED_MESSAGE);
    instance.token = { id: "tkn_test_LATE" };
    instance.culqi?.(); // settled once: ignored
    expect(instance.close).not.toHaveBeenCalled();
  });

  it("a token followed by Culqi's close event resolves once with the token", async () => {
    const created = installFakeCulqi();
    const { requestCardToken } = await import("./culqi-checkout");
    const pending = requestCardToken({ publicKey: "pk_test_PUBLIC", amountCents: 1990, currency: "PEN", email: null });
    await vi.waitFor(() => expect(created).toHaveLength(1));
    const { instance } = created[0]!;
    instance.token = { id: "tkn_test_TOKEN1" };
    instance.culqi?.();
    instance.closeCheckout?.();
    await expect(pending).resolves.toBe("tkn_test_TOKEN1");
  });
});
