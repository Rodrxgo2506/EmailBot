import type { PlanCatalogEntry } from "@emailbot/types";
import { Building2, Check, Crown, Database, Mail, Minus, UserCog, Users, Workflow, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { comparisonGroups } from "./plans-model";

/*
 * Presentation only: icons and soft accent colours; every text and value comes from comparisonGroups.
 * Light and dark use the existing theme (index.css tokens; Tailwind `dark:` follows <html data-theme>, like the tokens).
 */

const PLAN_ICONS: Record<string, { icon: LucideIcon; tone: string }> = {
  BASIC: { icon: Mail, tone: "bg-sky-50 text-sky-600 ring-sky-100 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-400/20" },
  PRO: { icon: Crown, tone: "bg-primary/10 text-primary ring-primary/15 dark:bg-primary/15 dark:ring-primary/30" },
  BUSINESS: { icon: Building2, tone: "bg-violet-50 text-violet-600 ring-violet-100 dark:bg-violet-400/10 dark:text-violet-300 dark:ring-violet-400/20" }
};

/** Dark only: hairline primary edges around the highlighted column (inset shadows: no layout change). */
const FEATURED_EDGES =
  "dark:shadow-[inset_1px_0_0_color-mix(in_oklab,var(--primary)_28%,transparent),inset_-1px_0_0_color-mix(in_oklab,var(--primary)_28%,transparent)]";

const GROUP_STYLES: Record<string, { icon: LucideIcon; band: string; label: string; tile: string }> = {
  Correo: {
    icon: Mail,
    band: "bg-blue-50/70 dark:bg-blue-400/[0.08]",
    label: "text-blue-700 dark:text-blue-300",
    tile: "bg-blue-100 text-blue-600 dark:bg-blue-400/15 dark:text-blue-300 dark:ring-1 dark:ring-blue-400/20"
  },
  Automatización: {
    icon: Workflow,
    band: "bg-sky-50/70 dark:bg-sky-400/[0.08]",
    label: "text-sky-700 dark:text-sky-300",
    tile: "bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300 dark:ring-1 dark:ring-sky-400/20"
  },
  "Clientes y portal": {
    icon: Users,
    band: "bg-violet-50/70 dark:bg-violet-400/[0.08]",
    label: "text-violet-700 dark:text-violet-300",
    tile: "bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300 dark:ring-1 dark:ring-violet-400/20"
  },
  Equipo: {
    icon: UserCog,
    band: "bg-emerald-50/70 dark:bg-emerald-400/[0.08]",
    label: "text-emerald-700 dark:text-emerald-300",
    tile: "bg-emerald-100 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300 dark:ring-1 dark:ring-emerald-400/20"
  },
  Almacenamiento: {
    icon: Database,
    band: "bg-amber-50/70 dark:bg-amber-400/[0.08]",
    label: "text-amber-700 dark:text-amber-300",
    tile: "bg-amber-100 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-1 dark:ring-amber-400/20"
  }
};

const NEUTRAL_GROUP = { band: "bg-muted/60", label: "text-muted-foreground", tile: "bg-muted text-muted-foreground" };

/** Opaque equivalent of bg-muted/50 over the card, for the sticky first column (content scrolls beneath it). */
const ROW_HOVER = "group-hover/row:bg-[color-mix(in_oklab,var(--muted)_55%,var(--card))]";

/** Feature comparison of the catalog plans; scrolls horizontally inside its box on narrow screens. */
export function PlanComparison({ plans }: { plans: readonly PlanCatalogEntry[] }) {
  // The highlighted plan of the catalog (same rule as the pricing cards): a soft tint on its column.
  const featured = plans.map((plan) => plan.badge !== null);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_1px_2px_rgb(15_23_42/0.04),0_12px_32px_-16px_rgb(15_23_42/0.14)]",
        // Dark: the card token on the darker page, a slightly stronger edge, a faint top highlight and a deep shadow.
        "dark:border-border dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.04),0_24px_48px_-24px_rgb(0_0_0/0.65)]"
      )}
    >
      {/* relative: the containing block of the sr-only spans, so they cannot widen the page past the scroll box. */}
      <div className="relative overflow-x-auto">
        {/* Phones: a narrower first column, so the next plan column peeks in and the scroll is evident. */}
        <table className="w-full min-w-[34rem] table-fixed border-separate border-spacing-0 text-sm sm:min-w-[40rem] [&>tbody:last-child>tr:last-child>*]:border-b-0">
          <caption className="sr-only">Comparación de planes</caption>
          <colgroup>
            <col className="w-[10.5rem] sm:w-[34%]" />
            {plans.map((plan) => (
              <col key={plan.code} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 border-b border-border/70 bg-card px-4 py-5 text-left align-bottom text-sm font-semibold text-foreground sm:px-6 dark:border-border"
              >
                Característica
              </th>
              {plans.map((plan, index) => {
                const visual = PLAN_ICONS[plan.code];
                const Icon = visual?.icon ?? Mail;
                return (
                  <th
                    key={plan.code}
                    scope="col"
                    className={cn(
                      "relative border-b border-border/70 px-3 py-5 align-bottom font-semibold dark:border-border",
                      featured[index] && ["bg-primary/[0.06] dark:bg-primary/[0.11]", FEATURED_EDGES]
                    )}
                  >
                    {featured[index] ? <span aria-hidden className="absolute inset-x-0 top-0 h-[3px] bg-primary" /> : null}
                    <span className="flex flex-col items-center gap-2.5">
                      <span
                        aria-hidden
                        className={cn(
                          "flex size-10 items-center justify-center rounded-xl ring-1",
                          visual?.tone ?? "bg-muted text-muted-foreground ring-border"
                        )}
                      >
                        <Icon className="size-5" />
                      </span>
                      <span className={cn("text-base tracking-tight", featured[index] ? "text-primary" : "text-foreground")}>{plan.name}</span>
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          {comparisonGroups(plans).map((group) => {
            const style = GROUP_STYLES[group.title];
            const GroupIcon = style?.icon;
            const tone = style ?? NEUTRAL_GROUP;
            return (
              <tbody key={group.title}>
                <tr>
                  <th scope="colgroup" colSpan={plans.length + 1} className={cn("border-b border-border/60 p-0 text-left", tone.band)}>
                    {/* sticky: the category stays readable while the table scrolls horizontally. */}
                    <span className="sticky left-0 inline-flex items-center gap-2.5 px-4 py-2.5 sm:px-6">
                      {GroupIcon ? (
                        <span aria-hidden className={cn("flex size-6 items-center justify-center rounded-md", tone.tile)}>
                          <GroupIcon className="size-3.5" />
                        </span>
                      ) : null}
                      <span className={cn("text-xs font-semibold tracking-wider uppercase", tone.label)}>{group.title}</span>
                    </span>
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <tr key={row.key} className="group/row">
                    <th
                      scope="row"
                      className={cn(
                        "sticky left-0 z-10 border-b border-border/60 bg-card px-4 py-3.5 text-left font-normal text-foreground/90 transition-colors sm:px-6",
                        ROW_HOVER
                      )}
                    >
                      {row.label}
                    </th>
                    {row.values.map((value, index) => (
                      <td
                        key={plans[index]?.code ?? index}
                        className={cn(
                          "border-b border-border/60 px-3 py-3.5 text-center font-medium text-foreground tabular-nums transition-colors",
                          featured[index]
                            ? ["bg-primary/[0.04] group-hover/row:bg-primary/[0.08] dark:bg-primary/[0.07] dark:group-hover/row:bg-primary/[0.12]", FEATURED_EDGES]
                            : ROW_HOVER
                        )}
                      >
                        {typeof value === "string" ? (
                          value
                        ) : value ? (
                          <>
                            {/* Dark: the primary token deepened (a white check stays legible), with a faint primary ring. */}
                            <span
                              aria-hidden
                              className="mx-auto flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm dark:bg-[color-mix(in_oklab,var(--primary)_86%,black)] dark:text-white dark:shadow-none dark:ring-1 dark:ring-primary/35"
                            >
                              <Check className="size-3" strokeWidth={3} />
                            </span>
                            <span className="sr-only">Incluido</span>
                          </>
                        ) : (
                          <>
                            <Minus className="mx-auto size-4 text-muted-foreground/75 dark:text-muted-foreground/70" aria-hidden />
                            <span className="sr-only">No incluido</span>
                          </>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      </div>
    </div>
  );
}
