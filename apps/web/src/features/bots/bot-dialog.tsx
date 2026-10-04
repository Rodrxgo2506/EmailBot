import type { Bot } from "@emailbot/types";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/display";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/form-controls";
import { getErrorMessage } from "@/lib/errors";
import { useBotMutations } from "./api";

const schema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(100),
  description: z.string().max(500)
});
type BotFormValues = z.infer<typeof schema>;

/** Create or rename a bot (name and description). Status changes live on the bot page. */
export function BotDialog({
  open,
  onOpenChange,
  bot,
  onCreated
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  bot: Bot | null;
  onCreated?(bot: Bot): void;
}) {
  const { create, update } = useBotMutations();
  const mutation = bot ? update : create;
  const form = useForm<BotFormValues>({ resolver: zodResolver(schema), defaultValues: { name: "", description: "" } });

  useEffect(() => {
    if (open) {
      form.reset({ name: bot?.name ?? "", description: bot?.description ?? "" });
      create.reset();
      update.reset();
    }
    // Reset only when the dialog opens or the edited bot changes.
  }, [open, bot]);

  const onSubmit = form.handleSubmit(async (values) => {
    const input = { name: values.name, description: values.description.trim() || null };
    if (bot) {
      await update.mutateAsync({ id: bot.id, input });
      toast.success("Bot actualizado");
    } else {
      const created = await create.mutateAsync(input);
      toast.success("Bot creado");
      onCreated?.(created.bot);
    }
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{bot ? "Editar bot" : "Nuevo bot"}</DialogTitle>
          <DialogDescription>Un bot agrupa las reglas de un servicio de correo, por ejemplo Netflix o Yape.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <ErrorMessage error={mutation.error ? new Error(getErrorMessage(mutation.error)) : null} />
          <Field label="Nombre" htmlFor="bot-name" error={form.formState.errors.name?.message}>
            <Input id="bot-name" placeholder="Netflix" {...form.register("name")} />
          </Field>
          <Field label="Descripción" htmlFor="bot-description" error={form.formState.errors.description?.message}>
            <Textarea id="bot-description" rows={2} {...form.register("description")} />
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
