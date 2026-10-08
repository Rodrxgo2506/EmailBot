import { BookOpenText, Mail, MapPin, Phone, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { LEGAL_CONTACT_EMAIL, LEGAL_CONTACT_PHONE, SERVICE_OPERATOR, SERVICE_OPERATOR_RUC, SERVICE_PUBLIC_ADDRESS } from "@/features/legal/legal-info";
import { usePageMeta } from "@/lib/page-meta";
import { PublicLayout } from "./public-layout";

/* Public contact page (/contacto). Only data defined by the owner (legal-info.ts); no invented schedule. */

function ContactCard({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-4 rounded-2xl border border-border/70 bg-card p-5 shadow-[0_1px_2px_rgb(15_23_42/0.04)] dark:border-border">
      <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon className="size-5" />
      </span>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <div className="mt-1 text-sm text-muted-foreground [&_a]:font-medium [&_a]:[overflow-wrap:anywhere] [&_a]:text-primary [&_a:hover]:underline">{children}</div>
      </div>
    </div>
  );
}

export function ContactPage() {
  usePageMeta("Contacto · EmailBot", "Datos de contacto y soporte de EmailBot: correo, teléfono y dirección.");

  return (
    <PublicLayout>
      <div className="mx-auto w-full max-w-4xl px-4 py-14 sm:px-6 sm:py-20">
        <header className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Contacto</h1>
          <p className="mx-auto mt-4 max-w-2xl text-base text-muted-foreground">
            Escríbenos para resolver dudas sobre EmailBot, tus planes, tu cuenta o el uso del servicio. Te responderemos por el mismo medio.
          </p>
        </header>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {LEGAL_CONTACT_EMAIL ? (
            <ContactCard icon={Mail} title="Correo de soporte">
              <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>
            </ContactCard>
          ) : null}
          {LEGAL_CONTACT_PHONE ? (
            <ContactCard icon={Phone} title="Teléfono">
              <a href={`tel:${LEGAL_CONTACT_PHONE}`}>{LEGAL_CONTACT_PHONE}</a>
            </ContactCard>
          ) : null}
          <ContactCard icon={MapPin} title="Dirección">
            <address className="not-italic">
              {SERVICE_PUBLIC_ADDRESS.street}
              <br />
              {SERVICE_PUBLIC_ADDRESS.locality}
            </address>
          </ContactCard>
          <ContactCard icon={BookOpenText} title="Libro de Reclamaciones">
            Para registrar una queja o un reclamo, usa nuestro <Link to="/libro-de-reclamaciones">Libro de Reclamaciones virtual</Link>.
          </ContactCard>
        </div>

        <section aria-labelledby="holder-title" className="mt-10 rounded-2xl border border-dashed border-border/80 p-5 text-sm text-muted-foreground dark:border-border">
          <h2 id="holder-title" className="font-semibold text-foreground">
            Titular del servicio
          </h2>
          <p className="mt-1">
            {SERVICE_OPERATOR ?? "EmailBot"}
            {SERVICE_OPERATOR_RUC ? ` · RUC ${SERVICE_OPERATOR_RUC}` : null}
          </p>
          <p className="mt-3">
            Consulta también nuestros <Link to="/terms" className="font-medium text-primary hover:underline">Términos y condiciones</Link>, la{" "}
            <Link to="/privacy" className="font-medium text-primary hover:underline">Política de privacidad</Link> y la{" "}
            <Link to="/cambios-devoluciones" className="font-medium text-primary hover:underline">política de cambios, devoluciones y cancelación</Link>.
          </p>
        </section>
      </div>
    </PublicLayout>
  );
}
