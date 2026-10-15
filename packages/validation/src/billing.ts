import { BILLING_PERIODS, COMMERCIAL_PLANS } from "@emailbot/types";
import { z } from "zod";

/*
 * Commercial V1 phase 2 (Culqi sandbox). The browser sends WHAT it wants to
 * buy (plan + period) and the card TOKEN produced by Culqi Custom Checkout;
 * never an amount, a currency, limits or card data. Bodies are strict: any
 * other field (amount, currency, price, entitlements...) is a 400.
 */

export const billingCheckoutQuerySchema = z
  .object({
    plan: z.enum(COMMERCIAL_PLANS),
    billingPeriod: z.enum(BILLING_PERIODS)
  })
  .strict();

export type BillingCheckoutQuery = z.infer<typeof billingCheckoutQuerySchema>;

/**
 * Culqi customer names: "Sólo se aceptan carácteres alfabéticos y espacios"
 * (2-50, Culqi API v2 - Clientes).
 */
const culqiName = z
  .string()
  .trim()
  .min(2)
  .max(50)
  .regex(/^[\p{L}]+(?:[ '\p{L}]*[\p{L}])?$/u, "Solo letras y espacios");

/** Billing contact required by Culqi to create the customer (Culqi API v2 - Clientes). Not stored by EmailBot. */
export const billingCustomerSchema = z
  .object({
    firstName: culqiName,
    lastName: culqiName,
    phoneNumber: z
      .string()
      .trim()
      .regex(/^\+?\d{5,15}$/, "Entre 5 y 15 dígitos"),
    address: z.string().trim().min(5).max(100),
    addressCity: z.string().trim().min(2).max(30),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, "Código de país de 2 letras")
      .transform((value) => value.toUpperCase())
  })
  .strict();

export type BillingCustomerInput = z.infer<typeof billingCustomerSchema>;

export const billingSubscriptionCreateSchema = z
  .object({
    plan: z.enum(COMMERCIAL_PLANS),
    billingPeriod: z.enum(BILLING_PERIODS),
    /** Culqi card token id from Culqi Custom Checkout (tkn_test_...). Never card data. */
    tokenId: z.string().regex(/^tkn_(test|live)_[A-Za-z0-9]{1,64}$/, "Invalid card token"),
    /** Explicit acceptance of the Terms before paying (sent to Culqi as tyc: true). */
    acceptTerms: z.literal(true),
    customer: billingCustomerSchema
  })
  .strict();

export type BillingSubscriptionCreateInput = z.infer<typeof billingSubscriptionCreateSchema>;

/** Body of POST /webhooks/culqi: only the event id is used (the event is re-read from Culqi). */
export const culqiWebhookBodySchema = z
  .object({
    id: z.string().regex(/^evt_(test|live)_[A-Za-z0-9]{1,64}$/),
    type: z.string().max(100).optional()
  })
  .passthrough();
