import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

/*
 * Commercial contact on /planes: WhatsApp with a prefilled message, for visitors who want to ask before
 * contracting, need help choosing a plan or prefer to contract with the EmailBot team. Fixed commercial
 * data (no environment variable, no database). It does not replace the plan CTAs.
 */

/** +51 971 458 658 (Peru), same phone as the legal pages. */
export const WHATSAPP_SALES_NUMBER = "51971458658";
export const WHATSAPP_SALES_MESSAGE = "Hola, quiero información para contratar un plan de EmailBot.";
export const WHATSAPP_SALES_URL = "https://wa.me/51971458658?text=Hola%2C%20quiero%20informaci%C3%B3n%20para%20contratar%20un%20plan%20de%20EmailBot.";

export function SalesContact() {
  return (
    <section
      aria-labelledby="sales-contact-title"
      className="mx-auto mt-16 max-w-4xl rounded-2xl border border-border/70 bg-card/80 p-6 text-center shadow-sm sm:mt-20 sm:p-8 dark:border-border"
    >
      <h2 id="sales-contact-title" className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
        ¿Prefieres hablar con nosotros?
      </h2>
      <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground sm:text-base">
        Escríbenos por WhatsApp para resolver tus dudas, elegir el plan adecuado para tu operación o contratarlo con el equipo de EmailBot.
      </p>
      <Button asChild size="lg" className="mt-6 h-11 w-full rounded-xl px-6 sm:w-auto">
        <a href={WHATSAPP_SALES_URL} target="_blank" rel="noopener noreferrer">
          <MessageCircle aria-hidden />
          Contratar por WhatsApp
        </a>
      </Button>
      <p className="mt-3 text-xs text-muted-foreground">WhatsApp: +51 971 458 658 · se abre en una pestaña nueva</p>
    </section>
  );
}
