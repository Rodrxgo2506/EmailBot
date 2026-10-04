import { ContactDetails, LegalLayout, LegalList, LegalSection, LegalSubheading, Pending } from "./legal-layout";
import { GMAIL_READONLY_SCOPE, LEGAL_CONTACT_EMAIL, SERVICE_OPERATOR } from "./legal-info";

/*
 * Public privacy policy. Every statement must match the current
 * implementation (scopes, storage, deletion): update it together with the code.
 */
export function PrivacyPage() {
  return (
    <LegalLayout
      title="Política de Privacidad"
      documentTitle="Política de Privacidad | EmailBot"
      summary={
        <p>
          Esta política explica qué información trata EmailBot, para qué la utiliza, cómo la protege, con quién la
          comparte y qué opciones tienes sobre ella, incluido el acceso a cuentas de Gmail mediante OAuth.
        </p>
      }
    >
      <LegalSection id="introduccion" number={1} title="Introducción">
        <p>
          EmailBot es una aplicación web que permite a una organización conectar sus propias cuentas de correo,
          procesar los mensajes que reciben, aplicar reglas configurables para clasificarlos y extraer información, y
          consultar los resultados en una bandeja centralizada compartida con los miembros de la organización.
        </p>
        <p>
          El servicio es proporcionado por{" "}
          {SERVICE_OPERATOR ? <strong>{SERVICE_OPERATOR}</strong> : <Pending>nombre legal del titular de EmailBot</Pending>}{" "}
          (en adelante, «EmailBot», «nosotros»). Esta política se aplica a la aplicación disponible en
          emailbot-web.onrender.com y a los servicios de servidor que la acompañan.
        </p>
      </LegalSection>

      <LegalSection id="informacion" number={2} title="Información que recopilamos">
        <LegalSubheading>Cuenta y perfil</LegalSubheading>
        <LegalList>
          <li>Dirección de correo electrónico y contraseña con las que te registras. La contraseña la gestiona el servicio de autenticación; EmailBot no la guarda en sus propias tablas.</li>
          <li>Datos de perfil, como tu nombre.</li>
        </LegalList>

        <LegalSubheading>Organización</LegalSubheading>
        <LegalList>
          <li>Nombre y configuración de las organizaciones que creas o a las que perteneces.</li>
          <li>Miembros de cada organización y el rol asignado a cada uno.</li>
          <li>Categorías, reglas de procesamiento y reglas de extracción que la organización configura.</li>
        </LegalList>

        <LegalSubheading>Cuentas de correo conectadas</LegalSubheading>
        <LegalList>
          <li>Proveedor, dirección de correo, nombre visible y estado de cada cuenta conectada.</li>
          <li>Credenciales de acceso del proveedor (tokens OAuth o, en cuentas IMAP, la contraseña indicada), siempre almacenadas cifradas en el servidor.</li>
          <li>Información técnica de sincronización, como el punto desde el que deben leerse los mensajes nuevos.</li>
        </LegalList>

        <LegalSubheading>Correos procesados</LegalSubheading>
        <LegalList>
          <li>
            De cada mensaje que EmailBot procesa: remitente, destinatarios, asunto, fecha, un fragmento, el cuerpo en
            texto y HTML y un conjunto limitado de cabeceras técnicas.
          </li>
          <li>Resultados del procesamiento: categoría asignada, regla aplicada e información extraída por las reglas.</li>
          <li>
            Archivos adjuntos: sus metadatos (nombre, tipo y tamaño) y su contenido, cuando no superan el tamaño máximo
            configurado en el servicio.
          </li>
        </LegalList>

        <LegalSubheading>Auditoría y datos técnicos</LegalSubheading>
        <LegalList>
          <li>
            Registros de auditoría de la organización: acciones como inicios de sesión, conexión o desconexión de
            cuentas y creación, modificación o eliminación de recursos, con el usuario que las realizó y la fecha.
          </li>
          <li>
            Datos técnicos necesarios para el funcionamiento y la seguridad, como la dirección IP y los datos de cada
            solicitud en los registros del servidor y en el control de frecuencia de solicitudes.
          </li>
          <li>
            Datos guardados en tu navegador para mantener la sesión iniciada y recordar la organización activa.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection id="gmail" number={3} title="Acceso a cuentas de correo">
        <p>
          Tú decides qué cuentas de correo conectar. EmailBot solo accede a una cuenta después de que un usuario con
          permisos en la organización la conecta y el titular de la cuenta lo autoriza en la pantalla de su proveedor.
        </p>

        <LegalSubheading>Gmail</LegalSubheading>
        <LegalList>
          <li>La conexión se realiza mediante OAuth de Google. EmailBot nunca ve ni guarda tu contraseña de Google.</li>
          <li>
            EmailBot solicita únicamente el permiso de solo lectura{" "}
            <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8rem]">{GMAIL_READONLY_SCOPE}</code>.
            Con él, EmailBot puede leer mensajes, pero no puede enviar, modificar ni eliminar correos de tu cuenta.
          </li>
          <li>
            EmailBot lee los mensajes nuevos que llegan a la bandeja de entrada a partir de la conexión, para procesarlos
            según las reglas de la organización.
          </li>
        </LegalList>

        <LegalSubheading>Microsoft / Outlook</LegalSubheading>
        <p>
          La conexión se realiza mediante OAuth de Microsoft con permisos de lectura de correo (Mail.Read), lectura del
          perfil básico (User.Read) y acceso sin conexión (offline_access) para seguir procesando mensajes nuevos sin
          que tengas que volver a iniciar sesión.
        </p>

        <LegalSubheading>Credenciales y tokens</LegalSubheading>
        <LegalList>
          <li>
            Los tokens OAuth se guardan y se usan solo en el servidor, cifrados con AES-256-GCM. Nunca se envían al
            navegador ni se muestran en la aplicación.
          </li>
          <li>Solo los componentes de servidor de EmailBot los descifran, y únicamente para leer el correo autorizado.</li>
        </LegalList>

        <LegalSubheading>Desconectar una cuenta</LegalSubheading>
        <LegalList>
          <li>
            Desde la sección Cuentas de correo, un usuario con permisos puede desconectar una cuenta. Al hacerlo,
            EmailBot borra las credenciales guardadas y deja de procesar mensajes de esa cuenta.
          </li>
          <li>
            Los correos ya procesados se conservan hasta que se elimina la cuenta desconectada desde EmailBot, lo que
            borra también sus correos y adjuntos almacenados.
          </li>
          <li>
            Actualmente EmailBot no revoca la autorización en el proveedor al desconectar. Puedes retirar el acceso en
            cualquier momento desde tu cuenta de Google (
            <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer noopener">
              myaccount.google.com/permissions
            </a>
            ) o desde la configuración de tu cuenta Microsoft.
          </li>
        </LegalList>

        <LegalSubheading>Uso limitado de los datos de Google</LegalSubheading>
        <p>
          El uso y la transferencia a cualquier otra aplicación de la información recibida de las API de Google se
          ajustan a la{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer noopener">
            Política de datos de usuario de los servicios de API de Google
          </a>
          , incluidos sus requisitos de uso limitado. En particular, los datos de Gmail:
        </p>
        <LegalList>
          <li>se usan solo para ofrecer las funciones de EmailBot que el usuario ve y configura;</li>
          <li>no se venden ni se usan para publicidad;</li>
          <li>no se transfieren a terceros, salvo a los proveedores técnicos necesarios para prestar el servicio o cuando lo exija la ley;</li>
          <li>
            no son leídos por personas del equipo de EmailBot, salvo con tu consentimiento, cuando sea necesario por
            motivos de seguridad o legales, o para investigar un problema técnico que nos hayas pedido resolver.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection id="uso" number={4} title="Cómo usamos la información">
        <LegalList>
          <li>Autenticarte y mantener tu sesión.</li>
          <li>Crear y mantener tu organización, sus miembros y sus roles.</li>
          <li>Procesar los correos de las cuentas que la organización ha conectado y autorizado.</li>
          <li>Aplicar las reglas configuradas, clasificar los correos y extraer la información que esas reglas indican.</li>
          <li>Mostrar los resultados dentro de EmailBot a los miembros de la organización, según su rol.</li>
          <li>Mantener la seguridad del servicio, registrar la actividad en el historial de auditoría, prevenir abusos y resolver errores.</li>
        </LegalList>
        <p>No usamos la información para publicidad ni la vendemos.</p>
      </LegalSection>

      <LegalSection id="seguridad" number={5} title="Almacenamiento y seguridad">
        <LegalList>
          <li>Los datos de la aplicación, la autenticación y los archivos adjuntos se almacenan en Supabase (base de datos, autenticación y almacenamiento de archivos).</li>
          <li>El procesamiento de correos lo realizan componentes de servidor de EmailBot alojados en Render.</li>
          <li>Los tokens OAuth y las credenciales de correo se guardan cifrados y solo se usan en el servidor.</li>
          <li>
            Cada organización está aislada de las demás: el acceso se controla por roles en la aplicación y con
            políticas de seguridad a nivel de fila en la base de datos.
          </li>
          <li>Las comunicaciones con la aplicación se realizan mediante HTTPS.</li>
        </LegalList>
        <p>
          Aplicamos medidas razonables para proteger la información, pero ningún sistema es completamente seguro y no
          podemos garantizar una seguridad absoluta.
        </p>
      </LegalSection>

      <LegalSection id="comparticion" number={6} title="Compartición de información">
        <p>
          Dentro de una organización, los correos procesados y sus resultados son visibles para sus miembros según el
          rol de cada uno. Fuera de ella, solo compartimos información con los proveedores técnicos necesarios para
          operar el servicio:
        </p>
        <LegalList>
          <li><strong>Supabase</strong>: base de datos, autenticación y almacenamiento de archivos.</li>
          <li><strong>Render</strong>: alojamiento de la aplicación web, el servidor y los procesos de procesamiento.</li>
          <li><strong>Google</strong>: cuando conectas una cuenta de Gmail, para autorizar el acceso y leer los mensajes.</li>
          <li><strong>Microsoft</strong>: cuando conectas una cuenta de Microsoft / Outlook, con el mismo fin.</li>
          <li>Otros proveedores técnicos estrictamente necesarios para la infraestructura, como servicios de monitorización de errores cuando están habilitados.</li>
        </LegalList>
        <p>También podremos revelar información cuando la ley lo exija. No vendemos información personal.</p>
      </LegalSection>

      <LegalSection id="retencion" number={7} title="Retención y eliminación">
        <p>
          No aplicamos plazos de retención fijos. La información se conserva mientras es necesaria para prestar el
          servicio a tu organización:
        </p>
        <LegalList>
          <li>Los correos procesados se conservan hasta que se eliminan desde EmailBot, ya sea individualmente o al eliminar la cuenta de correo desconectada a la que pertenecen, junto con sus adjuntos.</li>
          <li>Las credenciales de una cuenta de correo se borran al desconectarla.</li>
          <li>Los datos temporales de procesamiento en cola se eliminan automáticamente tras un período breve.</li>
        </LegalList>
        <p>
          La aplicación todavía no permite eliminar por tu cuenta tu usuario ni una organización completa. Puedes
          solicitarlo por los medios de contacto indicados más abajo, y lo atenderemos conforme a las capacidades del
          servicio y a las obligaciones legales aplicables. Las copias de seguridad de nuestros proveedores pueden
          conservar datos durante un tiempo limitado según sus propias políticas.
        </p>
      </LegalSection>

      <LegalSection id="derechos" number={8} title="Tus derechos">
        <LegalList>
          <li><strong>Acceso</strong>: puedes consultar dentro de EmailBot la información de tu perfil, tu organización y los correos procesados a los que tu rol da acceso.</li>
          <li><strong>Corrección</strong>: puedes actualizar tu nombre y tu contraseña desde tu perfil, y los administradores pueden modificar los datos de la organización.</li>
          <li><strong>Eliminación</strong>: puedes eliminar correos y cuentas de correo desconectadas según tu rol, y solicitar la eliminación de tu usuario u organización.</li>
          <li><strong>Revocación</strong>: puedes desconectar una cuenta de correo en EmailBot y retirar el acceso desde tu cuenta de Google o Microsoft.</li>
          <li><strong>Consultas</strong>: puedes enviarnos cualquier pregunta sobre privacidad a través del contacto indicado.</li>
        </LegalList>
        <p>Según tu lugar de residencia, la ley puede reconocerte otros derechos sobre tus datos personales.</p>
      </LegalSection>

      <LegalSection id="cambios" number={9} title="Cambios en esta política">
        <p>
          Podemos actualizar esta política cuando cambie el servicio o la normativa aplicable. Publicaremos la versión
          vigente en esta página con su fecha de actualización. Si un cambio es importante, procuraremos avisar a los
          usuarios dentro de la aplicación.
        </p>
      </LegalSection>

      <LegalSection id="contacto" number={10} title="Contacto">
        <p>Para consultas o solicitudes sobre privacidad:</p>
        <ContactDetails email={LEGAL_CONTACT_EMAIL} operator={SERVICE_OPERATOR} />
      </LegalSection>
    </LegalLayout>
  );
}
