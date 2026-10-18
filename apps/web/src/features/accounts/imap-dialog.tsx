import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/display";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/form-controls";
import { getErrorMessage } from "@/lib/errors";
import { useEmailAccountMutations } from "./api";
import { imapAccountPayload, imapSecurityForPort } from "./imap-dialog-model";

const schema = z.object({
  emailAddress: z.email("Correo inválido"),
  displayName: z.string().max(200),
  host: z.string().trim().min(1, "Servidor obligatorio").regex(/^[A-Za-z0-9.-]+$/, "Servidor inválido"),
  // The API's only transports (no plaintext): 993 -> TLS, 143 -> STARTTLS (imap-dialog-model.ts).
  port: z
    .number({ error: "Puerto inválido" })
    .int()
    .refine((port) => imapSecurityForPort(port) !== null, "Usa el puerto 993 (TLS) o 143 (STARTTLS)"),
  username: z.string().trim().min(1, "Usuario obligatorio"),
  password: z.string().min(1, "Contraseña obligatoria").max(1000)
});

/**
 * Stores IMAP credentials (encrypted by the API) after its connection test; the account is created PAUSED
 * and nothing is synchronized until it is activated (IMAP M1). The body is built by imapAccountPayload:
 * exactly the API's strict schema, with security derived from the port.
 * reconnectEmail (M1.6): reconnection of an existing IMAP mailbox in ERROR. The same route and checks as a
 * new account (POST /api/email-accounts/imap: connection test with its limits, then PAUSED); only the
 * address is known (the stored server, user and password are never sent to the browser) and it is fixed.
 */
export function ImapDialog({ open, onOpenChange, reconnectEmail = null }: { open: boolean; onOpenChange(open: boolean): void; reconnectEmail?: string | null }) {
  const { createImap } = useEmailAccountMutations();
  const defaults = { emailAddress: "", displayName: "", host: "", port: 993, username: "", password: "" };
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: defaults
  });
  const reconnecting = reconnectEmail !== null;

  useEffect(() => {
    if (!open) {
      form.reset();
      createImap.reset();
    } else if (reconnecting) {
      form.reset({ ...defaults, emailAddress: reconnectEmail });
    }
  }, [open, reconnectEmail]); // reset on close; prefill the known address when reconnecting

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createImap.mutateAsync(imapAccountPayload(values));
    } catch {
      // Shown in the dialog (createImap.error), which stays open; never an unhandled rejection.
      return;
    }
    toast.success(
      reconnecting ? "Buzón IMAP reconectado: queda en pausa hasta que lo reanudes" : "Cuenta IMAP guardada en pausa. No se sincronizará ningún correo hasta que se active."
    );
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{reconnecting ? "Reconectar cuenta IMAP" : "Agregar cuenta IMAP"}</DialogTitle>
          <DialogDescription>
            {reconnecting
              ? "Vuelve a introducir el servidor, el usuario y la contraseña: se probará de nuevo la conexión. Las credenciales se cifran en el servidor y la cuenta quedará en pausa hasta que la reanudes."
              : "Para dominios propios. Se probará la conexión antes de guardar y las credenciales se cifran en el servidor. La cuenta quedará en pausa: no se sincronizará ningún correo hasta que se active."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
          <ErrorMessage error={createImap.error ? new Error(getErrorMessage(createImap.error)) : null} />
          <Field label="Correo" htmlFor="imap-email" error={form.formState.errors.emailAddress?.message} className="sm:col-span-2">
            <Input id="imap-email" type="email" readOnly={reconnecting} {...form.register("emailAddress")} />
          </Field>
          <Field label="Nombre visible (opcional)" htmlFor="imap-name" className="sm:col-span-2">
            <Input id="imap-name" {...form.register("displayName")} />
          </Field>
          <Field label="Servidor IMAP" htmlFor="imap-host" error={form.formState.errors.host?.message}>
            <Input id="imap-host" placeholder="imap.midominio.com" {...form.register("host")} />
          </Field>
          <Field label="Puerto" htmlFor="imap-port" error={form.formState.errors.port?.message}>
            <Input id="imap-port" type="number" {...form.register("port", { valueAsNumber: true })} />
          </Field>
          <Field label="Usuario" htmlFor="imap-user" error={form.formState.errors.username?.message}>
            <Input id="imap-user" autoComplete="off" {...form.register("username")} />
          </Field>
          <Field label="Contraseña" htmlFor="imap-password" error={form.formState.errors.password?.message}>
            <Input id="imap-password" type="password" autoComplete="new-password" {...form.register("password")} />
          </Field>
          <p className="text-sm text-muted-foreground sm:col-span-2">
            Puerto 993: TLS. Puerto 143: STARTTLS. No se admiten conexiones sin cifrar.
          </p>
          <DialogFooter className="sm:col-span-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={createImap.isPending}>
              {createImap.isPending ? "Guardando…" : "Guardar cuenta"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
