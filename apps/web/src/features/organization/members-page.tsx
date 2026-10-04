import type { OrganizationMember } from "@emailbot/types";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trash2, UserPlus, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, ErrorMessage, PageHeader } from "@/components/ui/display";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog, SkeletonRows } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/form-controls";
import { getErrorMessage } from "@/lib/errors";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/labels";
import { formatDate, initials } from "@/lib/utils";
import { useAuth } from "@/providers/auth-provider";
import { useOrganization } from "@/providers/organization-provider";
import { useMemberMutations, useMembers, type AssignableRole } from "./api";

const ASSIGNABLE: AssignableRole[] = ["ADMIN", "OPERATOR", "VIEWER"];

const addSchema = z.object({
  email: z.email("Correo inválido"),
  role: z.enum(["ADMIN", "OPERATOR", "VIEWER"])
});

function AddMemberDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const { add } = useMemberMutations();
  const form = useForm({ resolver: zodResolver(addSchema), defaultValues: { email: "", role: "VIEWER" as AssignableRole } });

  useEffect(() => {
    if (!open) {
      form.reset();
      add.reset();
    }
  }, [open]); // reset on close only

  const onSubmit = form.handleSubmit(async (values) => {
    await add.mutateAsync(values);
    toast.success("Miembro agregado");
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agregar miembro</DialogTitle>
          <DialogDescription>
            La persona debe tener una cuenta en EmailBot. (Las invitaciones por correo aún no están disponibles.)
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <ErrorMessage error={add.error ? new Error(getErrorMessage(add.error)) : null} />
          <Field label="Correo" htmlFor="member-email" error={form.formState.errors.email?.message}>
            <Input id="member-email" type="email" {...form.register("email")} />
          </Field>
          <Field label="Rol" htmlFor="member-role" hint={ROLE_DESCRIPTIONS[form.watch("role")]}>
            <Select id="member-role" {...form.register("role")}>
              {ASSIGNABLE.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </Select>
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? "Agregando…" : "Agregar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MembersPage() {
  const { user } = useAuth();
  const { can } = useOrganization();
  const canManage = can("members:manage");
  const members = useMembers();
  const { updateRole, remove } = useMemberMutations();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<OrganizationMember | null>(null);

  function changeRole(member: OrganizationMember, role: AssignableRole) {
    updateRole.mutate(
      { id: member.id, role },
      {
        onSuccess: () => toast.success(`Rol actualizado a ${ROLE_LABELS[role]}`),
        onError: (error) => toast.error(getErrorMessage(error))
      }
    );
  }

  return (
    <div>
      <PageHeader
        title="Miembros"
        description="Personas con acceso a esta organización y su rol."
        actions={
          canManage ? (
            <Button onClick={() => setAdding(true)}>
              <UserPlus /> Agregar miembro
            </Button>
          ) : undefined
        }
      />

      {members.isPending ? (
        <SkeletonRows rows={4} />
      ) : members.error ? (
        <ErrorMessage error={new Error(getErrorMessage(members.error))} />
      ) : members.data.length === 0 ? (
        <EmptyState icon={<Users />} title="Sin miembros" />
      ) : (
        <Card className="divide-y">
          {members.data.map((member) => {
            const isSelf = member.userId === user?.id;
            const isOwner = member.role === "OWNER";
            const name = member.profile?.fullName ?? member.profile?.email ?? "Usuario";
            return (
              <div key={member.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                    {initials(name)}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {name} {isSelf ? <span className="text-xs text-muted-foreground">(tú)</span> : null}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">{member.profile?.email}</p>
                    <p className="text-xs text-muted-foreground">Desde {formatDate(member.createdAt)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {canManage && !isOwner && !isSelf ? (
                    <>
                      <label className="sr-only" htmlFor={`role-${member.id}`}>
                        Rol de {name}
                      </label>
                      <Select
                        id={`role-${member.id}`}
                        className="h-8 w-40"
                        value={member.role}
                        disabled={updateRole.isPending}
                        onChange={(event) => changeRole(member, event.target.value as AssignableRole)}
                      >
                        {ASSIGNABLE.map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABELS[role]}
                          </option>
                        ))}
                      </Select>
                      <Button variant="ghost" size="icon" aria-label={`Quitar a ${name}`} onClick={() => setRemoving(member)}>
                        <Trash2 />
                      </Button>
                    </>
                  ) : (
                    <Badge variant={isOwner ? "default" : "secondary"} title={ROLE_DESCRIPTIONS[member.role]}>
                      {ROLE_LABELS[member.role]}
                    </Badge>
                  )}
                </div>
              </div>
            );
          })}
        </Card>
      )}

      <div className="mt-6 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
        {(["OWNER", ...ASSIGNABLE] as const).map((role) => (
          <div key={role} className="rounded-md border p-3">
            <p className="font-medium">{ROLE_LABELS[role]}</p>
            <p className="text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</p>
          </div>
        ))}
      </div>

      <AddMemberDialog open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Quitar miembro"
        description={`${removing?.profile?.email ?? "Esta persona"} perderá el acceso a la organización.`}
        confirmLabel="Quitar"
        onConfirm={async () => {
          if (!removing) return;
          await remove.mutateAsync(removing.id);
          toast.success("Miembro eliminado");
        }}
      />
    </div>
  );
}
