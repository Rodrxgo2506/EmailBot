import { ContactDetails, LegalLayout, LegalList, LegalSection, LegalSubheading, Pending } from "./legal-layout";
import {
  API_DOMAIN,
  ATTACHMENT_MAX_MB,
  GMAIL_READONLY_SCOPE,
  MICROSOFT_SCOPES,
  PORTAL_ATTACHMENT_LINK_SECONDS,
  PORTAL_SESSION_IDLE_DAYS,
  PORTAL_SESSION_MAX_DAYS,
  PRIVACY_VERSION,
  QUEUE_COMPLETED_HOURS,
  QUEUE_FAILED_DAYS,
  SERVICE_DOMAIN,
  SERVICE_OPERATOR,
  SERVICE_OPERATOR_RUC,
  SERVICE_OPERATOR_TYPE
} from "./legal-info";

/*
 * Public privacy policy (EmailBot V2). Every statement must match the current
 * implementation (scopes, storage, sharing with end customers, platform
 * administration, deletion): update it together with the code.
 */
export function PrivacyPage() {
  return (
    <LegalLayout
      title="Política de Privacidad"
      documentTitle="Política de Privacidad | EmailBot"
      version={PRIVACY_VERSION}
      summary={
        <p>
          Esta política explica qué información trata EmailBot, para qué la utiliza, cómo la protege, con quién la
          comparte —incluidos los clientes finales de cada organización a través del portal— y qué opciones tienes sobre
          ella, incluido el acceso a cuentas de Gmail mediante OAuth.
        </p>
      }
    >
      <LegalSection id="introduccion" number={1} title="Introducción">
        <p>
          EmailBot es una aplicación web para empresas. Una organización conecta sus propias cuentas de correo, EmailBot
          procesa los mensajes que reciben, los clasifica con reglas organizadas en bots (uno por servicio o proceso,
          por ejemplo «Netflix» o «Spotify») y, si la organización lo configura, entrega cada correo a los clientes
          finales de esa organización a los que corresponde, que lo consultan en un portal.
        </p>
        <p>
          EmailBot es el nombre del servicio. Su titular y responsable es{" "}
          {SERVICE_OPERATOR ? <strong>{SERVICE_OPERATOR}</strong> : <Pending>nombre legal del titular</Pending>}
          {SERVICE_OPERATOR_TYPE ? `, ${SERVICE_OPERATOR_TYPE.toLowerCase()}` : null}
          {SERVICE_OPERATOR_RUC ? `, con RUC ${SERVICE_OPERATOR_RUC}` : null} (en adelante, «EmailBot», «nosotros»). Esta
          política se aplica a la aplicación disponible en {SERVICE_DOMAIN}, a su portal de clientes ({SERVICE_DOMAIN}/portal)
          y a los servicios de servidor que los acompañan ({API_DOMAIN}).
        </p>
        <p>Hay dos tipos de personas que usan EmailBot:</p>
        <LegalList>
          <li>
            <strong>Miembros de una organización</strong>: usuarios registrados que administran la organización desde el
            panel.
          </li>
          <li>
            <strong>Clientes finales de una organización</strong>: personas o empresas a las que la organización presta
            un servicio. No tienen cuenta de usuario en EmailBot; acceden al portal con un código de acceso (Access ID)
            que les entrega la organización.
          </li>
        </LegalList>
        <p>
          La organización decide qué cuentas conecta, qué clientes finales registra y qué correos se les entregan.
          Respecto de los datos de sus clientes finales y de los correos que les muestra, EmailBot los trata por cuenta
          de la organización y según su configuración.
        </p>
      </LegalSection>

      <LegalSection id="informacion" number={2} title="Información que recopilamos">
        <LegalSubheading>Cuenta y perfil (miembros)</LegalSubheading>
        <LegalList>
          <li>Dirección de correo electrónico y contraseña con las que te registras. La contraseña la gestiona el servicio de autenticación; EmailBot no la guarda en sus propias tablas.</li>
          <li>Datos de perfil, como tu nombre.</li>
          <li>
            Tu aceptación de los Términos y Condiciones y de esta Política de Privacidad: la versión de cada documento que
            aceptaste y la fecha y hora en que lo hiciste, registradas por nuestros servidores.
          </li>
        </LegalList>

        <LegalSubheading>Organización</LegalSubheading>
        <LegalList>
          <li>Nombre, identificador, plan, estado y configuración de las organizaciones que creas o a las que perteneces.</li>
          <li>Miembros de cada organización y el rol asignado a cada uno.</li>
          <li>Bots, categorías, reglas de procesamiento y reglas de extracción que la organización configura.</li>
        </LegalList>

        <LegalSubheading>Clientes finales de la organización</LegalSubheading>
        <LegalList>
          <li>Nombre visible, estado y, si la organización los indica, una referencia externa y notas internas.</li>
          <li>
            Identificadores con los que se reconoce al cliente en los correos, como una dirección de correo, un teléfono,
            un nombre de usuario o un identificador externo, y los bots a los que está asociado.
          </li>
          <li>
            Su código de acceso al portal (Access ID). EmailBot no guarda el código: solo una huella criptográfica que
            permite comprobarlo y sus últimos 4 caracteres, para que la organización pueda reconocerlo.
          </li>
          <li>
            Sesiones del portal: fecha de inicio y de última actividad, caducidad, la dirección IP y el navegador desde
            los que se inició y, de cada correo entregado, si ya fue abierto.
          </li>
        </LegalList>

        <LegalSubheading>Cuentas de correo conectadas</LegalSubheading>
        <LegalList>
          <li>Proveedor, dirección de correo, nombre visible y estado de cada cuenta conectada.</li>
          <li>Credenciales de acceso del proveedor (tokens OAuth o, en cuentas IMAP, la contraseña indicada), siempre almacenadas cifradas en el servidor.</li>
          <li>
            Información técnica de sincronización, como el punto desde el que deben leerse los mensajes nuevos, la fecha
            de la última sincronización y el estado de las notificaciones de Gmail.
          </li>
        </LegalList>

        <LegalSubheading>Correos procesados</LegalSubheading>
        <LegalList>
          <li>
            De cada mensaje que EmailBot procesa: remitente, destinatarios, asunto, fecha, un fragmento, el cuerpo en
            texto y HTML y un conjunto limitado de cabeceras técnicas.
          </li>
          <li>Resultados del procesamiento: categoría, bot y regla aplicados e información extraída por las reglas.</li>
          <li>Entregas: a qué clientes finales se entregó cada correo, si fue de forma automática o manual y quién la hizo.</li>
          <li>
            Archivos adjuntos: de todos ellos, sus metadatos (nombre, tipo y tamaño). Su contenido solo se guarda si la
            organización tiene activada la opción «Guardar adjuntos» (activada por defecto), y únicamente de los adjuntos
            que no van incrustados en el cuerpo del correo y no superan el tamaño máximo del servicio ({ATTACHMENT_MAX_MB} MB
            por defecto).
          </li>
        </LegalList>

        <LegalSubheading>Auditoría y datos técnicos</LegalSubheading>
        <LegalList>
          <li>
            Registros de auditoría de la organización: los genera el servidor de EmailBot cuando un miembro realiza una
            acción (por ejemplo, iniciar sesión, conectar o desconectar una cuenta, o crear, modificar o eliminar un
            recurso) y en eventos del sistema y del portal (como los inicios y cierres de sesión de los clientes, el
            resultado de la entrega de un correo a los clientes o el estado de las notificaciones de Gmail). Guardan el tipo de acción, el recurso afectado, el miembro que la realizó (si la hizo
            un miembro), la fecha y datos de contexto como identificadores internos o la dirección de la cuenta de correo
            afectada. No guardan contraseñas, tokens ni el contenido de los correos. Los ven los propietarios y
            administradores de la organización.
          </li>
          <li>
            Registros de auditoría de la plataforma: las acciones de los administradores de EmailBot sobre las
            organizaciones (por ejemplo, crearlas, cambiar su plan o suspenderlas), con quién las realizó, la fecha y el
            cambio aplicado.
          </li>
          <li>
            Datos técnicos necesarios para el funcionamiento y la seguridad, como la dirección IP y los datos de cada
            solicitud en los registros del servidor y en el control de frecuencia de solicitudes.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection id="gmail" number={3} title="Acceso a cuentas de correo">
        <p>
          La organización decide qué cuentas de correo conectar. EmailBot solo accede a una cuenta después de que un
          miembro con permisos la conecta y el titular de la cuenta lo autoriza en la pantalla de su proveedor.
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
          <li>
            Para enterarse de los mensajes nuevos casi al instante, EmailBot pide a Gmail que le avise de los cambios del
            buzón mediante Google Cloud Pub/Sub. Cada aviso contiene solo la dirección del buzón y un número de
            referencia del cambio, no el contenido de los mensajes; EmailBot lee después los mensajes nuevos con el
            permiso de solo lectura. Además, revisa periódicamente las cuentas para no perder mensajes si un aviso no
            llega.
          </li>
        </LegalList>

        <LegalSubheading>Microsoft / Outlook</LegalSubheading>
        <LegalList>
          <li>
            La conexión se realiza mediante OAuth de Microsoft con permisos de lectura de correo ({MICROSOFT_SCOPES[0]}),
            lectura del perfil básico ({MICROSOFT_SCOPES[1]}) y acceso sin conexión ({MICROSOFT_SCOPES[2]}) para seguir
            procesando mensajes nuevos sin que tengas que volver a iniciar sesión. EmailBot no puede enviar, modificar ni
            eliminar correos con estos permisos.
          </li>
          <li>
            EmailBot lee los mensajes nuevos de la bandeja de entrada a partir de la conexión. En las cuentas de Microsoft
            no recibe avisos de mensajes nuevos: las consulta periódicamente, por lo que los correos pueden tardar algunos
            minutos más que en Gmail.
          </li>
        </LegalList>

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
            Desde la sección Cuentas de correo, un miembro con permisos puede desconectar una cuenta. Al hacerlo,
            EmailBot borra las credenciales guardadas y deja de procesar mensajes de esa cuenta.
          </li>
          <li>
            Los correos ya procesados se conservan hasta que se elimina la cuenta desconectada desde EmailBot, lo que
            borra también sus correos, sus entregas a clientes y sus adjuntos almacenados.
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
          <li>
            se usan solo para ofrecer las funciones de EmailBot que la organización ve y configura: clasificar los
            correos, mostrarlos a sus miembros y entregarlos en el portal a los clientes finales que la organización
            registra y asocia a cada bot;
          </li>
          <li>no se venden ni se usan para publicidad;</li>
          <li>
            no se transfieren a terceros, salvo a esos clientes finales por decisión y configuración de la organización,
            a los proveedores técnicos necesarios para prestar el servicio o cuando lo exija la ley;
          </li>
          <li>
            no son leídos por personas del equipo de EmailBot, salvo con tu consentimiento, cuando sea necesario por
            motivos de seguridad o legales, o para investigar un problema técnico que nos hayas pedido resolver. La
            consola de administración de la plataforma no muestra el contenido de los correos.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection id="portal" number={4} title="Portal de clientes">
        <LegalList>
          <li>
            Un correo se entrega a un cliente final cuando un identificador suyo aparece en el correo según la
            configuración del bot (por ejemplo, la dirección del destinatario), o cuando un miembro de la organización
            se lo asigna manualmente.
          </li>
          <li>
            En el portal, cada cliente final ve solo los correos que se le entregaron. Según la configuración de cada
            bot, puede ver el asunto, el remitente, la fecha, los datos extraídos que la organización elige mostrar, el
            cuerpo del correo y sus archivos adjuntos. Los adjuntos se descargan mediante enlaces temporales que caducan a
            los {PORTAL_ATTACHMENT_LINK_SECONDS} segundos.
          </li>
          <li>
            Un cliente final nunca ve correos de otros clientes ni de otras organizaciones, ni los identificadores, notas
            o referencias que la organización guarda sobre él.
          </li>
          <li>
            La sesión del portal se guarda en una cookie técnica cifrada en tránsito, inaccesible para el código de la
            página. Caduca tras {PORTAL_SESSION_IDLE_DAYS} días sin actividad y, en todo caso, a los{" "}
            {PORTAL_SESSION_MAX_DAYS} días. La organización puede revocar el código de acceso o cerrar las sesiones de un
            cliente en cualquier momento; suspender al cliente o a la organización también impide el acceso.
          </li>
          <li>
            Si eres cliente final de una organización y quieres consultar, corregir o eliminar tus datos, dirígete
            primero a esa organización, que es quien decide qué datos tuyos registra y qué correos te entrega. También
            puedes escribirnos y trasladaremos tu solicitud.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection id="uso" number={5} title="Cómo usamos la información">
        <LegalList>
          <li>Autenticar a los miembros y a los clientes finales y mantener sus sesiones.</li>
          <li>Crear y mantener las organizaciones, sus miembros y sus roles.</li>
          <li>Procesar los correos de las cuentas que la organización ha conectado y autorizado.</li>
          <li>Aplicar las reglas configuradas, clasificar los correos, extraer la información que esas reglas indican y elegir el bot que corresponde.</li>
          <li>Entregar los correos a los clientes finales que la organización ha configurado y mostrárselos en el portal.</li>
          <li>Mostrar los resultados a los miembros de la organización, según su rol.</li>
          <li>Administrar la plataforma (alta de organizaciones, planes y suspensiones) con metadatos y estadísticas.</li>
          <li>Mantener la seguridad del servicio, registrar la actividad en el historial de auditoría, prevenir abusos y resolver errores.</li>
        </LegalList>
        <p>No usamos la información para publicidad ni la vendemos.</p>
      </LegalSection>

      <LegalSection id="seguridad" number={6} title="Almacenamiento y seguridad">
        <LegalList>
          <li>Los datos de la aplicación, la autenticación y los archivos adjuntos se almacenan en Supabase (base de datos, autenticación y almacenamiento de archivos).</li>
          <li>El procesamiento de correos lo realizan componentes de servidor de EmailBot alojados en Render.</li>
          <li>Los tokens OAuth y las credenciales de correo se guardan cifrados y solo se usan en el servidor.</li>
          <li>Los códigos de acceso y los tokens de sesión del portal no se guardan: solo su huella criptográfica.</li>
          <li>
            Cada organización está aislada de las demás, y cada cliente final de los demás clientes: el acceso se
            controla en la aplicación y con políticas de seguridad en la base de datos.
          </li>
          <li>Las comunicaciones con la aplicación y con el portal se realizan mediante HTTPS.</li>
        </LegalList>
        <p>
          Aplicamos medidas razonables para proteger la información, pero ningún sistema es completamente seguro y no
          podemos garantizar una seguridad absoluta.
        </p>
      </LegalSection>

      <LegalSection id="ubicacion" number={7} title="Ubicación de los datos y transferencias internacionales">
        <p>EmailBot se opera desde el Perú, pero sus proveedores de infraestructura tratan la información fuera del Perú:</p>
        <LegalList>
          <li>La base de datos, la autenticación y los archivos adjuntos se alojan en Supabase, en Estados Unidos (región de Oregón).</li>
          <li>Los servidores de la aplicación y del procesamiento de correos se alojan en Render, fuera del Perú.</li>
          <li>
            Las conexiones con {SERVICE_DOMAIN} y {API_DOMAIN} pasan por la red de Cloudflare que utiliza Render, que puede
            tratarlas en distintos países.
          </li>
          <li>Google y Microsoft tratan la información de las cuentas conectadas en su propia infraestructura, según sus políticas.</li>
        </LegalList>
        <p>
          Al usar EmailBot, la información se transfiere a esos proveedores únicamente para prestar el servicio y con las
          medidas de seguridad descritas en la sección 6.
        </p>
      </LegalSection>

      <LegalSection id="comparticion" number={8} title="Compartición de información">
        <LegalList>
          <li>
            <strong>Dentro de la organización</strong>: los correos procesados y sus resultados son visibles para sus
            miembros según el rol de cada uno.
          </li>
          <li>
            <strong>Con los clientes finales de la organización</strong>: solo los correos que se les entregan, como se
            explica en la sección 4, y según lo que la organización configura.
          </li>
          <li>
            <strong>Administradores de la plataforma EmailBot</strong>: para operar el servicio ven metadatos y
            estadísticas de cada organización (nombre, plan, estado, miembros con su nombre y correo, nombres de bots y
            de clientes finales, direcciones de las cuentas conectadas y su estado, y recuentos). No ven el contenido de
            los correos, los adjuntos, las credenciales, los identificadores de los clientes ni sus códigos de acceso, y
            sus acciones quedan registradas.
          </li>
        </LegalList>
        <p>Fuera de lo anterior, solo compartimos información con los proveedores técnicos necesarios para operar el servicio:</p>
        <LegalList>
          <li><strong>Supabase</strong>: base de datos, autenticación y almacenamiento de archivos.</li>
          <li><strong>Render</strong>: alojamiento de la aplicación web, el servidor y los procesos de procesamiento.</li>
          <li><strong>Cloudflare</strong>: red por la que pasan las conexiones con la aplicación (a través de Render).</li>
          <li>
            <strong>Google</strong>: cuando una organización conecta una cuenta de Gmail, para autorizar el acceso, leer
            los mensajes y recibir los avisos de mensajes nuevos (Google Cloud Pub/Sub).
          </li>
          <li><strong>Microsoft</strong>: cuando una organización conecta una cuenta de Microsoft / Outlook, para autorizar el acceso y leer los mensajes.</li>
          <li>Otros proveedores técnicos estrictamente necesarios para la infraestructura, como servicios de monitorización de errores si se habilitan.</li>
        </LegalList>
        <p>También podremos revelar información cuando la ley lo exija. No vendemos información personal.</p>
      </LegalSection>

      <LegalSection id="retencion" number={9} title="Retención y eliminación">
        <p>
          No aplicamos plazos de retención fijos. La información se conserva mientras es necesaria para prestar el
          servicio a la organización:
        </p>
        <LegalList>
          <li>
            Los correos procesados se conservan hasta que se eliminan desde EmailBot, ya sea individualmente o al eliminar
            la cuenta de correo desconectada a la que pertenecen, junto con sus entregas y adjuntos. EmailBot no elimina
            correos automáticamente por su antigüedad.
          </li>
          <li>Las credenciales de una cuenta de correo se borran al desconectarla.</li>
          <li>
            Las sesiones del portal caducan como se indica en la sección 4. Una entrega retirada manualmente deja de ser
            visible para el cliente, aunque su registro se conserva.
          </li>
          <li>Suspender o cancelar una organización detiene el procesamiento y el acceso, pero no borra sus datos.</li>
          <li>
            Los trabajos de procesamiento en cola (que pueden incluir identificadores, la dirección del buzón y, en las
            notificaciones, el asunto o los datos extraídos) se conservan temporalmente: hasta {QUEUE_COMPLETED_HOURS}{" "}
            horas los completados y hasta {QUEUE_FAILED_DAYS} días los que fallaron.
          </li>
          <li>
            Los registros de auditoría se conservan sin plazo fijo y la base de datos impide modificarlos o borrarlos.
            Solo hay dos excepciones: cuando se elimina un usuario, su identificación como autor se elimina del registro
            (el registro se conserva), y cuando se elimina una organización se eliminan sus registros de auditoría (los
            de la plataforma se conservan sin la referencia a ella).
          </li>
          <li>
            Los registros de aceptación de los documentos legales no se pueden modificar mientras exista tu cuenta y se
            eliminan junto con tu usuario.
          </li>
          <li>
            Los registros técnicos del servidor (por ejemplo, la dirección IP de cada solicitud) se conservan durante el
            tiempo que aplique el proveedor de alojamiento.
          </li>
        </LegalList>
        <p>
          La aplicación todavía no permite eliminar por tu cuenta tu usuario, una organización completa ni un cliente
          final. Puedes solicitarlo por los medios de contacto indicados más abajo, y lo atenderemos conforme a las
          capacidades del servicio y a las obligaciones legales aplicables. Las copias de seguridad de nuestros
          proveedores pueden conservar datos durante un tiempo limitado según sus propias políticas.
        </p>
      </LegalSection>

      <LegalSection id="cookies" number={10} title="Cookies y almacenamiento en el navegador">
        <LegalList>
          <li>
            Panel de la organización: el navegador guarda la sesión iniciada y la organización activa en su
            almacenamiento local.
          </li>
          <li>
            Portal de clientes: una única cookie técnica de sesión, necesaria para mantener la sesión iniciada. El portal
            no guarda la sesión en el almacenamiento local.
          </li>
          <li>EmailBot no usa cookies de publicidad ni de analítica.</li>
        </LegalList>
      </LegalSection>

      <LegalSection id="derechos" number={11} title="Tus derechos">
        <LegalList>
          <li><strong>Acceso</strong>: los miembros pueden consultar en EmailBot su perfil, su organización y los correos a los que su rol da acceso; los clientes finales, los correos que se les entregaron.</li>
          <li><strong>Rectificación</strong>: puedes actualizar tu nombre y tu contraseña desde tu perfil, y los administradores de la organización pueden modificar sus datos y los de sus clientes finales.</li>
          <li><strong>Cancelación</strong>: puedes eliminar correos y cuentas de correo desconectadas según tu rol, y solicitar la eliminación de tu usuario, de tu organización o de tus datos como cliente final.</li>
          <li><strong>Oposición y revocación</strong>: puedes desconectar una cuenta de correo en EmailBot, retirar el acceso desde tu cuenta de Google o Microsoft y oponerte a un tratamiento escribiéndonos.</li>
          <li><strong>Consultas</strong>: puedes enviarnos cualquier pregunta sobre privacidad a través del contacto indicado.</li>
        </LegalList>
        <p>
          Para ejercer estos derechos escríbenos al correo de la sección 13. Si eres cliente final de una organización,
          dirígete primero a ella, como se indica en la sección 4. La ley aplicable puede reconocerte otros derechos sobre
          tus datos personales.
        </p>
      </LegalSection>

      <LegalSection id="cambios" number={12} title="Cambios en esta política">
        <p>
          Podemos actualizar esta política cuando cambie el servicio o la normativa aplicable. Publicaremos la versión
          vigente en esta página con su número de versión y su fecha de actualización. Cuando publiquemos una nueva
          versión, los miembros deberán aceptarla para seguir usando el panel de EmailBot.
        </p>
      </LegalSection>

      <LegalSection id="contacto" number={13} title="Contacto">
        <p>Para consultas o solicitudes sobre privacidad:</p>
        <ContactDetails />
      </LegalSection>
    </LegalLayout>
  );
}
