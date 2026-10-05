import { KeyRound, LogOut, RefreshCw, ShieldOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorMessage } from "@/components/ui/display";
import { ConfirmDialog, SkeletonRows } from "@/components/ui/feedback";
import { Input } from "@/components/ui/form-controls";
import { getErrorMessage } from "@/lib/errors";
import { formatDate } from "@/lib/utils";
import { useCustomerAccess, useCustomerAccessMutations } from "./api";
import { ACCESS_STATE_LABELS, accessState, expirationFromDays, generateLabel } from "./portal-access-model";

/**
 * Customer portal access (EmailBot V2 phase 4): Access ID and sessions.
 * The full Access ID is displayed once, right after generation; afterwards
 * only the masked form ("SP-••••••••P4Z7") exists anywhere.
 */
export function PortalAccessCard({ customerId, customerActive }: { customerId: string; customerActive: boolean }) {
  const access = useCustomerAccess(customerId, true);
  const { generate, revoke, revokeSessions } = useCustomerAccessMutations(customerId);
  const [days, setDays] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"regenerate" | "revoke" | "sessions" | null>(null);

  const run = async () => {
    try {
      const result = await generate.mutateAsync({ expiresAt: expirationFromDays(days) });
      setShown(result.accessId);
      setDays("");
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  if (access.isPending) {
    return (
      <Card>
        <CardContent>
          <SkeletonRows rows={2} />
        </CardContent>
      </Card>
    );
  }
  if (access.error) return <ErrorMessage error={new Error(getErrorMessage(access.error))} />;

  const { credential, activeSessions } = access.data;
  const state = accessState(credential);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Acceso al portal</CardTitle>
        <CardDescription>El cliente entra al portal con su Access ID. Solo se muestra completo una vez, al generarlo.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={state === "ACTIVE" ? "success" : "secondary"}>{ACCESS_STATE_LABELS[state]}</Badge>
          {credential ? <span className="font-mono">{credential.maskedAccessId}</span> : null}
          {credential?.expiresAt ? <span className="text-muted-foreground">Caduca: {formatDate(credential.expiresAt)}</span> : null}
          <span className="text-muted-foreground">· Sesiones activas: {activeSessions.length}</span>
        </div>
        {!customerActive ? <p className="text-sm text-muted-foreground">El cliente está suspendido: no puede iniciar sesión.</p> : null}

        <div className="flex flex-wrap items-end gap-2">
          <Input
            aria-label="Caducidad en días (opcional)"
            placeholder="Días de validez (opcional)"
            inputMode="numeric"
            className="w-56"
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
          <Button onClick={() => (credential ? setConfirm("regenerate") : void run())} disabled={generate.isPending}>
            {credential ? <RefreshCw /> : <KeyRound />} {generateLabel(credential)}
          </Button>
          {credential ? (
            <Button variant="outline" onClick={() => setConfirm("revoke")} disabled={revoke.isPending}>
              <ShieldOff /> Revocar
            </Button>
          ) : null}
          {activeSessions.length > 0 ? (
            <Button variant="outline" onClick={() => setConfirm("sessions")} disabled={revokeSessions.isPending}>
              <LogOut /> Cerrar sesiones
            </Button>
          ) : null}
        </div>
      </CardContent>

      <Dialog open={shown !== null} onOpenChange={(open) => !open && setShown(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Access ID generado</DialogTitle>
            <DialogDescription>Cópialo y entrégalo al cliente. No se volverá a mostrar: si se pierde, genera uno nuevo.</DialogDescription>
          </DialogHeader>
          <p className="select-all rounded-md border bg-muted p-3 text-center font-mono text-lg tracking-wider">{shown}</p>
          <DialogFooter>
            {shown ? <CopyButton value={shown} label="Copiar Access ID" /> : null}
            <Button onClick={() => setShown(null)}>Listo</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm === "regenerate" ? "Regenerar Access ID" : confirm === "revoke" ? "Revocar Access ID" : "Cerrar todas las sesiones"}
        description={
          confirm === "regenerate"
            ? "El Access ID actual dejará de funcionar y se cerrarán todas las sesiones del cliente."
            : confirm === "revoke"
              ? "El cliente no podrá entrar al portal hasta que se genere un nuevo Access ID. Se cerrarán sus sesiones."
              : "El cliente tendrá que volver a entrar con su Access ID."
        }
        confirmLabel={confirm === "regenerate" ? "Regenerar" : confirm === "revoke" ? "Revocar" : "Cerrar sesiones"}
        onConfirm={async () => {
          try {
            if (confirm === "regenerate") await run();
            else if (confirm === "revoke") {
              await revoke.mutateAsync();
              toast.success("Access ID revocado");
            } else if (confirm === "sessions") {
              const result = await revokeSessions.mutateAsync();
              toast.success(`Sesiones cerradas: ${result.revokedSessions}`);
            }
          } catch (error) {
            toast.error(getErrorMessage(error));
          }
        }}
      />
    </Card>
  );
}
