/*
 * Culqi Custom Checkout (https://docs.culqi.com/es/documentacion/checkout/checkout-custom):
 *
 *   <script src="https://js.culqi.com/checkout-js">
 *   const Culqi = new CulqiCheckout(publicKey, { settings, client, options, appearance });
 *   Culqi.culqi = () => { Culqi.token ? Culqi.token.id : Culqi.error };
 *   Culqi.closeCheckout = () => { ... };   // the user closed the form without paying (`culqi` is not called)
 *   Culqi.open(); Culqi.close();
 *
 * The card is typed inside Culqi's iframe (https://checkoutview.culqi.com) and
 * tokenized there: this page only receives the token id (tkn_...), which is
 * all EmailBot ever sends to its API. Only card payments are enabled (a
 * subscription needs a card).
 */

export const CULQI_CHECKOUT_SCRIPT = "https://js.culqi.com/checkout-js";

interface CulqiCheckoutInstance {
  open(): void;
  close(): void;
  culqi?: () => void;
  /** Called by Culqi when the user closes its form (setter in the official script); `culqi` is not called then. */
  closeCheckout?: () => void;
  token?: { id?: string } | null;
  error?: { user_message?: string; merchant_message?: string } | string | null;
}

type CulqiCheckoutConstructor = new (publicKey: string, config: unknown) => CulqiCheckoutInstance;

declare global {
  interface Window {
    CulqiCheckout?: CulqiCheckoutConstructor;
  }
}

let loading: Promise<CulqiCheckoutConstructor> | null = null;

/** Loads Culqi's script once (CSP allows exactly this origin). */
export function loadCulqiCheckout(): Promise<CulqiCheckoutConstructor> {
  if (window.CulqiCheckout) return Promise.resolve(window.CulqiCheckout);
  if (loading) return loading;
  loading = new Promise<CulqiCheckoutConstructor>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CULQI_CHECKOUT_SCRIPT;
    script.async = true;
    script.onload = () => (window.CulqiCheckout ? resolve(window.CulqiCheckout) : reject(new Error("No se pudo iniciar el formulario de pago")));
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("No se pudo cargar el formulario de pago. Revisa tu conexión e inténtalo de nuevo."));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export interface CardTokenRequest {
  /** Culqi PUBLIC key from the API (pk_test_ in this phase). */
  publicKey: string;
  /** Céntimos, from the API (shown by Culqi; the charge itself comes from the Culqi plan). */
  amountCents: number;
  currency: string;
  email: string | null;
}

/** The user closed Culqi's form without paying: nothing was tokenized or charged. */
export const CHECKOUT_CLOSED_MESSAGE = "Cerraste el formulario de pago sin completarlo. No se realizó ningún cobro.";

/** Opens Culqi's checkout and resolves with the card token id (tkn_...); rejects if the form is closed without paying. */
export async function requestCardToken(request: CardTokenRequest): Promise<string> {
  const CulqiCheckout = await loadCulqiCheckout();
  return new Promise<string>((resolve, reject) => {
    const checkout = new CulqiCheckout(request.publicKey, {
      settings: { title: "EmailBot", currency: request.currency, amount: request.amountCents },
      client: request.email ? { email: request.email } : {},
      options: {
        lang: "auto",
        installments: false,
        modal: true,
        paymentMethods: { tarjeta: true, yape: false, billetera: false, bancaMovil: false, agente: false, cuotealo: false },
        paymentMethodsSort: ["tarjeta"]
      },
      appearance: { theme: "default", menuType: "sidebar", hiddenCulqiLogo: false, hiddenBanner: false }
    });
    let settled = false;
    checkout.culqi = () => {
      if (settled) return;
      settled = true;
      const token = checkout.token?.id;
      checkout.close();
      if (typeof token === "string" && /^tkn_(test|live)_[A-Za-z0-9]+$/.test(token)) {
        resolve(token);
        return;
      }
      const error = checkout.error;
      const message = typeof error === "string" ? error : (error?.user_message ?? "No se pudo validar la tarjeta.");
      reject(new Error(message));
    };
    checkout.closeCheckout = () => {
      if (settled) return;
      settled = true;
      reject(new Error(CHECKOUT_CLOSED_MESSAGE));
    };
    checkout.open();
  });
}
