import type { Category } from "@emailbot/types";
import { zodResolver } from "@hookform/resolvers/zod";
import { FolderTree, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, ErrorMessage, PageHeader } from "@/components/ui/display";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog, SkeletonRows } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/form-controls";
import { getErrorMessage } from "@/lib/errors";
import { useOrganization } from "@/providers/organization-provider";
import { useCategories, useCategoryMutations } from "./api";
import { CategoryDot } from "./category-badge";

const schema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(100),
  description: z.string().max(500),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color hexadecimal, ej. #2563EB"),
  sortOrder: z.number({ error: "Ingresa un número" }).int().min(0).max(100_000)
});
type CategoryFormValues = z.infer<typeof schema>;

const PALETTE = ["#2563EB", "#16A34A", "#DC2626", "#D97706", "#7C3AED", "#0891B2", "#DB2777", "#4B5563"];

function CategoryDialog({
  open,
  onOpenChange,
  category
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  category: Category | null;
}) {
  const { create, update } = useCategoryMutations();
  const mutation = category ? update : create;
  const form = useForm<CategoryFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", description: "", color: PALETTE[0], sortOrder: 0 }
  });

  useEffect(() => {
    if (open) {
      form.reset({
        name: category?.name ?? "",
        description: category?.description ?? "",
        color: category?.color ?? PALETTE[0],
        sortOrder: category?.sortOrder ?? 0
      });
      create.reset();
      update.reset();
    }
    // Reset only when the dialog opens or the edited category changes.
  }, [open, category]);

  const onSubmit = form.handleSubmit(async (values) => {
    const input = {
      name: values.name,
      description: values.description.trim() || null,
      color: values.color.toUpperCase(),
      sortOrder: values.sortOrder
    };
    if (category) await update.mutateAsync({ id: category.id, input });
    else await create.mutateAsync(input);
    toast.success(category ? "Categoría actualizada" : "Categoría creada");
    onOpenChange(false);
  });

  const color = form.watch("color");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{category ? "Editar categoría" : "Nueva categoría"}</DialogTitle>
          <DialogDescription>Las reglas pueden asignar esta categoría a los correos.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <ErrorMessage error={mutation.error ? new Error(getErrorMessage(mutation.error)) : null} />
          <Field label="Nombre" htmlFor="category-name" error={form.formState.errors.name?.message}>
            <Input id="category-name" placeholder="Códigos" {...form.register("name")} />
          </Field>
          <Field label="Descripción" htmlFor="category-description" error={form.formState.errors.description?.message}>
            <Textarea id="category-description" rows={2} {...form.register("description")} />
          </Field>
          <Field label="Color" htmlFor="category-color" error={form.formState.errors.color?.message}>
            <div className="flex flex-wrap items-center gap-2">
              {PALETTE.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-label={`Color ${option}`}
                  aria-pressed={color.toUpperCase() === option}
                  onClick={() => form.setValue("color", option, { shouldValidate: true })}
                  className="size-7 rounded-full border-2 border-transparent aria-pressed:border-foreground"
                  style={{ backgroundColor: option }}
                />
              ))}
              <Input id="category-color" className="w-28 font-mono" {...form.register("color")} />
            </div>
          </Field>
          <Field label="Orden" htmlFor="category-order" hint="Menor número aparece primero." error={form.formState.errors.sortOrder?.message}>
            <Input id="category-order" type="number" min={0} className="w-32" {...form.register("sortOrder", { valueAsNumber: true })} />
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

export function CategoriesPage() {
  const { can } = useOrganization();
  const canManage = can("categories:manage");
  const categories = useCategories();
  const { remove } = useCategoryMutations();
  const [editing, setEditing] = useState<Category | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<Category | null>(null);

  const openDialog = (category: Category | null) => {
    setEditing(category);
    setDialogOpen(true);
  };

  return (
    <div>
      <PageHeader
        title="Categorías"
        description="Clasifica los correos procesados. Las reglas asignan categorías automáticamente."
        actions={
          canManage ? (
            <Button onClick={() => openDialog(null)}>
              <Plus /> Nueva categoría
            </Button>
          ) : undefined
        }
      />

      {categories.isPending ? (
        <SkeletonRows rows={4} />
      ) : categories.error ? (
        <ErrorMessage error={new Error(getErrorMessage(categories.error))} />
      ) : categories.data.length === 0 ? (
        <EmptyState
          icon={<FolderTree />}
          title="Sin categorías"
          description="Crea categorías como Códigos, Facturación o Alertas."
          action={canManage ? <Button onClick={() => openDialog(null)}>Crear categoría</Button> : undefined}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {categories.data.map((category) => (
            <Card key={category.id} className="flex items-start gap-3 p-4">
              <CategoryDot color={category.color} className="mt-1.5 size-3" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium">{category.name}</p>
                  {category.isSystem ? <Badge variant="secondary">Sistema</Badge> : null}
                </div>
                <p className="font-mono text-xs text-muted-foreground">{category.slug}</p>
                {category.description ? <p className="mt-1 text-sm text-muted-foreground">{category.description}</p> : null}
                <Link to={`/inbox?view=all&category=${category.id}`} className="mt-2 inline-block text-xs text-primary hover:underline">
                  Ver correos
                </Link>
              </div>
              {canManage ? (
                <div className="flex">
                  <Button variant="ghost" size="icon" aria-label={`Editar ${category.name}`} onClick={() => openDialog(category)}>
                    <Pencil />
                  </Button>
                  {!category.isSystem ? (
                    <Button variant="ghost" size="icon" aria-label={`Eliminar ${category.name}`} onClick={() => setDeleting(category)}>
                      <Trash2 />
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}

      <CategoryDialog open={dialogOpen} onOpenChange={setDialogOpen} category={editing} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Eliminar "${deleting?.name ?? ""}"`}
        description="Los correos y reglas que la usan quedarán sin categoría. Esta acción no se puede deshacer."
        confirmLabel="Eliminar"
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          toast.success("Categoría eliminada");
        }}
      />
    </div>
  );
}
