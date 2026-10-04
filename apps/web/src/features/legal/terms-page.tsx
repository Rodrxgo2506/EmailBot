import { Link } from "react-router-dom";
import { ContactDetails, LegalLayout, LegalList, LegalSection, Pending } from "./legal-layout";
import { LEGAL_CONTACT_EMAIL, SERVICE_OPERATOR } from "./legal-info";

/* Public terms of service. Describes only features that exist today. */
export function TermsPage() {
  return (
    <LegalLayout
      title="Términos de Servicio"
      documentTitle="Términos de Servicio | EmailBot"
      summary={
        <p>
          Estos términos regulan el uso de EmailBot. Léelos junto con la{" "}
          <Link to="/privacy" className="font-medium text-primary hover:underline">
            Política de Privacidad
          </Link>
          , que explica cómo tratamos la información.
        </p>
      }
    >
      <LegalSection id="aceptacion" number={1} title="Aceptación de los términos">
        <p>
          Al crear una cuenta o usar EmailBot aceptas estos términos. Si los aceptas en nombre de una organización,
          declaras que tienes autoridad para hacerlo. Si no estás de acuerdo, no uses el servicio.
        </p>
        <p>
          El servicio es proporcionado por{" "}
          {SERVICE_OPERATOR ? <strong>{SERVICE_OPERATOR}</strong> : <Pending>nombre legal del titular de EmailBot</Pending>}.
        </p>
      </LegalSection>

      <LegalSection id="servicio" number={2} title="Descripción del servicio">
        <p>EmailBot es una aplicación web que permite a una organización:</p>
        <LegalList>
          <li>conectar sus propias cuentas de correo de Gmail y Microsoft / Outlook mediante OAuth;</li>
          <li>procesar los mensajes nuevos que reciben esas cuentas;</li>
          <li>aplicar reglas configurables para clasificar los correos en categorías y extraer información;</li>
          <li>consultar los correos procesados en una bandeja centralizada;</li>
          <li>gestionar los miembros de la organización y sus roles.</li>
        </LegalList>
        <p>
          El registro de cuentas IMAP está disponible, pero su sincronización todavía no lo está. Las funciones pueden
          evolucionar con el tiempo, como se indica en la sección 10.
        </p>
      </LegalSection>

      <LegalSection id="cuenta" number={3} title="Cuenta y responsabilidades del usuario">
        <LegalList>
          <li>Debes proporcionar información veraz al registrarte y mantenerla actualizada.</li>
          <li>Eres responsable de mantener la confidencialidad de tu contraseña y de la actividad realizada con tu cuenta.</li>
          <li>Debes avisarnos sin demora si detectas un uso no autorizado de tu cuenta.</li>
        </LegalList>
      </LegalSection>

      <LegalSection id="organizaciones" number={4} title="Organizaciones y miembros">
        <LegalList>
          <li>Los datos de EmailBot pertenecen a una organización. Quien crea una organización pasa a ser su propietario.</li>
          <li>
            Los propietarios y administradores pueden añadir o retirar miembros y asignar roles. Cada rol determina qué
            puede ver y hacer cada miembro, incluido el acceso a los correos procesados.
          </li>
          <li>La organización es responsable de decidir quién tiene acceso y de revisar los roles asignados.</li>
        </LegalList>
      </LegalSection>

      <LegalSection id="cuentas-correo" number={5} title="Conexión de cuentas de correo">
        <LegalList>
          <li>
            Solo debes conectar cuentas de correo que te pertenezcan o que estés autorizado a conectar en nombre de la
            organización.
          </li>
          <li>
            Al conectar una cuenta autorizas a EmailBot a leer los mensajes nuevos de su bandeja de entrada con los
            permisos de solo lectura que se muestran en la pantalla del proveedor. EmailBot no envía, modifica ni
            elimina correos en tu cuenta.
          </li>
          <li>
            Los correos procesados quedan visibles para los miembros de la organización según su rol. Asegúrate de que
            compartir ese contenido con ellos es apropiado.
          </li>
          <li>
            Puedes desconectar una cuenta en cualquier momento desde EmailBot y retirar la autorización desde tu cuenta
            de Google o Microsoft, como se explica en la Política de Privacidad.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection id="uso-aceptable" number={6} title="Uso aceptable">
        <p>Al usar EmailBot te comprometes a no:</p>
        <LegalList>
          <li>conectar cuentas de terceros sin su autorización ni tratar correos que no tengas derecho a tratar;</li>
          <li>usar el servicio para actividades ilegales, fraudulentas o que vulneren derechos de otras personas;</li>
          <li>intentar acceder a datos de otras organizaciones o eludir los controles de acceso y seguridad;</li>
          <li>interferir en el funcionamiento del servicio, sobrecargarlo o automatizar solicitudes abusivas;</li>
          <li>realizar ingeniería inversa del servicio, salvo en la medida en que la ley lo permita expresamente.</li>
        </LegalList>
      </LegalSection>

      <LegalSection id="propiedad" number={7} title="Propiedad intelectual">
        <p>
          EmailBot, su software, su diseño y su marca pertenecen a su titular. Estos términos no te transfieren ningún
          derecho sobre ellos, salvo el derecho a usar el servicio conforme a estos términos.
        </p>
        <p>
          Tú y tu organización conservan todos los derechos sobre sus correos y sobre la configuración que crean. Nos
          concedéis únicamente el permiso necesario para tratarlos con el fin de prestar el servicio.
        </p>
      </LegalSection>

      <LegalSection id="disponibilidad" number={8} title="Disponibilidad del servicio">
        <p>
          Procuramos que EmailBot esté disponible y funcione correctamente, pero no garantizamos un funcionamiento
          ininterrumpido ni libre de errores, ni ofrecemos un acuerdo de nivel de servicio. El servicio puede verse
          afectado por mantenimiento, incidencias técnicas o por la disponibilidad de los proveedores de los que
          depende, incluidos Google y Microsoft.
        </p>
      </LegalSection>

      <LegalSection id="responsabilidad" number={9} title="Limitación de responsabilidad">
        <p>
          EmailBot se ofrece «tal cual» y «según disponibilidad». En la medida máxima permitida por la ley aplicable, no
          seremos responsables de daños indirectos, incidentales o consecuentes, ni de la pérdida de datos, beneficios
          u oportunidades derivada del uso o de la imposibilidad de usar el servicio.
        </p>
        <p>
          La clasificación y la extracción de información dependen de las reglas que configura cada organización.
          Revisa sus resultados antes de tomar decisiones basadas en ellos.
        </p>
        <p>Nada de lo anterior limita la responsabilidad que no pueda excluirse según la ley aplicable.</p>
      </LegalSection>

      <LegalSection id="modificaciones" number={10} title="Modificaciones del servicio">
        <p>
          Podemos añadir, cambiar o retirar funciones de EmailBot. Cuando un cambio afecte de forma importante al uso
          del servicio, procuraremos avisar con antelación razonable dentro de la aplicación.
        </p>
      </LegalSection>

      <LegalSection id="terminacion" number={11} title="Terminación de cuentas">
        <LegalList>
          <li>Puedes dejar de usar EmailBot en cualquier momento y solicitar la eliminación de tu usuario u organización por los medios de contacto indicados.</li>
          <li>
            Podemos suspender o cerrar el acceso de un usuario u organización que incumpla estos términos o cuando sea
            necesario para proteger el servicio, a otros usuarios o para cumplir la ley.
          </li>
          <li>Tras la terminación, los datos se tratarán como se describe en la Política de Privacidad.</li>
        </LegalList>
      </LegalSection>

      <LegalSection id="cambios" number={12} title="Cambios en los términos">
        <p>
          Podemos actualizar estos términos. Publicaremos la versión vigente en esta página con su fecha de
          actualización. Si sigues usando EmailBot después de un cambio, aceptas los términos actualizados.
        </p>
      </LegalSection>

      <LegalSection id="contacto" number={13} title="Contacto">
        <p>Para consultas sobre estos términos:</p>
        <ContactDetails email={LEGAL_CONTACT_EMAIL} operator={SERVICE_OPERATOR} />
      </LegalSection>
    </LegalLayout>
  );
}
