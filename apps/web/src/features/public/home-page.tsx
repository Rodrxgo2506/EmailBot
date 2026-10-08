import {
  ArrowRight,
  Boxes,
  Filter,
  Inbox,
  KeyRound,
  Mail,
  ShieldCheck,
  Tags,
  UserRoundCheck,
  Users,
  type LucideIcon
} from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { usePlanCatalog } from "@/features/plans/api";
import { formatPrice, monthlyPrice } from "@/features/plans/plans-model";
import { usePageMeta } from "@/lib/page-meta";
import { PublicLayout } from "./public-layout";

/*
 * Public home (/ for visitors without a session; signed-in users keep the panel at /).
 * Describes only what EmailBot does today. Prices come from GET /api/plans.
 */

const STEPS: Array<{ title: string; text: string; icon: LucideIcon }> = [
  {
    icon: Mail,
    title: "Conecta tus correos",
    text: "Autoriza tus cuentas de Gmail y, en los planes Pro y Business, también Microsoft Outlook / 365. EmailBot solo lee: no envía correos en tu nombre."
  },
  {
    icon: Filter,
    title: "Define tus reglas",
    text: "Indica qué mensajes te interesan según remitente, destinatario, asunto, contenido, fecha o adjuntos. Los correos que no coinciden con ninguna regla no se guardan."
  },
  {
    icon: UserRoundCheck,
    title: "Entrega a cada cliente",
    text: "Cada cliente recibe en su portal privado, con su propio código de acceso, solo los correos que le corresponden."
  }
];

const FEATURES: Array<{ title: string; text: string; icon: LucideIcon }> = [
  { icon: Tags, title: "Reglas y categorías", text: "Clasifica los correos, márcalos como importantes o leídos y extrae datos como códigos de verificación." },
  { icon: Boxes, title: "Bots por servicio", text: "Agrupa las reglas de cada servicio que atiendes para ordenar qué correo va a qué cliente." },
  { icon: KeyRound, title: "Portal de clientes", text: "Tus clientes consultan sus correos en un portal propio, sin acceso a tus cuentas ni a los demás clientes." },
  { icon: Inbox, title: "Bandeja en tiempo real", text: "Los correos procesados aparecen en el panel en cuanto llegan, con búsqueda y filtros." },
  { icon: Users, title: "Trabajo en equipo", text: "Invita a tu equipo con roles de propietario, administrador, operador o solo lectura." },
  { icon: ShieldCheck, title: "Seguridad y control", text: "Credenciales cifradas, datos separados por organización y registro de auditoría de las acciones." }
];

function PlansTeaser() {
  const catalog = usePlanCatalog();
  const prices = (catalog.data ?? []).map((plan) => monthlyPrice(plan)).filter((price) => price !== null);
  const cheapest = prices.length ? prices.reduce((min, price) => (price.amountCents < min.amountCents ? price : min)) : null;
  return (
    <p className="text-sm text-muted-foreground" data-testid="plans-teaser">
      {cheapest ? <>Planes desde {formatPrice(cheapest)} al mes, IGV incluido.</> : <>Planes mensuales y anuales en soles, IGV incluido.</>}
    </p>
  );
}

/** Decorative preview of the product (no real data). */
function ProductPreview() {
  const rows = [
    { from: "Netflix", subject: "Tu código de inicio de sesión", tag: "Códigos", tone: "bg-primary/10 text-primary" },
    { from: "Banco", subject: "Constancia de operación", tag: "Finanzas", tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
    { from: "Disney+", subject: "Verifica tu cuenta", tag: "Códigos", tone: "bg-primary/10 text-primary" }
  ];
  return (
    <div aria-hidden className="relative mx-auto w-full max-w-md">
      <div className="absolute -inset-6 -z-10 rounded-[2rem] bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--primary)_18%,transparent),transparent)]" />
      <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-[0_24px_56px_-28px_rgb(15_23_42/0.35)] dark:border-border dark:shadow-[0_24px_56px_-24px_rgb(0_0_0/0.7)]">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold">Bandeja</span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-2 rounded-full bg-emerald-500" />
            Tiempo real
          </span>
        </div>
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.subject} className="flex items-center gap-3 rounded-xl border border-border/60 bg-background/60 p-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold text-muted-foreground">
                {row.from.slice(0, 2)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{row.from}</span>
                <span className="block truncate text-xs text-muted-foreground">{row.subject}</span>
              </span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${row.tone}`}>{row.tag}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-primary/[0.06] p-3 text-xs text-muted-foreground dark:bg-primary/10">
          <KeyRound className="size-4 text-primary" />
          Entregado al portal del cliente
        </div>
      </div>
    </div>
  );
}

export function HomePage() {
  usePageMeta(
    "EmailBot · Automatiza y organiza los correos que recibes",
    "EmailBot conecta tus cuentas de correo, procesa con reglas solo los mensajes que te interesan y entrega a cada cliente lo que le corresponde en su portal privado."
  );

  return (
    <PublicLayout>
      <section className="relative isolate overflow-hidden">
        <div aria-hidden className="absolute inset-x-0 top-0 -z-10 h-[34rem] bg-[radial-gradient(60rem_24rem_at_50%_-6rem,color-mix(in_oklab,var(--primary)_11%,transparent),transparent_70%)] dark:bg-[radial-gradient(60rem_24rem_at_50%_-6rem,color-mix(in_oklab,var(--primary)_17%,transparent),transparent_70%)]" />
        <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pt-14 pb-16 sm:px-6 sm:pt-20 lg:grid-cols-2">
          <div className="text-center lg:text-left">
            <h1 className="text-4xl leading-[1.1] font-semibold tracking-tight text-foreground sm:text-5xl">
              Automatiza y organiza los correos que recibes
            </h1>
            <p className="mt-5 text-base text-muted-foreground sm:text-lg">
              EmailBot conecta tus cuentas de correo, procesa con reglas solo los mensajes que te interesan y entrega a cada uno de tus clientes
              los correos que le corresponden, en su propio portal.
            </p>
            <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start">
              <Button asChild size="lg" className="h-11 w-full rounded-xl px-6 sm:w-auto">
                <Link to="/register">
                  Crear cuenta
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="h-11 w-full rounded-xl px-6 sm:w-auto">
                <Link to="/planes">Ver planes y precios</Link>
              </Button>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              ¿Ya tienes una cuenta?{" "}
              <Link to="/login" className="font-medium text-primary hover:underline">
                Iniciar sesión
              </Link>
            </p>
          </div>
          <ProductPreview />
        </div>
      </section>

      <section aria-labelledby="how-title" className="border-t bg-card/40">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6">
          <h2 id="how-title" className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">
            Cómo funciona
          </h2>
          <ol className="mt-10 grid gap-6 md:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={step.title} className="rounded-2xl border border-border/70 bg-card p-6 dark:border-border">
                <span aria-hidden className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <step.icon className="size-5" />
                </span>
                <h3 className="mt-4 font-semibold">
                  <span className="mr-1.5 text-muted-foreground">{index + 1}.</span>
                  {step.title}
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">{step.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="features-title">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6">
          <h2 id="features-title" className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">
            Todo lo que necesitas para ordenar tus correos
          </h2>
          <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="flex gap-4">
                <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground/80">
                  <feature.icon className="size-5" />
                </span>
                <div>
                  <h3 className="font-semibold">{feature.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{feature.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="plans-cta-title" className="border-t bg-card/40">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-4 px-4 py-16 text-center sm:px-6">
          <h2 id="plans-cta-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Elige el plan para tu operación
          </h2>
          <PlansTeaser />
          <p className="max-w-2xl text-sm text-muted-foreground">
            Cada plan incluye un número de cuentas de correo, reglas, bots, clientes y miembros del equipo. Compara todos los detalles en la
            página de planes.
          </p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <Button asChild className="h-11 rounded-xl px-6">
              <Link to="/planes">Ver planes y precios</Link>
            </Button>
            <Button asChild variant="outline" className="h-11 rounded-xl px-6">
              <Link to="/contacto">Contactar con EmailBot</Link>
            </Button>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
