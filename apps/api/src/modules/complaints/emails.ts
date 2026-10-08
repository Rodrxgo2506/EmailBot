import { COMPLAINTS_BOOK_PROVIDER as PROVIDER, type ComplaintKind } from "@emailbot/types";
import type { OutgoingEmail } from "../../deps.js";
import type { ComplaintCopy, ComplaintResponseTarget } from "../../repositories/types.js";

/*
 * Libro de Reclamaciones e-mails (Spanish, plain text + HTML):
 *
 * - Copy of the sheet (constancia), right after it is recorded: the Reglamento asks the provider to send the
 *   consumer a copy of the virtual sheet, so it carries every field the consumer filled in, the provider data,
 *   the number and the date. Sent only to the address the consumer wrote on the sheet.
 * - The provider's answer, written by a platform administrator.
 *
 * Every value typed by the consumer or the administrator is escaped in the HTML part (no markup from them is
 * ever rendered). Nothing here is logged.
 */

const LIMA_DATE_TIME = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", dateStyle: "long", timeStyle: "short" });

export const formatLimaDateTime = (iso: string | Date) => LIMA_DATE_TIME.format(typeof iso === "string" ? new Date(iso) : iso);

const kindLabel = (kind: ComplaintKind) => (kind === "QUEJA" ? "Queja" : "Reclamo");
const kindWord = (kind: ComplaintKind) => (kind === "QUEJA" ? "queja" : "reclamo");

const DOCUMENT_LABELS: Record<ComplaintCopy["consumer"]["documentType"], string> = {
  DNI: "DNI",
  CE: "Carné de extranjería",
  PASAPORTE: "Pasaporte",
  RUC: "RUC"
};

const INDECOPI_NOTICE =
  "La formulación del reclamo no impide acudir a otras vías de solución de controversias ni es requisito previo para interponer una denuncia ante el INDECOPI.";
const DEADLINE_NOTICE = "El proveedor deberá dar respuesta al reclamo o queja en un plazo no mayor a quince (15) días hábiles.";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

const multiline = (value: string) => escapeHtml(value).replace(/\r?\n/g, "<br>");

const amount = (cents: number | null) => (cents === null ? "No indicado" : `S/ ${(cents / 100).toFixed(2)}`);

type Field = readonly [label: string, value: string];
interface Section {
  title: string;
  fields: Field[];
}

function htmlLayout(heading: string, intro: string[], sections: Section[], closing: string[]): string {
  const paragraph = (text: string) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#1f2937">${text}</p>`;
  const table = (section: Section) =>
    `<h2 style="margin:24px 0 8px;font-size:15px;color:#111827">${escapeHtml(section.title)}</h2>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px">` +
    section.fields
      .map(
        ([label, value]) =>
          `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top;width:38%">${escapeHtml(label)}</td>` +
          `<td style="padding:6px 0;color:#111827;vertical-align:top">${multiline(value)}</td></tr>`
      )
      .join("") +
    `</table>`;

  return [
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>`,
    `<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif">`,
    `<div style="max-width:640px;margin:0 auto;padding:24px 16px">`,
    `<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">`,
    `<p style="margin:0 0 4px;font-size:13px;font-weight:bold;color:#1d4ed8">${escapeHtml(PROVIDER.tradeName)} · Libro de Reclamaciones</p>`,
    `<h1 style="margin:0 0 16px;font-size:20px;color:#111827">${escapeHtml(heading)}</h1>`,
    ...intro.map(paragraph),
    ...sections.map(table),
    `<div style="margin-top:24px">`,
    ...closing.map(paragraph),
    `</div></div>`,
    `<p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:#6b7280;text-align:center">`,
    `${escapeHtml(PROVIDER.tradeName)} · ${escapeHtml(PROVIDER.holder)} · RUC ${escapeHtml(PROVIDER.ruc)}<br>`,
    `${escapeHtml(PROVIDER.address)} · <a href="mailto:${PROVIDER.supportEmail}" style="color:#1d4ed8">${PROVIDER.supportEmail}</a>`,
    `</p></div></body></html>`
  ].join("");
}

function textLayout(heading: string, intro: string[], sections: Section[], closing: string[]): string {
  const lines = [`${PROVIDER.tradeName} · Libro de Reclamaciones`, "", heading, "", ...intro.flatMap((line) => [line, ""])];
  for (const section of sections) {
    lines.push(section.title.toUpperCase());
    for (const [label, value] of section.fields) lines.push(`${label}: ${value}`);
    lines.push("");
  }
  lines.push(...closing.flatMap((line) => [line, ""]));
  lines.push("--", `${PROVIDER.tradeName} · ${PROVIDER.holder} · RUC ${PROVIDER.ruc}`, PROVIDER.address, PROVIDER.supportEmail);
  return lines.join("\n");
}

/** Copy of the recorded sheet (constancia) for the consumer. */
export function complaintCopyEmail(copy: ComplaintCopy): OutgoingEmail {
  const registeredAt = formatLimaDateTime(copy.createdAt);
  const consumer = copy.consumer;
  const sections: Section[] = [
    {
      title: "Datos del registro",
      fields: [
        ["Número de registro", copy.code],
        ["Tipo", kindLabel(copy.kind)],
        ["Fecha de registro", registeredAt],
        ["Proveedor", `${PROVIDER.holder} (${PROVIDER.tradeName})`],
        ["RUC", PROVIDER.ruc],
        ["Dirección del proveedor", PROVIDER.address]
      ]
    },
    {
      title: "1. Consumidor reclamante",
      fields: [
        ["Nombres y apellidos", `${consumer.firstNames} ${consumer.lastNames}`],
        ["Documento", `${DOCUMENT_LABELS[consumer.documentType]} ${consumer.documentNumber}`],
        ["Domicilio", consumer.address],
        ["Teléfono", consumer.phone],
        ["Correo electrónico", consumer.email],
        ...(consumer.isMinor && consumer.guardianName ? ([["Padre, madre o apoderado (menor de edad)", consumer.guardianName]] as Field[]) : [])
      ]
    },
    {
      title: "2. Bien contratado",
      fields: [
        ["Tipo", copy.good.type === "PRODUCTO" ? "Producto" : "Servicio"],
        ["Descripción", copy.good.description],
        ["Monto reclamado", amount(copy.good.claimedAmountCents)]
      ]
    },
    {
      title: "3. Detalle de la reclamación y pedido del consumidor",
      fields: [
        ["Tipo", kindLabel(copy.kind)],
        ["Detalle", copy.detail],
        ["Pedido", copy.consumerRequest]
      ]
    }
  ];
  const heading = `Recibimos tu ${kindWord(copy.kind)} ${copy.code}`;
  const intro = [
    `Confirmamos la recepción de tu ${kindWord(copy.kind)} en el Libro de Reclamaciones de ${PROVIDER.tradeName}. Este correo es la copia de tu hoja de reclamación.`,
    `Conserva el número de registro ${copy.code}: lo necesitarás para cualquier consulta sobre tu caso.`
  ];
  const closing = [
    `Te responderemos a este correo electrónico en un plazo no mayor a quince (15) días hábiles.`,
    INDECOPI_NOTICE,
    `Si tienes dudas, escríbenos a ${PROVIDER.supportEmail} indicando tu número de registro.`
  ];
  const closingHtml = [
    escapeHtml(closing[0]!),
    escapeHtml(INDECOPI_NOTICE),
    `Si tienes dudas, escríbenos a <a href="mailto:${PROVIDER.supportEmail}" style="color:#1d4ed8">${PROVIDER.supportEmail}</a> indicando tu número de registro.`
  ];

  return {
    to: consumer.email,
    subject: `Constancia de tu ${kindWord(copy.kind)} ${copy.code} · Libro de Reclamaciones de ${PROVIDER.tradeName}`,
    html: htmlLayout(heading, intro.map(escapeHtml), sections, closingHtml),
    text: textLayout(heading, intro, sections, closing),
    idempotencyKey: copy.idempotencyKey,
    category: "complaint_copy"
  };
}

/**
 * The provider's answer to a sheet. Built ONLY from the stored answer operation (text, date fixed when the
 * operation started, key) and the stored sheet: every retry of the operation produces the same bytes, so the
 * provider's idempotency key deduplicates it. Never use the current time here.
 */
export function complaintResponseEmail(target: ComplaintResponseTarget): OutgoingEmail {
  const response = target.response;
  const heading = `Respuesta a tu ${kindWord(target.kind)} ${target.code}`;
  const sections: Section[] = [
    {
      title: "Datos del registro",
      fields: [
        ["Número de registro", target.code],
        ["Tipo", kindLabel(target.kind)],
        ["Fecha de registro", formatLimaDateTime(target.createdAt)],
        ["Fecha de respuesta", formatLimaDateTime(target.preparedAt)]
      ]
    },
    { title: "Respuesta del proveedor", fields: [["Respuesta", response]] }
  ];
  const intro = [
    `Hola, ${target.firstNames}:`,
    `Esta es la respuesta de ${PROVIDER.tradeName} a tu ${kindWord(target.kind)} registrado en nuestro Libro de Reclamaciones con el número ${target.code}.`
  ];
  const closing = [DEADLINE_NOTICE, INDECOPI_NOTICE, `Si tienes dudas sobre esta respuesta, escríbenos a ${PROVIDER.supportEmail} indicando tu número de registro.`];
  const closingHtml = [
    escapeHtml(DEADLINE_NOTICE),
    escapeHtml(INDECOPI_NOTICE),
    `Si tienes dudas sobre esta respuesta, escríbenos a <a href="mailto:${PROVIDER.supportEmail}" style="color:#1d4ed8">${PROVIDER.supportEmail}</a> indicando tu número de registro.`
  ];

  return {
    to: target.email,
    subject: `Respuesta a tu ${kindWord(target.kind)} ${target.code} · Libro de Reclamaciones de ${PROVIDER.tradeName}`,
    html: htmlLayout(heading, intro.map(escapeHtml), sections, closingHtml),
    text: textLayout(heading, intro, sections, closing),
    idempotencyKey: target.idempotencyKey,
    category: "complaint_response"
  };
}
