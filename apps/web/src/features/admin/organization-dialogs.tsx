import type { AdminOrganizationDetail, OrganizationPlan, OrganizationStatus } from "@emailbot/types";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/display";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/form-controls";
import { getErrorMessage } from "@/lib/errors";
import type { StatusTarget } from "./admin-model";
import { useCreateOrganization, useUpdateOrganization } from "./admin-queries";

export interface OrganizationRef {
  id: string;
  name: string;
  status: OrganizationStatus;
  plan: OrganizationPlan | null;
}

/** Suspend, cancel or reactivate after an explicit confirmation (copy from admin-model). */
export function OrganizationStatusDialog({ target, onOpenChange }: { target: StatusTarget<OrganizationRef> | null; onOpenChange(open: boolean): void }) {
  const update = useUpdateOrganization();
  const change = target?.change ?? null;

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={change?.title ?? ""}
      description={change?.description ?? ""}
      confirmLabel={change?.confirmLabel ?? "Confirmar"}
      destructive={change?.destructive ?? true}
      onConfirm={async () => {
        if (!target) return;
        await update.mutateAsync({ id: target.organization.id, patch: { status: target.change.target } });
        toast.success(target.change.success);
      }}
    />
  );
}

/** New organization for an existing user (OWNER by confirmed e-mail). */
export function CreateOrganizationDialog({
  open,
  onOpenChange,
  onCreated
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(organization: AdminOrganizationDetail): void;
}) {
  const create = useCreateOrganization();
  const [name, setName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setOwnerEmail("");
      setProblem(null);
      create.reset();
    }
    // Reset only when the dialog opens.
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    const email = ownerEmail.trim();
    if (trimmedName.length < 2 || trimmedName.length > 120) return setProblem("El nombre debe tener entre 2 y 120 caracteres.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setProblem("Indica un correo válido para el propietario.");
    setProblem(null);
    const organization = await create.mutateAsync({ name: trimmedName, ownerEmail: email });
    toast.success("Organización creada");
    onOpenChange(false);
    onCreated(organization);
  }

  const error = problem ? new Error(problem) : create.error ? new Error(getErrorMessage(create.error)) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nueva organización</DialogTitle>
          <DialogDescription>
            El propietario debe ser un usuario ya registrado con su correo confirmado. No se crean cuentas nuevas.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event).catch(() => undefined)} className="grid gap-4" noValidate>
          <ErrorMessage error={error} />
          <Field label="Nombre de la empresa" htmlFor="new-organization-name">
            <Input id="new-organization-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Acme S.A.C." />
          </Field>
          <Field label="Correo del propietario" htmlFor="new-organization-owner">
            <Input
              id="new-organization-owner"
              type="email"
              value={ownerEmail}
              onChange={(event) => setOwnerEmail(event.target.value)}
              placeholder="propietario@empresa.com"
            />
          </Field>
          <p className="text-sm text-muted-foreground">
            Se crea sin plan ni acceso al producto. Después, desde su ficha, registra el pago y activa su suscripción.
          </p>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Creando…" : "Crear organización"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
