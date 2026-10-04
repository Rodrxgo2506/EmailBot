import { Mail } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { LEGAL_LAST_UPDATED } from "./legal-info";

/*
 * Public layout for the legal pages. Rendered outside the auth and
 * organization providers: no session, organization or Supabase call is
 * needed to display it.
 */

const LEGAL_LINKS = [
  { to: "/privacy", label: "Privacidad" },
  { to: "/terms", label: "Términos" }
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

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-ring">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Mail className="size-4" />
      </span>
      <span className="font-semibold tracking-tight">EmailBot</span>
    </Link>
  );
}

/** "Privacidad · Términos" links, reused by the public auth pages. */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Información legal" className={cn("flex items-center gap-4 text-sm", className)}>
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
  children
}: {
  title: string;
  documentTitle: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  useDocumentTitle(documentTitle);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
          <Logo />
          <LegalLinks />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
        <article>
          <header className="mb-10 border-b pb-8">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">Última actualización: {LEGAL_LAST_UPDATED}</p>
            <div className="mt-6 text-[0.95rem] leading-7 text-muted-foreground">{summary}</div>
          </header>
          <div className="flex flex-col gap-10">{children}</div>
        </article>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-sm text-muted-foreground sm:px-6">
          <span>EmailBot</span>
          <div className="flex items-center gap-4">
            <LegalLinks />
            <Link to="/login" className="transition-colors hover:text-foreground">
              Iniciar sesión
            </Link>
          </div>
        </div>
      </footer>
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

/** Contact paragraph shared by both documents. */
export function ContactDetails({ email, operator }: { email: string | null; operator: string | null }) {
  return (
    <>
      <p>
        Responsable del servicio:{" "}
        {operator ? <strong>{operator}</strong> : <Pending>nombre legal del titular de EmailBot</Pending>}
      </p>
      <p>
        Correo de contacto:{" "}
        {email ? <a href={`mailto:${email}`}>{email}</a> : <Pending>dirección de correo de contacto</Pending>}
      </p>
    </>
  );
}
