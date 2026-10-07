import { zodResolver } from "@hookform/resolvers/zod";
import { slugify } from "@emailbot/validation";
import { Building2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/display";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/form-controls";
import { AuthLayout } from "@/features/auth/auth-layout";
import { useCreateOrganization } from "@/features/organization/api";
import { useAuth } from "@/providers/auth-provider";
import { useOrganization } from "@/providers/organization-provider";

const schema = z.object({
  name: z.string().trim().min(2, "Mínimo 2 caracteres").max(120),
  slug: z
    .string()
    .trim()
    .max(60)
    .regex(/^$|^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Solo minúsculas, números y guiones")
});

/** Creates a workspace (POST /api/organizations); the creator becomes OWNER. */
export function OnboardingPage() {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const { memberships, switchOrganization, isPlatformAdmin } = useOrganization();
  const create = useCreateOrganization();
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { name: "", slug: "" } });
  const name = form.watch("name");

  const onSubmit = form.handleSubmit(async (values) => {
    const { organization } = await create.mutateAsync({
      name: values.name,
      ...(values.slug ? { slug: values.slug } : {})
    });
    switchOrganization(organization.id);
    toast.success(`Organización "${organization.name}" creada`);
    navigate("/", { replace: true });
  });

  return (
    <AuthLayout
      title="Crea tu organización"
      description="Una organización agrupa tus cuentas de correo, reglas y miembros. EmailBot es un servicio de pago: para usarla necesitará una suscripción activa."
      footer={
        memberships.length > 0 ? (
          <Button variant="link" onClick={() => navigate("/")}>
            Volver
          </Button>
        ) : (
          <Button variant="link" onClick={() => void signOut()}>
            Cerrar sesión
          </Button>
        )
      }
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <div className="flex justify-center text-primary">
          <Building2 className="size-10" />
        </div>
        {isPlatformAdmin ? (
          <Button variant="outline" type="button" onClick={() => navigate("/admin")}>
            Ir a Administración de plataforma
          </Button>
        ) : null}
        <ErrorMessage error={create.error} />
        <Field label="Nombre" htmlFor="org-name" error={form.formState.errors.name?.message}>
          <Input id="org-name" placeholder="Mi empresa" {...form.register("name")} />
        </Field>
        <Field
          label="Identificador (opcional)"
          htmlFor="org-slug"
          hint={`Se usará "${slugify(name) || "mi-empresa"}" si lo dejas vacío.`}
          error={form.formState.errors.slug?.message}
        >
          <Input id="org-slug" placeholder="mi-empresa" {...form.register("slug")} />
        </Field>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creando…" : "Crear organización"}
        </Button>
      </form>
    </AuthLayout>
  );
}
