import { zodResolver } from "@hookform/resolvers/zod";
import { MailCheck } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/display";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/form-controls";
import { getAuthErrorMessage } from "@/lib/errors";
import { markPendingLoginEvent } from "@/lib/login-event";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/providers/auth-provider";
import { AuthLayout } from "./auth-layout";

const email = z.email("Ingresa un correo válido");
const password = z.string().min(8, "Mínimo 8 caracteres").max(72, "Máximo 72 caracteres");

/* ------------------------------------------------------------------ */

const loginSchema = z.object({ email, password: z.string().min(1, "Ingresa tu contraseña") });

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<unknown>(null);
  const form = useForm({ resolver: zodResolver(loginSchema), defaultValues: { email: "", password: "" } });
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword(values);
    if (signInError) {
      setError(new Error(getAuthErrorMessage(signInError)));
      return;
    }
    markPendingLoginEvent();
    navigate(from.startsWith("/") ? from : "/", { replace: true });
  });

  return (
    <AuthLayout
      title="Iniciar sesión"
      description="Accede a tu espacio de trabajo"
      footer={
        <>
          ¿No tienes cuenta?{" "}
          <Link to="/register" className="font-medium text-primary hover:underline">
            Regístrate
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <ErrorMessage error={error} />
        <Field label="Correo" htmlFor="email" error={form.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" {...form.register("email")} />
        </Field>
        <Field label="Contraseña" htmlFor="password" error={form.formState.errors.password?.message}>
          <Input id="password" type="password" autoComplete="current-password" {...form.register("password")} />
        </Field>
        <div className="-mt-2 text-right">
          <Link to="/forgot-password" className="text-xs text-primary hover:underline">
            ¿Olvidaste tu contraseña?
          </Link>
        </div>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? "Ingresando…" : "Ingresar"}
        </Button>
      </form>
    </AuthLayout>
  );
}

/* ------------------------------------------------------------------ */

const registerSchema = z
  .object({
    fullName: z.string().trim().min(2, "Ingresa tu nombre").max(200),
    email,
    password,
    confirm: z.string()
  })
  .refine((values) => values.password === values.confirm, { path: ["confirm"], message: "Las contraseñas no coinciden" });

export function RegisterPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(registerSchema),
    defaultValues: { fullName: "", email: "", password: "", confirm: "" }
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
      // Stored in raw_user_meta_data; the handle_new_user trigger copies it to profiles.
      options: { data: { full_name: values.fullName }, emailRedirectTo: `${window.location.origin}/` }
    });
    if (signUpError) {
      setError(new Error(getAuthErrorMessage(signUpError)));
      return;
    }
    if (data.session) {
      markPendingLoginEvent();
      navigate("/onboarding", { replace: true });
    } else {
      setPendingConfirmation(values.email);
    }
  });

  if (pendingConfirmation) {
    return (
      <AuthLayout title="Revisa tu correo" description={`Enviamos un enlace de confirmación a ${pendingConfirmation}.`}>
        <div className="flex flex-col items-center gap-4 text-center text-sm text-muted-foreground">
          <MailCheck className="size-10 text-primary" />
          Confirma tu correo y luego inicia sesión.
          <Button asChild variant="outline" className="w-full">
            <Link to="/login">Ir a iniciar sesión</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Crear cuenta"
      description="Empieza a procesar tus correos con reglas"
      footer={
        <>
          ¿Ya tienes cuenta?{" "}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Inicia sesión
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <ErrorMessage error={error} />
        <Field label="Nombre completo" htmlFor="fullName" error={form.formState.errors.fullName?.message}>
          <Input id="fullName" autoComplete="name" {...form.register("fullName")} />
        </Field>
        <Field label="Correo" htmlFor="email" error={form.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" {...form.register("email")} />
        </Field>
        <Field label="Contraseña" htmlFor="password" error={form.formState.errors.password?.message}>
          <Input id="password" type="password" autoComplete="new-password" {...form.register("password")} />
        </Field>
        <Field label="Confirmar contraseña" htmlFor="confirm" error={form.formState.errors.confirm?.message}>
          <Input id="confirm" type="password" autoComplete="new-password" {...form.register("confirm")} />
        </Field>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? "Creando cuenta…" : "Crear cuenta"}
        </Button>
      </form>
    </AuthLayout>
  );
}

/* ------------------------------------------------------------------ */

export function ForgotPasswordPage() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const form = useForm({ resolver: zodResolver(z.object({ email })), defaultValues: { email: "" } });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(values.email, {
      redirectTo: `${window.location.origin}/reset-password`
    });
    if (resetError) {
      setError(new Error(getAuthErrorMessage(resetError)));
      return;
    }
    // Same message whether or not the email exists (no account enumeration).
    setSentTo(values.email);
  });

  return (
    <AuthLayout
      title="Recuperar contraseña"
      description="Te enviaremos un enlace para crear una nueva contraseña"
      footer={
        <Link to="/login" className="font-medium text-primary hover:underline">
          Volver a iniciar sesión
        </Link>
      }
    >
      {sentTo ? (
        <div className="flex flex-col items-center gap-3 text-center text-sm text-muted-foreground">
          <MailCheck className="size-10 text-primary" />
          Si existe una cuenta para {sentTo}, recibirás un enlace en unos minutos.
        </div>
      ) : (
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <ErrorMessage error={error} />
          <Field label="Correo" htmlFor="email" error={form.formState.errors.email?.message}>
            <Input id="email" type="email" autoComplete="email" {...form.register("email")} />
          </Field>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Enviando…" : "Enviar enlace"}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

/* ------------------------------------------------------------------ */

const resetSchema = z
  .object({ password, confirm: z.string() })
  .refine((values) => values.password === values.confirm, { path: ["confirm"], message: "Las contraseñas no coinciden" });

/** Reached from the recovery email link (Supabase opens a temporary session). */
export function ResetPasswordPage() {
  const navigate = useNavigate();
  const { session, loading, clearPasswordRecovery } = useAuth();
  const [error, setError] = useState<unknown>(null);
  const form = useForm({ resolver: zodResolver(resetSchema), defaultValues: { password: "", confirm: "" } });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const { error: updateError } = await supabase.auth.updateUser({ password: values.password });
    if (updateError) {
      setError(new Error(getAuthErrorMessage(updateError)));
      return;
    }
    clearPasswordRecovery();
    toast.success("Contraseña actualizada");
    navigate("/", { replace: true });
  });

  return (
    <AuthLayout title="Nueva contraseña" description="Elige una contraseña segura para tu cuenta">
      {!loading && !session ? (
        <div className="grid gap-4 text-sm text-muted-foreground">
          El enlace no es válido o expiró. Solicita uno nuevo.
          <Button asChild variant="outline">
            <Link to="/forgot-password">Solicitar enlace</Link>
          </Button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <ErrorMessage error={error} />
          <Field label="Nueva contraseña" htmlFor="password" error={form.formState.errors.password?.message}>
            <Input id="password" type="password" autoComplete="new-password" {...form.register("password")} />
          </Field>
          <Field label="Confirmar contraseña" htmlFor="confirm" error={form.formState.errors.confirm?.message}>
            <Input id="confirm" type="password" autoComplete="new-password" {...form.register("confirm")} />
          </Field>
          <Button type="submit" disabled={form.formState.isSubmitting || loading}>
            Guardar contraseña
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
