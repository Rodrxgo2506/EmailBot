// @vitest-environment jsdom
import { CURRENT_LEGAL_VERSIONS } from "@emailbot/types";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_MAX_MB,
  GMAIL_READONLY_SCOPE,
  LEGAL_CONTACT_EMAIL,
  LEGAL_CONTACT_PHONE,
  LEGAL_LAST_UPDATED,
  MICROSOFT_SCOPES,
  PORTAL_ATTACHMENT_LINK_SECONDS,
  PORTAL_SESSION_IDLE_DAYS,
  PORTAL_SESSION_MAX_DAYS,
  PRIVACY_VERSION,
  QUEUE_COMPLETED_HOURS,
  QUEUE_FAILED_DAYS,
  SERVICE_FISCAL_ADDRESS,
  SERVICE_OPERATOR,
  SERVICE_OPERATOR_RUC,
  TERMS_VERSION
} from "./legal-info";
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

/* ------------------------------------------------------------------ corrections after the legal audit */

// Repository root from this file (src/features/legal -> apps/web -> repo); the web app does not depend on @emailbot/shared.
const source = (path: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../..", path), "utf8");

describe("legal-info matches the code it describes", () => {
  it("scopes, queue retention, attachment link lifetime and attachment size come from the real configuration", () => {
    const oauth = source("packages/shared/src/oauth.ts");
    expect(oauth).toContain(`"${GMAIL_READONLY_SCOPE}"`);
    for (const scope of MICROSOFT_SCOPES) expect(oauth).toMatch(new RegExp(`"[^"]*${scope}"`));
    const queues = source("packages/shared/src/queues.ts");
    expect(queues).toContain(`removeOnComplete: { age: ${QUEUE_COMPLETED_HOURS} * 3600`);
    expect(queues).toContain(`removeOnFail: { age: ${QUEUE_FAILED_DAYS} * 24 * 3600 }`);
    expect(source("packages/shared/src/storage.ts")).toContain(`ATTACHMENT_URL_TTL_SECONDS = ${PORTAL_ATTACHMENT_LINK_SECONDS};`);
    expect(source("apps/worker/src/config/env.ts")).toContain(`WORKER_MAX_ATTACHMENT_BYTES: z.coerce.number().int().min(0).default(${ATTACHMENT_MAX_MB} * 1024 * 1024)`);
  });
});

describe("privacy policy: precise statements", () => {
  it("attachments: metadata always, content only with the organization's option, outside the body and within the size limit", () => {
    const content = text(<PrivacyPage />);
    expect(content).toMatch(/Su contenido solo se guarda si la\s+organización tiene activada la opción «Guardar adjuntos»/);
    expect(content).toContain(`${ATTACHMENT_MAX_MB} MB`);
  });

  it("queues, audit logs, logs and no automatic deletion by age", () => {
    const content = text(<PrivacyPage />);
    expect(content).toContain(`hasta ${QUEUE_COMPLETED_HOURS} horas los completados y hasta ${QUEUE_FAILED_DAYS} días los que fallaron`);
    expect(content).toMatch(/la base de datos impide modificarlos o borrarlos/);
    expect(content).toMatch(/su identificación como autor se elimina del registro/);
    expect(content).toMatch(/EmailBot no elimina\s+correos automáticamente por su antigüedad/);
    expect(content).toMatch(/No guardan contraseñas, tokens ni el contenido de los correos/);
  });

  it("data location: Supabase in the United States (Oregon), Render and Cloudflare outside Peru, no invented Render region", () => {
    const content = text(<PrivacyPage />);
    expect(screen.getByRole("heading", { name: /Ubicación de los datos y transferencias internacionales/ })).toBeInTheDocument();
    expect(content).toMatch(/Supabase, en Estados Unidos \(región de Oregón\)/);
    expect(content).toMatch(/Render, fuera del Perú/);
    expect(content).toMatch(/Cloudflare/);
  });

  it("Microsoft is polled (no push), with its real scopes", () => {
    const content = text(<PrivacyPage />);
    for (const scope of MICROSOFT_SCOPES) expect(content).toContain(scope);
    expect(content).toMatch(/En las cuentas de Microsoft\s+no recibe avisos de mensajes nuevos: las consulta periódicamente/);
  });

  it("identifies the holder with the RUC data and shows no address while SUNAT has none", () => {
    const content = text(<PrivacyPage />);
    expect(content).toContain(SERVICE_OPERATOR as string);
    expect(content).toContain(`RUC ${SERVICE_OPERATOR_RUC}`);
    expect(content).toContain(LEGAL_CONTACT_PHONE as string);
    expect(content).toContain(LEGAL_CONTACT_EMAIL as string);
    expect(SERVICE_FISCAL_ADDRESS).toBeNull();
    expect(content).not.toMatch(/Domicilio fiscal/);
    expect(content).not.toMatch(/Pendiente de completar/);
    expect(content).toContain(`Versión ${PRIVACY_VERSION}`);
  });
});

describe("acceptance of the legal documents is described as implemented", () => {
  it("privacy: the acceptance record (version, server time) is a collected datum, unmodifiable while the account exists, deleted with the user", () => {
    const content = text(<PrivacyPage />);
    expect(content).toMatch(/la versión de cada documento que\s+aceptaste y la fecha y hora en que lo hiciste, registradas por nuestros servidores/);
    expect(content).toMatch(/no se pueden modificar mientras exista tu cuenta y se\s+eliminan junto con tu usuario/);
    expect(content).toMatch(/los miembros deberán aceptarla para seguir usando el panel/);
    expect(content).not.toMatch(/inmutable|append-only/i);
  });

  it("terms: a new version or an account created elsewhere is accepted at login; continuing to use is no longer acceptance", () => {
    const content = text(<TermsPage />);
    expect(content).toMatch(/te pediremos aceptarla al iniciar sesión, antes de usar el panel/);
    expect(content).toMatch(/los miembros deberán aceptarla expresamente para seguir usando el panel/);
    expect(content).not.toMatch(/Si sigues usando EmailBot después de un cambio/);
  });

  it("the versions shown on the pages are the ones the API records (single source in @emailbot/types)", () => {
    expect(TERMS_VERSION).toBe(CURRENT_LEGAL_VERSIONS.terms);
    expect(PRIVACY_VERSION).toBe(CURRENT_LEGAL_VERSIONS.privacy);
    expect(source("apps/web/src/features/legal/legal-info.ts")).not.toMatch(/_VERSION = "/);
  });
});

describe("terms of service: precise statements", () => {
  it("explicit, recorded acceptance at sign-up; Peruvian law without an invented court; no absolute real-time promise", () => {
    const content = text(<TermsPage />);
    expect(content).toMatch(/Para crear una cuenta debes aceptar expresamente estos términos y la Política de Privacidad/);
    expect(content).toMatch(/registra\s+qué versión de cada documento aceptaste y la fecha/);
    expect(screen.getByRole("heading", { name: /Ley aplicable/ })).toBeInTheDocument();
    expect(content).toMatch(/legislación de la República del Perú/);
    expect(content).not.toMatch(/tribunal|juzgado|Lima/i);
    expect(content).not.toMatch(/casi en tiempo real/);
    expect(content).toMatch(/pueden variar según el proveedor de correo y el mecanismo de sincronización/);
    expect(content).toContain(`Versión ${TERMS_VERSION}`);
    expect(content).toContain(`RUC ${SERVICE_OPERATOR_RUC}`);
  });

  it("does not introduce monetization content yet", () => {
    const content = text(<TermsPage />);
    expect(content).not.toMatch(/precio|reembolso|devoluci|Culqi|Libro de Reclamaciones|suscripci/i);
  });
});
