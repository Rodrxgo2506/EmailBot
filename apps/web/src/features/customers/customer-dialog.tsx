import type { Customer } from "@emailbot/types";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/display";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/form-controls";
import { getErrorMessage } from "@/lib/errors";
import { useCustomerMutations } from "./api";
import { customerFormSchema, toCustomerPayload, type CustomerFormValues } from "./customer-form-model";

/** Create or edit a customer (status changes live on the customer page). */
export function CustomerDialog({
  open,
  onOpenChange,
  customer,
  onCreated
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  customer: Customer | null;
  onCreated?(customer: Customer): void;
}) {
  const { create, update } = useCustomerMutations();
  const mutation = customer ? update : create;
  const form = useForm<CustomerFormValues>({
    resolver: zodResolver(customerFormSchema),
    defaultValues: { displayName: "", externalRef: "", notes: "" }
  });

  useEffect(() => {
    if (open) {
      form.reset({ displayName: customer?.displayName ?? "", externalRef: customer?.externalRef ?? "", notes: customer?.notes ?? "" });
      create.reset();
      update.reset();
    }
    // Reset only when the dialog opens or the edited customer changes.
  }, [open, customer]);

  const onSubmit = form.handleSubmit(async (values) => {
    const input = toCustomerPayload(values);
    if (customer) {
      await update.mutateAsync({ id: customer.id, input });
      toast.success("Cliente actualizado");
    } else {
      const created = await create.mutateAsync(input);
      toast.success("Cliente creado");
      onCreated?.(created.customer);
    }
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{customer ? "Editar cliente" : "Nuevo cliente"}</DialogTitle>
          <DialogDescription>Cliente final de la organización. No es un usuario de EmailBot.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <ErrorMessage error={mutation.error ? new Error(getErrorMessage(mutation.error)) : null} />
          <Field label="Nombre" htmlFor="customer-name" error={form.formState.errors.displayName?.message}>
            <Input id="customer-name" placeholder="Juan Pérez" {...form.register("displayName")} />
          </Field>
          <Field label="Referencia externa" htmlFor="customer-ref" hint="Opcional: tu código de cliente o contrato." error={form.formState.errors.externalRef?.message}>
            <Input id="customer-ref" placeholder="CLI-0042" {...form.register("externalRef")} />
          </Field>
          <Field label="Notas" htmlFor="customer-notes" error={form.formState.errors.notes?.message}>
            <Textarea id="customer-notes" rows={3} {...form.register("notes")} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
