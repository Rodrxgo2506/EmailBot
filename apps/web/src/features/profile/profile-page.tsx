import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader } from "@/components/ui/display";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/form-controls";
import { getAuthErrorMessage } from "@/lib/errors";
import { ROLE_LABELS } from "@/lib/labels";
import { supabase } from "@/lib/supabase";
import { useAuth, useUserDisplayName } from "@/providers/auth-provider";
import { useOrganization } from "@/providers/organization-provider";

const profileSchema = z.object({ fullName: z.string().trim().min(2, "Mínimo 2 caracteres").max(200) });
const passwordSchema = z
  .object({ password: z.string().min(8, "Mínimo 8 caracteres").max(72), confirm: z.string() })
  .refine((values) => values.password === values.confirm, { path: ["confirm"], message: "Las contraseñas no coinciden" });

/**
 * Profile data lives in Supabase Auth user metadata; the existing
 * on_auth_user_updated trigger copies full_name into public.profiles.
 */
export function ProfilePage() {
  const { user, signOut } = useAuth();
  const displayName = useUserDisplayName();
  const { memberships, organization, switchOrganization } = useOrganization();

  const profileForm = useForm({ resolver: zodResolver(profileSchema), values: { fullName: displayName } });
  const passwordForm = useForm({ resolver: zodResolver(passwordSchema), defaultValues: { password: "", confirm: "" } });

  const saveProfile = profileForm.handleSubmit(async ({ fullName }) => {
    const { error } = await supabase.auth.updateUser({ data: { full_name: fullName } });
    if (error) toast.error(getAuthErrorMessage(error));
    else toast.success("Perfil actualizado");
  });

  const savePassword = passwordForm.handleSubmit(async ({ password }) => {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      toast.error(getAuthErrorMessage(error));
      return;
    }
    passwordForm.reset();
    toast.success("Contraseña actualizada");
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Perfil" description={user?.email ?? undefined} />

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Datos personales</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveProfile} className="grid gap-4" noValidate>
              <Field label="Correo" htmlFor="profile-email">
                <Input id="profile-email" value={user?.email ?? ""} disabled />
              </Field>
              <Field label="Nombre completo" htmlFor="profile-name" error={profileForm.formState.errors.fullName?.message}>
                <Input id="profile-name" autoComplete="name" {...profileForm.register("fullName")} />
              </Field>
              <Button type="submit" className="justify-self-start" disabled={profileForm.formState.isSubmitting}>
                Guardar
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cambiar contraseña</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={savePassword} className="grid gap-4" noValidate>
              <Field label="Nueva contraseña" htmlFor="profile-password" error={passwordForm.formState.errors.password?.message}>
                <Input id="profile-password" type="password" autoComplete="new-password" {...passwordForm.register("password")} />
              </Field>
              <Field label="Confirmar contraseña" htmlFor="profile-confirm" error={passwordForm.formState.errors.confirm?.message}>
                <Input id="profile-confirm" type="password" autoComplete="new-password" {...passwordForm.register("confirm")} />
              </Field>
              <Button type="submit" className="justify-self-start" disabled={passwordForm.formState.isSubmitting}>
                Actualizar contraseña
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Mis organizaciones</CardTitle>
          <CardDescription>Tu rol en cada organización.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y p-0">
          {memberships.map((membership) => (
            <div key={membership.organization.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{membership.organization.name}</p>
                <p className="font-mono text-xs text-muted-foreground">{membership.organization.slug}</p>
              </div>
              <Badge variant="secondary">{ROLE_LABELS[membership.role]}</Badge>
              {membership.organization.id === organization?.id ? (
                <Badge>Activa</Badge>
              ) : (
                <Button variant="outline" size="sm" onClick={() => switchOrganization(membership.organization.id)}>
                  Usar
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Button variant="outline" onClick={() => void signOut()}>
        Cerrar sesión
      </Button>
    </div>
  );
}
