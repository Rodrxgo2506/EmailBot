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

const schema = z.object({
  emailAddress: z.email("Correo inválido"),
  displayName: z.string().max(200),
  host: z.string().trim().min(1, "Servidor obligatorio").regex(/^[A-Za-z0-9.-]+$/, "Servidor inválido"),
  port: z.number({ error: "Puerto inválido" }).int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().trim().min(1, "Usuario obligatorio"),
  password: z.string().min(1, "Contraseña obligatoria").max(1000)
});

/**
 * Stores IMAP credentials (encrypted by the API). Synchronization is not
 * implemented yet; the account is created PAUSED and the UI says so.
 */
export function ImapDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const { createImap } = useEmailAccountMutations();
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { emailAddress: "", displayName: "", host: "", port: 993, secure: true, username: "", password: "" }
  });

  useEffect(() => {
    if (!open) {
      form.reset();
      createImap.reset();
    }
  }, [open]); // reset on close only

  const onSubmit = form.handleSubmit(async (values) => {
    await createImap.mutateAsync({
      ...values,
      ...(values.displayName.trim() ? { displayName: values.displayName.trim() } : { displayName: undefined })
    });
    toast.success("Cuenta IMAP guardada (sincronización pendiente de implementación)");
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Agregar cuenta IMAP</DialogTitle>
          <DialogDescription>
            Para dominios propios. Las credenciales se cifran en el servidor. La sincronización IMAP aún no está
            disponible: la cuenta quedará en pausa.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
          <ErrorMessage error={createImap.error ? new Error(getErrorMessage(createImap.error)) : null} />
          <Field label="Correo" htmlFor="imap-email" error={form.formState.errors.emailAddress?.message} className="sm:col-span-2">
            <Input id="imap-email" type="email" {...form.register("emailAddress")} />
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
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" className="size-4 accent-[var(--primary)]" {...form.register("secure")} />
            Usar TLS (recomendado)
          </label>
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
