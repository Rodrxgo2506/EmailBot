import type { Bot } from "@emailbot/types";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/display";
import { CheckboxCard } from "@/components/ui/form-controls";
import { getErrorMessage } from "@/lib/errors";
import { useBotMutations } from "./api";

/*
 * What the customer portal shows of this bot's emails (bots.portal_settings).
 * Off by default: the API (portal.get_email) returns the body / attachments
 * only when they are enabled here. The configured fields are kept as they are.
 */
export function PortalVisibilityCard({ bot, canManage }: { bot: Bot; canManage: boolean }) {
  const { update } = useBotMutations();
  const [showBody, setShowBody] = useState(bot.portalSettings.showBody);
  const [showAttachments, setShowAttachments] = useState(bot.portalSettings.showAttachments);

  useEffect(() => {
    setShowBody(bot.portalSettings.showBody);
    setShowAttachments(bot.portalSettings.showAttachments);
    // Reset when the stored settings change (after saving or a refetch).
  }, [bot.id, bot.portalSettings.showBody, bot.portalSettings.showAttachments]);

  const dirty = showBody !== bot.portalSettings.showBody || showAttachments !== bot.portalSettings.showAttachments;

  const save = async () => {
    try {
      await update.mutateAsync({ id: bot.id, input: { portalSettings: { ...bot.portalSettings, showBody, showAttachments } } });
      toast.success("Vista en el portal actualizada");
    } catch (cause) {
      toast.error(getErrorMessage(cause));
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Vista en el portal</CardTitle>
          <Badge variant={bot.portalSettings.showBody ? "success" : "secondary"}>
            {bot.portalSettings.showBody ? "Contenido visible" : "Solo resumen"}
          </Badge>
        </div>
        <CardDescription>
          Qué ven tus clientes al abrir un correo de este bot en su portal. El asunto, el remitente y la fecha se muestran siempre.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <CheckboxCard
          label="Mostrar el contenido completo del correo"
          description="El cuerpo original (HTML o texto), por ejemplo un código de verificación. Se muestra aislado y sin cargar imágenes remotas hasta que el cliente lo pida."
          checked={showBody}
          disabled={!canManage}
          onChange={(event) => setShowBody(event.target.checked)}
        />
        <CheckboxCard
          label="Permitir descargar los archivos adjuntos"
          description="El cliente ve la lista de adjuntos y puede descargarlos con un enlace temporal."
          checked={showAttachments}
          disabled={!canManage}
          onChange={(event) => setShowAttachments(event.target.checked)}
        />
        {canManage ? (
          <div>
            <Button onClick={() => void save()} disabled={!dirty || update.isPending} aria-label="Guardar vista en el portal">
              {update.isPending ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
