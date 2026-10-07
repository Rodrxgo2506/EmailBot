import { INBOX_FILTERS, type OrganizationSettings } from "@emailbot/types";
import { zodResolver } from "@hookform/resolvers/zod";
import { Crown } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorMessage, PageHeader } from "@/components/ui/display";
import { ConfirmDialog, SkeletonRows } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { CheckboxCard, Input, Select } from "@/components/ui/form-controls";
import { getErrorMessage } from "@/lib/errors";
import { ORGANIZATION_STATUS_LABELS, planLabel } from "@/lib/labels";
import { formatDate } from "@/lib/utils";
import { useAuth } from "@/providers/auth-provider";
import { useOrganization } from "@/providers/organization-provider";
import { useCurrentOrganization, useMembers, useOrganizationMutations, type SettingsPatch } from "./api";
import { PlanCard } from "./plan-card";

const INBOX_FILTER_LABELS: Record<(typeof INBOX_FILTERS)[number], string> = {
  ALL: "Todos",
  UNREAD: "No leídos",
  IMPORTANT: "Importantes",
  ATTACHMENTS: "Con adjuntos"
};

const generalSchema = z.object({
  name: z.string().trim().min(2, "Mínimo 2 caracteres").max(120),
  slug: z.string().trim().min(1).max(60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Solo minúsculas, números y guiones")
});

const settingsSchema = z.object({
  timezone: z.string().trim().min(1).max(100),
  language: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/, "Ej. es o es-PE"),
  autoProcessingEnabled: z.boolean(),
  processAttachments: z.boolean(),
  notificationsEnabled: z.boolean(),
  // Not shown (EmailBot V2 phase 7), so the panel does not offer what does not exist:
  //  - email notifications: never implemented (no outbound mail provider); removed from the API and the rules contract.
  //  - email retention days: nothing deletes emails by age (field removed from the API).
  //  Both database columns stay unused (no destructive migration).
  defaultInboxFilter: z.enum(INBOX_FILTERS)
});

function GeneralCard({ name, slug, canEdit }: { name: string; slug: string; canEdit: boolean }) {
  const { update } = useOrganizationMutations();
  const form = useForm({ resolver: zodResolver(generalSchema), values: { name, slug } });

  const onSubmit = form.handleSubmit(async (values) => {
    await update.mutateAsync(values);
    toast.success("Organización actualizada");
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>Nombre e identificador de la organización.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate>
          <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2">
            <ErrorMessage error={update.error ? new Error(getErrorMessage(update.error)) : null} />
            <Field label="Nombre" htmlFor="org-name" error={form.formState.errors.name?.message}>
              <Input id="org-name" {...form.register("name")} />
            </Field>
            <Field label="Identificador" htmlFor="org-slug" error={form.formState.errors.slug?.message}>
              <Input id="org-slug" className="font-mono" {...form.register("slug")} />
            </Field>
            {canEdit ? (
              <div className="sm:col-span-2">
                <Button type="submit" disabled={update.isPending || !form.formState.isDirty}>
                  Guardar
                </Button>
              </div>
            ) : null}
          </fieldset>
        </form>
      </CardContent>
    </Card>
  );
}

function SettingsCard({ settings, canEdit }: { settings: OrganizationSettings; canEdit: boolean }) {
  const { updateSettings } = useOrganizationMutations();
  const form = useForm({
    resolver: zodResolver(settingsSchema),
    values: {
      timezone: settings.timezone,
      language: settings.language,
      autoProcessingEnabled: settings.autoProcessingEnabled,
      processAttachments: settings.processAttachments,
      notificationsEnabled: settings.notificationsEnabled,
      defaultInboxFilter: settings.defaultInboxFilter
    }
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const patch: SettingsPatch = { ...values };
    await updateSettings.mutateAsync(patch);
    toast.success("Configuración guardada");
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Procesamiento y notificaciones</CardTitle>
        <CardDescription>Actualizado {formatDate(settings.updatedAt)}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate>
          <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2">
            <ErrorMessage error={updateSettings.error ? new Error(getErrorMessage(updateSettings.error)) : null} />
            <Field label="Zona horaria" htmlFor="settings-tz" hint="Identificador IANA, ej. America/Lima" error={form.formState.errors.timezone?.message}>
              <Input id="settings-tz" {...form.register("timezone")} />
            </Field>
            <Field label="Idioma" htmlFor="settings-lang" error={form.formState.errors.language?.message}>
              <Input id="settings-lang" {...form.register("language")} />
            </Field>
            <Field label="Vista inicial de la bandeja" htmlFor="settings-inbox">
              <Select id="settings-inbox" {...form.register("defaultInboxFilter")}>
                {INBOX_FILTERS.map((filter) => (
                  <option key={filter} value={filter}>
                    {INBOX_FILTER_LABELS[filter]}
                  </option>
                ))}
              </Select>
            </Field>
            <CheckboxCard label="Procesamiento automático" description="Evaluar reglas con cada correo nuevo." {...form.register("autoProcessingEnabled")} />
            <CheckboxCard label="Guardar adjuntos" description="Almacenar el contenido de adjuntos en Storage privado." {...form.register("processAttachments")} />
            <CheckboxCard label="Notificaciones" description="Notificaciones en la aplicación de las reglas." {...form.register("notificationsEnabled")} />
            {canEdit ? (
              <div className="sm:col-span-2">
                <Button type="submit" disabled={updateSettings.isPending || !form.formState.isDirty}>
                  Guardar configuración
                </Button>
              </div>
            ) : null}
          </fieldset>
        </form>
      </CardContent>
    </Card>
  );
}

function TransferOwnershipCard() {
  const { user } = useAuth();
  const members = useMembers();
  const { transferOwnership } = useOrganizationMutations();
  const [target, setTarget] = useState("");
  const [confirming, setConfirming] = useState(false);
  const candidates = (members.data ?? []).filter((member) => member.userId !== user?.id);
  const selected = candidates.find((member) => member.userId === target);

  useEffect(() => {
    if (target && !selected) setTarget("");
  }, [target, selected]);

  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Crown className="size-4" /> Transferir propiedad
        </CardTitle>
        <CardDescription>El nuevo propietario debe ser miembro. Tú pasarás a ser Administrador.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor="transfer-target" className="sr-only">
          Nuevo propietario
        </label>
        <Select id="transfer-target" value={target} onChange={(event) => setTarget(event.target.value)} className="sm:max-w-sm">
          <option value="">Selecciona un miembro…</option>
          {candidates.map((member) => (
            <option key={member.id} value={member.userId}>
              {member.profile?.fullName ?? member.profile?.email ?? member.userId}
            </option>
          ))}
        </Select>
        <Button variant="destructive" disabled={!selected} onClick={() => setConfirming(true)}>
          Transferir
        </Button>
      </CardContent>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Transferir propiedad"
        description={`${selected?.profile?.email ?? "El miembro"} será el nuevo OWNER y tu rol cambiará a Administrador. Solo el nuevo propietario podrá revertirlo.`}
        confirmLabel="Transferir propiedad"
        onConfirm={async () => {
          await transferOwnership.mutateAsync(target);
          toast.success("Propiedad transferida");
          setTarget("");
        }}
      />
    </Card>
  );
}

export function SettingsPage() {
  const { can, role } = useOrganization();
  const current = useCurrentOrganization();

  if (current.isPending) return <SkeletonRows rows={5} />;
  if (current.error) return <ErrorMessage error={new Error(getErrorMessage(current.error))} />;

  const { organization, settings } = current.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Configuración de la organización"
        description="Los cambios quedan registrados en la auditoría."
        actions={
          <Badge variant="secondary">
            {organization.plan ? `Plan ${planLabel(organization.plan)}` : "Sin plan"} · {ORGANIZATION_STATUS_LABELS[organization.status]}
          </Badge>
        }
      />
      <GeneralCard name={organization.name} slug={organization.slug} canEdit={can("organization:update")} />
      <PlanCard />
      {settings ? <SettingsCard settings={settings} canEdit={can("settings:update")} /> : null}
      {role === "OWNER" ? <TransferOwnershipCard /> : null}
    </div>
  );
}
