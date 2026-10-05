// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { GMAIL_READONLY_SCOPE, LEGAL_LAST_UPDATED, PORTAL_ATTACHMENT_LINK_SECONDS, PORTAL_SESSION_IDLE_DAYS, PORTAL_SESSION_MAX_DAYS } from "./legal-info";
import { PrivacyPage } from "./privacy-page";
import { TermsPage } from "./terms-page";

/*
 * The public legal pages must describe EmailBot V2 as implemented (Google
 * OAuth verification relies on them): domain, Gmail scope, push
 * notifications, the customer portal (Gmail data shown to the organization's
 * end customers), platform administration without e-mail content.
 */

function text(page: ReactElement): string {
  const { container } = render(<MemoryRouter>{page}</MemoryRouter>);
  return container.textContent ?? "";
}

describe("privacy policy (V2)", () => {
  it("uses the current domain and date, never the old onrender.com host", () => {
    const content = text(<PrivacyPage />);
    expect(content).not.toMatch(/onrender\.com/);
    expect(content).toMatch(/emailbot\.app\/portal/);
    expect(content).toMatch(/api\.emailbot\.app/);
    expect(screen.getAllByText(new RegExp(LEGAL_LAST_UPDATED)).length).toBeGreaterThan(0);
  });

  it("states the read-only Gmail scope, Pub/Sub notifications without content and Limited Use", () => {
    const content = text(<PrivacyPage />);
    expect(content).toContain(GMAIL_READONLY_SCOPE);
    expect(content).toMatch(/Google Cloud Pub\/Sub/);
    expect(content).toMatch(/no el contenido de los mensajes/);
    expect(content).toMatch(/Política de datos de usuario de los servicios de API de Google/);
    expect(content).toMatch(/no se venden ni se usan para publicidad/);
  });

  it("discloses the customer portal: what end customers see, sessions, Access ID and attachment links", () => {
    const content = text(<PrivacyPage />);
    expect(screen.getByRole("heading", { name: /Portal de clientes/ })).toBeInTheDocument();
    expect(content).toMatch(/entrega cada correo a los clientes\s+finales/);
    expect(content).toMatch(/Entregar los correos a los clientes finales que la organización ha configurado/);
    expect(content).toMatch(/solo una huella criptográfica/);
    expect(content).toContain(`${PORTAL_SESSION_IDLE_DAYS} días sin actividad`);
    expect(content).toContain(`${PORTAL_SESSION_MAX_DAYS} días`);
    expect(content).toContain(`${PORTAL_ATTACHMENT_LINK_SECONDS} segundos`);
    expect(content).toMatch(/nunca ve correos de otros clientes/);
  });

  it("describes platform administration as metadata only and the cookies actually used", () => {
    const content = text(<PrivacyPage />);
    expect(content).toMatch(/Administradores de la plataforma EmailBot/);
    expect(content).toMatch(/No ven el contenido de\s+los correos/);
    expect(content).toMatch(/una única cookie técnica de sesión/);
    expect(content).toMatch(/no usa cookies de publicidad ni de analítica/);
  });
});

describe("terms of service (V2)", () => {
  it("covers end customers, the organization's responsibilities and the portal rules", () => {
    const content = text(<TermsPage />);
    expect(content).not.toMatch(/onrender\.com/);
    expect(screen.getByRole("heading", { name: /Clientes finales y portal/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Uso del portal por los clientes finales/ })).toBeInTheDocument();
    expect(content).toMatch(/derecho a compartir con cada cliente final/);
    expect(content).toMatch(/El código de acceso es personal/);
    expect(content).toMatch(/suspenderlas o reactivarlas/);
  });

  it("cross references point to the right sections", () => {
    text(<TermsPage />);
    expect(screen.getByRole("heading", { name: /Modificaciones del servicio/ }).textContent).toMatch(/^13/);
    expect(screen.getByRole("heading", { name: /Suspensión y terminación/ }).textContent).toMatch(/^14/);
  });
});
