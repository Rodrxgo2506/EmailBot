import { Link } from "react-router-dom";
import { ContactDetails, LegalLayout, LegalList, LegalSection, Pending } from "./legal-layout";
import { LEGAL_CONTACT_EMAIL, SERVICE_DOMAIN, SERVICE_OPERATOR, SERVICE_OPERATOR_RUC, SERVICE_OPERATOR_TYPE, TERMS_VERSION } from "./legal-info";

/*
 * Public terms of service (3.0). Describes only features and commercial conditions that exist today; online card
 * payment (Culqi) is described as not yet available.
 */
export function TermsPage() {
  const support = LEGAL_CONTACT_EMAIL ? <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a> : "nuestros medios de contacto";

  return (
    <LegalLayout
      title="Términos y condiciones"
      documentTitle="Términos y condiciones | EmailBot"
      version={TERMS_VERSION}
      summary={
        <p>
          Estos términos regulan el uso y la contratación de EmailBot, incluido su portal de clientes. Léelos junto con la{" "}
          <Link to="/privacy" className="font-medium text-primary hover:underline">
            Política de Privacidad
          </Link>{" "}
          y la{" "}
          <Link to="/cambios-devoluciones" className="font-medium text-primary hover:underline">
            política de cambios, devoluciones y cancelación
          </Link>
          .
        </p>
      }
    >
      <LegalSection id="identificacion" number={1} title="Identificación del proveedor">
        <p>
          EmailBot es el nombre del servicio, disponible en {SERVICE_DOMAIN}. Su titular es{" "}
          {SERVICE_OPERATOR ? <strong>{SERVICE_OPERATOR}</strong> : <Pending>nombre legal del titular</Pending>}
          {SERVICE_OPERATOR_TYPE ? `, ${SERVICE_OPERATOR_TYPE.toLowerCase()}` : null}
          {SERVICE_OPERATOR_RUC ? `, con RUC ${SERVICE_OPERATOR_RUC}` : null}.
        </p>
        <ContactDetails />
      </LegalSection>

      <LegalSection id="aceptacion" number={2} title="Aceptación de los términos">
        <p>
          Para crear una cuenta debes aceptar expresamente estos términos y la Política de Privacidad. EmailBot registra
          qué versión de cada documento aceptaste y la fecha. Si tu cuenta se creó de otra forma, o cuando publiquemos
          una nueva versión, te pediremos aceptarla al iniciar sesión, antes de usar el panel. Al usar EmailBot o acceder
          a su portal de clientes también aceptas estos términos. Si los aceptas en nombre de una organización, declaras
          que tienes autoridad para hacerlo. Si no estás de acuerdo, no uses el servicio.
        </p>
      </LegalSection>

      <LegalSection id="servicio" number={3} title="Descripción del servicio">
        <p>EmailBot es una aplicación web que permite a una organización:</p>
        <LegalList>
          <li>conectar sus propias cuentas de correo de Gmail y Microsoft / Outlook mediante OAuth;</li>
          <li>procesar los mensajes nuevos que reciben esas cuentas;</li>
          <li>
            organizar reglas en bots (uno por servicio o proceso) para clasificar los correos, elegir el bot que
            corresponde y extraer información;
          </li>
          <li>registrar a sus clientes finales, con los identificadores que permiten reconocerlos en los correos;</li>
          <li>entregar cada correo a los clientes finales que corresponden, de forma automática o manual;</li>
          <li>dar a esos clientes acceso a un portal donde consultan los correos que se les entregaron;</li>
          <li>consultar los correos procesados en una bandeja centralizada y gestionar sus miembros y roles.</li>
        </LegalList>
        <p>
          La conexión de cuentas IMAP todavía no está disponible. Las funciones pueden evolucionar con el tiempo, como se
          indica en la sección 18.
        </p>
      </LegalSection>

      <LegalSection id="cuenta" number={4} title="Registro, cuenta y responsabilidades del usuario">
        <LegalList>
          <li>Debes proporcionar información veraz al registrarte y mantenerla actualizada.</li>
          <li>Eres responsable de mantener la confidencialidad de tu contraseña y de la actividad realizada con tu cuenta.</li>
          <li>Debes avisarnos sin demora si detectas un uso no autorizado de tu cuenta.</li>
        </LegalList>
      </LegalSection>

      <LegalSection id="organizaciones" number={5} title="Organizaciones, planes y miembros">
        <LegalList>
          <li>Los datos de EmailBot pertenecen a una organización. Quien crea una organización, o a quien EmailBot se la asigna al darla de alta, pasa a ser su propietario.</li>
          <li>
            Los propietarios y administradores pueden añadir o retirar miembros y asignar roles. Cada rol determina qué
            puede ver y hacer cada miembro, incluido el acceso a los correos procesados y a los clientes finales.
          </li>
          <li>La organización es responsable de decidir quién tiene acceso y de revisar los roles asignados.</li>
          <li>
            Cada organización tiene un plan y un estado. EmailBot puede suspender una organización según la sección 19;
            mientras está suspendida no se procesan correos nuevos, sus miembros no pueden operar el panel y su portal
            de clientes no está disponible, pero sus datos se conservan.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection id="planes-precios" number={6} title="Planes, precios y periodicidad">
        <LegalList>
          <li>
            EmailBot se contrata mediante planes. Los planes vigentes, con sus límites, funciones y precios, se publican en la
            página de <Link to="/planes">Planes</Link>.
          </li>
          <li>Los precios están expresados en soles (PEN) e incluyen el IGV.</li>
          <li>Cada plan puede contratarse con periodicidad mensual o anual, según la opción elegida al contratar.</li>
          <li>Para usar las funciones del servicio, la organización necesita una suscripción activa a un plan.</li>
        </LegalList>
      </LegalSection>

      <LegalSection id="duracion-renovacion" number={7} title="Inicio, duración y renovación">
        <LegalList>
          <li>La suscripción comienza cuando se confirma el pago y se activa el plan, y dura el periodo contratado: un mes o un año.</li>
          <li>
            Cuando la suscripción se paga con un medio de pago recurrente, se renueva automáticamente al final de cada periodo, con el
            mismo plan y la misma periodicidad, hasta que la canceles. Antes de contratar se te informa de esta renovación automática.
          </li>
          <li>Cuando el plan se paga de otra forma, su renovación se coordina con el equipo de EmailBot.</li>
        </LegalList>
      </LegalSection>

      <LegalSection id="pagos" number={8} title="Pagos y comprobantes">
        <LegalList>
          <li>
            Mientras la contratación en línea no esté disponible, la contratación y los cambios de plan se coordinan con el equipo de
            EmailBot, que indica los medios de pago aceptados y activa el plan una vez confirmado el pago.
          </li>
          <li>
            Cuando habilitemos el pago en línea con tarjeta, los pagos se procesarán a través de Culqi, nuestro proveedor de pagos. Los
            datos de la tarjeta se ingresan en el formulario seguro de Culqi: EmailBot no recibe ni almacena el número completo de tu
            tarjeta.
          </li>
          <li>EmailBot emitirá el comprobante de pago que corresponda conforme a la normativa aplicable.</li>
        </LegalList>
      </LegalSection>

      <LegalSection id="cancelacion" number={9} title="Cancelación y devoluciones">
        <LegalList>
          <li>Puedes cancelar tu suscripción en cualquier momento; la cancelación evita la siguiente renovación automática.</li>
          <li>Conservas el acceso al servicio hasta que termine el periodo que ya pagaste.</li>
          <li>La cancelación voluntaria durante un periodo ya iniciado no genera una devolución prorrateada.</li>
          <li>
            Las devoluciones no son automáticas: se evalúan solo en los casos previstos en la{" "}
            <Link to="/cambios-devoluciones">política de cambios, devoluciones y cancelación</Link>, como un cobro duplicado o un error
            atribuible a EmailBot.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection id="cuentas-correo" number={10} title="Conexión de cuentas de correo">
        <LegalList>
          <li>
            Solo debes conectar cuentas de correo que te pertenezcan o que estés autorizado a conectar en nombre de la
            organización.
          </li>
          <li>
            Al conectar una cuenta autorizas a EmailBot a leer los mensajes nuevos de su bandeja de entrada con los
            permisos de solo lectura que se muestran en la pantalla del proveedor. EmailBot no envía, modifica ni elimina
            correos en tu cuenta.
          </li>
          <li>
            Cómo se detectan los mensajes nuevos depende del proveedor: Gmail avisa a EmailBot de los cambios del buzón,
            mientras que las cuentas de Microsoft se consultan periódicamente.
          </li>
          <li>
            Los correos procesados quedan visibles para los miembros de la organización según su rol y, si la
            organización lo configura, para los clientes finales a los que se entregan.
          </li>
          <li>
            Puedes desconectar una cuenta en cualquier momento desde EmailBot y retirar la autorización desde tu cuenta
            de Google o Microsoft, como se explica en la Política de Privacidad.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection id="clientes" number={11} title="Clientes finales y portal: responsabilidades de la organización">
        <LegalList>
          <li>
            La organización decide qué clientes finales registra, qué identificadores les asocia, qué bots les asigna y
            qué muestra cada bot en el portal (cuerpo, adjuntos y datos extraídos).
          </li>
          <li>
            La organización es responsable de tener derecho a compartir con cada cliente final los correos que se le
            entregan, de que los identificadores sean correctos y de revisar las entregas: una configuración errónea
            puede mostrar un correo a un cliente que no corresponde.
          </li>
          <li>
            La organización entrega a cada cliente su código de acceso por un medio seguro y debe revocarlo o regenerarlo
            si sospecha que otra persona lo conoce.
          </li>
          <li>La organización atiende las solicitudes de sus clientes finales sobre sus datos.</li>
        </LegalList>
      </LegalSection>

      <LegalSection id="portal" number={12} title="Uso del portal por los clientes finales">
        <LegalList>
          <li>El código de acceso es personal: no lo compartas ni lo publiques. Quien lo tenga puede ver tus correos entregados.</li>
          <li>Usa el portal solo para consultar los correos que la organización te ha entregado.</li>
          <li>
            No intentes adivinar códigos de acceso ni acceder a correos de otros clientes. El portal limita los intentos
            de acceso y bloquea temporalmente los repetidos.
          </li>
          <li>
            La organización que te dio el acceso puede revocarlo o suspenderlo en cualquier momento. Las dudas sobre los
            correos que ves, o sobre tus datos, dirígelas primero a esa organización.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection id="uso-aceptable" number={13} title="Uso aceptable">
        <p>Al usar EmailBot te comprometes a no:</p>
        <LegalList>
          <li>conectar cuentas de terceros sin su autorización ni tratar correos que no tengas derecho a tratar;</li>
          <li>compartir correos con clientes finales sin tener derecho a hacerlo;</li>
          <li>usar el servicio para actividades ilegales, fraudulentas o que vulneren derechos de otras personas;</li>
          <li>intentar acceder a datos de otras organizaciones o de otros clientes, o eludir los controles de acceso y seguridad;</li>
          <li>interferir en el funcionamiento del servicio, sobrecargarlo o automatizar solicitudes abusivas;</li>
          <li>realizar ingeniería inversa del servicio, salvo en la medida en que la ley lo permita expresamente.</li>
        </LegalList>
      </LegalSection>

      <LegalSection id="propiedad" number={14} title="Propiedad intelectual">
        <p>
          EmailBot, su software, su diseño y su marca pertenecen a su titular. Estos términos no te transfieren ningún
          derecho sobre ellos, salvo el derecho a usar el servicio conforme a estos términos.
        </p>
        <p>
          Tú y tu organización conservan todos los derechos sobre sus correos y sobre la configuración que crean. Nos
          concedéis únicamente el permiso necesario para tratarlos con el fin de prestar el servicio.
        </p>
      </LegalSection>

      <LegalSection id="disponibilidad" number={15} title="Disponibilidad del servicio">
        <p>
          Procuramos que EmailBot esté disponible y funcione correctamente, pero no garantizamos un funcionamiento
          ininterrumpido ni libre de errores, ni ofrecemos un acuerdo de nivel de servicio. La disponibilidad y la rapidez
          del procesamiento pueden variar según el proveedor de correo y el mecanismo de sincronización que utiliza (por
          ejemplo, las cuentas de Microsoft se consultan periódicamente y pueden tardar algunos minutos más que las de
          Gmail). El servicio puede verse afectado por mantenimiento, incidencias técnicas o por la disponibilidad de los
          proveedores de los que depende, incluidos Google y Microsoft.
        </p>
      </LegalSection>

      <LegalSection id="responsabilidad" number={16} title="Limitación de responsabilidad">
        <p>
          EmailBot se ofrece «tal cual» y «según disponibilidad». En la medida máxima permitida por la ley aplicable, no
          seremos responsables de daños indirectos, incidentales o consecuentes, ni de la pérdida de datos, beneficios
          u oportunidades derivada del uso o de la imposibilidad de usar el servicio.
        </p>
        <p>
          La clasificación, la extracción de información y la entrega a clientes finales dependen de las reglas, bots e
          identificadores que configura cada organización. Revisa sus resultados antes de tomar decisiones basadas en
          ellos.
        </p>
        <p>Nada de lo anterior limita la responsabilidad que no pueda excluirse según la ley aplicable.</p>
      </LegalSection>

      <LegalSection id="administracion" number={17} title="Administración de la plataforma">
        <p>
          Para operar el servicio, los administradores de EmailBot pueden dar de alta organizaciones, activar o cambiar su
          plan y suspenderlas o reactivarlas. Para ello ven metadatos y estadísticas, no el contenido de los correos, y sus
          acciones quedan registradas, como se explica en la Política de Privacidad.
        </p>
      </LegalSection>

      <LegalSection id="modificaciones" number={18} title="Modificaciones del servicio">
        <p>
          Podemos añadir, cambiar o retirar funciones de EmailBot. Cuando un cambio afecte de forma importante al uso
          del servicio, procuraremos avisar con antelación razonable dentro de la aplicación.
        </p>
      </LegalSection>

      <LegalSection id="terminacion" number={19} title="Suspensión y terminación">
        <LegalList>
          <li>Puedes dejar de usar EmailBot en cualquier momento y solicitar la eliminación de tu usuario u organización por los medios de contacto indicados.</li>
          <li>
            Si la suscripción vence o no se renueva, la organización deja de tener acceso a las funciones del plan hasta que
            vuelva a tener una suscripción activa; sus datos se conservan.
          </li>
          <li>
            Podemos suspender o cerrar el acceso de un usuario, de una organización o de su portal que incumpla estos
            términos o cuando sea necesario para proteger el servicio, a otros usuarios o para cumplir la ley.
          </li>
          <li>Tras la terminación, los datos se tratarán como se describe en la Política de Privacidad.</li>
        </LegalList>
      </LegalSection>

      <LegalSection id="soporte" number={20} title="Soporte">
        <p>
          Para consultas sobre el servicio, tu cuenta, tu plan o tus pagos, escríbenos a {support}. También encontrarás nuestros
          datos en la página de <Link to="/contacto">Contacto</Link>.
        </p>
      </LegalSection>

      <LegalSection id="reclamos" number={21} title="Libro de Reclamaciones">
        <p>
          Puedes registrar una queja o un reclamo en nuestro <Link to="/libro-de-reclamaciones">Libro de Reclamaciones virtual</Link>.
          Responderemos en un plazo no mayor a quince (15) días hábiles. Presentar un reclamo no impide acudir a otras vías de
          solución de controversias ni es requisito previo para interponer una denuncia ante el INDECOPI.
        </p>
      </LegalSection>

      <LegalSection id="cambios" number={22} title="Cambios en los términos">
        <p>
          Podemos actualizar estos términos. Publicaremos la versión vigente en esta página con su número de versión y su
          fecha de actualización, y los miembros deberán aceptarla expresamente para seguir usando el panel.
        </p>
      </LegalSection>

      <LegalSection id="ley-aplicable" number={23} title="Ley aplicable">
        <p>
          Estos términos se rigen e interpretan conforme a la legislación de la República del Perú. Nada en ellos limita
          los derechos que la ley peruana reconoce y que no pueden renunciarse, incluidos los del Código de Protección y
          Defensa del Consumidor.
        </p>
      </LegalSection>

      <LegalSection id="contacto" number={24} title="Contacto">
        <p>Para consultas sobre estos términos:</p>
        <ContactDetails />
      </LegalSection>
    </LegalLayout>
  );
}
