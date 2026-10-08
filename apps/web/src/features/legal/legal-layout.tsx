import { useEffect, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { PublicFooter, PublicHeader } from "@/features/public/public-layout";
import { cn } from "@/lib/utils";
import {
  LEGAL_CONTACT_EMAIL,
  LEGAL_CONTACT_PHONE,
  LEGAL_LAST_UPDATED,
  SERVICE_FISCAL_ADDRESS,
  SERVICE_NAME,
  SERVICE_OPERATOR,
  SERVICE_OPERATOR_RUC,
  SERVICE_OPERATOR_TYPE,
  SERVICE_PUBLIC_ADDRESS_LINE
} from "./legal-info";

/*
 * Public layout for the legal pages. Rendered outside the auth and
 * organization providers: no session, organization or Supabase call is
 * needed to display it.
 */

const LEGAL_LINKS = [
  { to: "/privacy", label: "Privacidad" },
  { to: "/terms", label: "Términos" },
  { to: "/cambios-devoluciones", label: "Devoluciones" },
  { to: "/libro-de-reclamaciones", label: "Libro de Reclamaciones" }
] as const;

/** Sets document.title while the page is mounted. */
function useDocumentTitle(title: string) {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** "Privacidad · Términos" links, reused by the public auth pages. */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Información legal" className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-sm", className)}>
      {LEGAL_LINKS.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          className={({ isActive }) =>
            cn("text-muted-foreground transition-colors hover:text-foreground", isActive && "font-medium text-foreground")
          }
        >
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function LegalLayout({
  title,
  documentTitle,
  summary,
  version,
  children
}: {
  title: string;
  documentTitle: string;
  summary: ReactNode;
  /** Shown next to the date (e.g. "2.0"); signing up records the accepted versions. */
  version?: string;
  children: ReactNode;
}) {
  useDocumentTitle(documentTitle);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <PublicHeader />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
        <article>
          <header className="mb-10 border-b pb-8">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {version ? `Versión ${version} · ` : null}Última actualización: {LEGAL_LAST_UPDATED}
            </p>
            <div className="mt-6 text-[0.95rem] leading-7 text-muted-foreground">{summary}</div>
          </header>
          <div className="flex flex-col gap-10">{children}</div>
        </article>
      </main>

      <PublicFooter />
    </div>
  );
}

/** Numbered section with an anchor (e.g. /privacy#gmail). */
export function LegalSection({ id, number, title, children }: { id: string; number: number; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20">
      <h2 id={`${id}-title`} className="mb-4 text-lg font-semibold tracking-tight">
        <span className="mr-2 text-muted-foreground">{number}.</span>
        {title}
      </h2>
      <div className="flex flex-col gap-4 text-[0.95rem] leading-7 text-foreground/90 [&_a]:font-medium [&_a]:text-primary [&_a:hover]:underline [&_strong]:font-semibold [&_strong]:text-foreground">
        {children}
      </div>
    </section>
  );
}

export function LegalSubheading({ children }: { children: ReactNode }) {
  return <h3 className="pt-1 font-semibold text-foreground">{children}</h3>;
}

export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-muted-foreground">{children}</ul>;
}

/** Visible marker for owner data that does not exist yet (never an invented value). */
export function Pending({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md border border-dashed border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-sm text-amber-700 dark:text-amber-300">
      Pendiente de completar: {children}
    </span>
  );
}

/**
 * Holder and contact details shared by both documents (legal-info.ts). The
 * fiscal address line only appears once it exists: it is never invented.
 */
export function ContactDetails() {
  return (
    <LegalList>
      <li>
        Titular del servicio {SERVICE_NAME}:{" "}
        {SERVICE_OPERATOR ? <strong>{SERVICE_OPERATOR}</strong> : <Pending>nombre legal del titular</Pending>}
        {SERVICE_OPERATOR_TYPE ? ` (${SERVICE_OPERATOR_TYPE.toLowerCase()})` : null}
      </li>
      <li>RUC: {SERVICE_OPERATOR_RUC ?? <Pending>RUC</Pending>}</li>
      {SERVICE_FISCAL_ADDRESS ? <li>Domicilio fiscal: {SERVICE_FISCAL_ADDRESS}</li> : null}
      <li>Dirección: {SERVICE_PUBLIC_ADDRESS_LINE}</li>
      <li>
        Correo de contacto:{" "}
        {LEGAL_CONTACT_EMAIL ? <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a> : <Pending>correo de contacto</Pending>}
      </li>
      <li>
        Teléfono:{" "}
        {LEGAL_CONTACT_PHONE ? <a href={`tel:${LEGAL_CONTACT_PHONE}`}>{LEGAL_CONTACT_PHONE}</a> : <Pending>teléfono de contacto</Pending>}
      </li>
    </LegalList>
  );
}
