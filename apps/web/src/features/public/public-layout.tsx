import { BookOpenText, Mail, MapPin, Phone } from "lucide-react";
import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  LEGAL_CONTACT_EMAIL,
  LEGAL_CONTACT_PHONE,
  SERVICE_OPERATOR,
  SERVICE_OPERATOR_RUC,
  SERVICE_PUBLIC_ADDRESS
} from "@/features/legal/legal-info";
import { cn } from "@/lib/utils";

/*
 * Public layout (home, contact, complaints book, legal pages): navbar with the
 * existing theme toggle and a footer with contact data and every legal link.
 * Rendered with or without the session providers: it never reads the session.
 */

export const PUBLIC_LEGAL_LINKS = [
  { to: "/terms", label: "Términos y condiciones" },
  { to: "/privacy", label: "Privacidad" },
  { to: "/cambios-devoluciones", label: "Cambios, devoluciones y cancelación" },
  { to: "/libro-de-reclamaciones", label: "Libro de Reclamaciones" }
] as const;

export function PublicLogo() {
  return (
    <Link to="/" className="flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-ring" aria-label="EmailBot, inicio">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Mail className="size-4" aria-hidden />
      </span>
      <span className="font-semibold tracking-tight">EmailBot</span>
    </Link>
  );
}

const navLink = ({ isActive }: { isActive: boolean }) =>
  cn("rounded-md px-2 py-1 text-sm transition-colors hover:text-foreground", isActive ? "font-medium text-foreground" : "text-muted-foreground");

export function PublicHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <PublicLogo />
        <div className="flex items-center gap-1 sm:gap-2">
          <nav aria-label="Secciones" className="mr-1 hidden items-center gap-1 md:flex">
            <NavLink to="/planes" className={navLink}>
              Planes
            </NavLink>
            <NavLink to="/contacto" className={navLink}>
              Contacto
            </NavLink>
          </nav>
          <ThemeToggle />
          <nav aria-label="Cuenta" className="flex items-center gap-1 sm:gap-2">
            <Button asChild size="sm" variant="ghost">
              <Link to="/login">Iniciar sesión</Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/register">Crear cuenta</Link>
            </Button>
          </nav>
        </div>
      </div>
    </header>
  );
}

function FooterHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-semibold text-foreground">{children}</h2>;
}

const footerLink = "text-sm text-muted-foreground transition-colors hover:text-foreground";

/** `showLogin` is false when the page already knows there is a session (/planes). */
export function PublicFooter({ showLogin = true }: { showLogin?: boolean }) {
  return (
    <footer className="border-t bg-card/40">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        <div className="flex flex-col gap-3">
          <PublicLogo />
          <p className="max-w-xs text-sm text-muted-foreground">
            Automatización de correos para equipos y negocios: reglas, clasificación y entrega a tus clientes.
          </p>
        </div>

        <nav aria-label="Producto" className="flex flex-col gap-2.5">
          <FooterHeading>Producto</FooterHeading>
          <Link to="/planes" className={footerLink}>
            Planes
          </Link>
          <Link to="/contacto" className={footerLink}>
            Contacto
          </Link>
          {showLogin ? (
            <Link to="/login" className={footerLink}>
              Iniciar sesión
            </Link>
          ) : null}
        </nav>

        <nav aria-label="Información legal" className="flex flex-col gap-2.5">
          <FooterHeading>Legal</FooterHeading>
          {PUBLIC_LEGAL_LINKS.map((link) => (
            <Link key={link.to} to={link.to} className={cn(footerLink, "inline-flex items-center gap-1.5")}>
              {link.to === "/libro-de-reclamaciones" ? <BookOpenText className="size-4 shrink-0" aria-hidden /> : null}
              {link.label}
            </Link>
          ))}
        </nav>

        <address className="flex flex-col gap-2.5 not-italic">
          <FooterHeading>Contacto</FooterHeading>
          {LEGAL_CONTACT_EMAIL ? (
            <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} className={cn(footerLink, "inline-flex items-center gap-1.5")}>
              <Mail className="size-4 shrink-0" aria-hidden />
              {LEGAL_CONTACT_EMAIL}
            </a>
          ) : null}
          {LEGAL_CONTACT_PHONE ? (
            <a href={`tel:${LEGAL_CONTACT_PHONE}`} className={cn(footerLink, "inline-flex items-center gap-1.5")}>
              <Phone className="size-4 shrink-0" aria-hidden />
              {LEGAL_CONTACT_PHONE}
            </a>
          ) : null}
          <span className="inline-flex items-start gap-1.5 text-sm text-muted-foreground">
            <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {SERVICE_PUBLIC_ADDRESS.street}
              <br />
              {SERVICE_PUBLIC_ADDRESS.locality}
            </span>
          </span>
        </address>
      </div>
      <div className="border-t">
        <p className="mx-auto w-full max-w-6xl px-4 py-5 text-xs text-muted-foreground sm:px-6">
          © {new Date().getFullYear()} EmailBot
          {SERVICE_OPERATOR ? ` · Titular: ${SERVICE_OPERATOR}` : null}
          {SERVICE_OPERATOR_RUC ? ` · RUC ${SERVICE_OPERATOR_RUC}` : null}
        </p>
      </div>
    </footer>
  );
}

/** Navbar + page + footer for the public pages. */
export function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <PublicHeader />
      <main className="flex-1">{children}</main>
      <PublicFooter />
    </div>
  );
}
