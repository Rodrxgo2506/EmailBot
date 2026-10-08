import { Link } from "react-router-dom";
import { LEGAL_CONTACT_EMAIL } from "./legal-info";
import { ContactDetails, LegalLayout, LegalList, LegalSection } from "./legal-layout";

/*
 * Cancellation, refunds and plan changes (/cambios-devoluciones). Only the commercial decisions defined by the
 * owner: cancellation at any time without prorated refunds; refunds evaluated only for the listed exceptions.
 * No deadlines, percentages or tax procedures that were not defined.
 */

const contact = LEGAL_CONTACT_EMAIL ? <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a> : "nuestros medios de contacto";

export function RefundPolicyPage() {
  return (
    <LegalLayout
      title="Cambios, devoluciones y cancelación"
      documentTitle="Cambios, devoluciones y cancelación · EmailBot"
      summary={
        <p>
          Esta política explica cómo cancelar una suscripción de EmailBot, qué ocurre con el periodo ya pagado y en qué casos se puede evaluar
          una devolución. Forma parte de los <Link to="/terms">Términos y condiciones</Link>.
        </p>
      }
    >
      <LegalSection id="alcance" number={1} title="Alcance">
        <p>
          EmailBot es un servicio digital por suscripción (software como servicio). Se contrata por planes con pago mensual o anual; no
          comercializa productos físicos.
        </p>
      </LegalSection>

      <LegalSection id="cancelacion" number={2} title="Cancelación">
        <LegalList>
          <li>Puedes cancelar tu suscripción en cualquier momento.</li>
          <li>La cancelación evita la siguiente renovación automática: no se realizarán nuevos cobros por esa suscripción.</li>
          <li>Conservas el acceso al servicio hasta que termine el periodo que ya pagaste.</li>
          <li>La cancelación voluntaria durante un periodo ya iniciado no genera una devolución prorrateada de ese periodo.</li>
        </LegalList>
        <p>Para cancelar, escríbenos a {contact} desde el correo de tu cuenta indicando la organización.</p>
      </LegalSection>

      <LegalSection id="devoluciones" number={3} title="Devoluciones y reembolsos">
        <p>La cancelación voluntaria no genera automáticamente un reembolso. Podemos evaluar una devolución cuando corresponda, en casos como:</p>
        <LegalList>
          <li>un cobro duplicado;</li>
          <li>un error atribuible a EmailBot;</li>
          <li>una falla técnica grave atribuible a EmailBot que te impida utilizar el servicio;</li>
          <li>una transacción que no reconoces, después de la verificación correspondiente;</li>
          <li>cuando la ley lo exija.</li>
        </LegalList>
        <p>
          Cada solicitud se revisa de forma individual y te comunicaremos el resultado por el mismo medio por el que la presentaste.
        </p>
      </LegalSection>

      <LegalSection id="cambios-plan" number={4} title="Cambios de plan">
        <p>
          Para cambiar de plan, escríbenos a {contact}. Mientras la contratación en línea no esté disponible, el equipo de EmailBot activa y
          cambia los planes.
        </p>
      </LegalSection>

      <LegalSection id="solicitar" number={5} title="Cómo presentar una solicitud">
        <p>Escríbenos a {contact} e incluye:</p>
        <LegalList>
          <li>el correo de tu cuenta y el nombre de tu organización;</li>
          <li>la fecha y el monto del cobro;</li>
          <li>el motivo de la solicitud y, si la tienes, la evidencia (por ejemplo, el comprobante o el estado de cuenta).</li>
        </LegalList>
        <p>Te responderemos por el mismo medio.</p>
      </LegalSection>

      <LegalSection id="reclamos" number={6} title="Libro de Reclamaciones">
        <p>
          También puedes registrar una queja o un reclamo en nuestro <Link to="/libro-de-reclamaciones">Libro de Reclamaciones virtual</Link>.
        </p>
      </LegalSection>

      <LegalSection id="contacto" number={7} title="Contacto">
        <ContactDetails />
      </LegalSection>
    </LegalLayout>
  );
}
