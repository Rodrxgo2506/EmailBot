import type { PlanCatalogEntry } from "@emailbot/types";
import { Check, Minus } from "lucide-react";
import { comparisonGroups } from "./plans-model";

/** Feature comparison of the catalog plans; scrolls horizontally inside its box on narrow screens. */
export function PlanComparison({ plans }: { plans: readonly PlanCatalogEntry[] }) {
  return (
    // relative: the containing block of the sr-only spans, so they cannot widen the page past the scroll box.
    <div className="relative overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[34rem] text-sm">
        <caption className="sr-only">Comparación de planes</caption>
        <thead>
          <tr className="border-b bg-muted/40">
            <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">
              Característica
            </th>
            {plans.map((plan) => (
              <th key={plan.code} scope="col" className="px-4 py-3 text-center font-semibold">
                {plan.name}
              </th>
            ))}
          </tr>
        </thead>
        {comparisonGroups(plans).map((group) => (
          <tbody key={group.title}>
            <tr className="border-b bg-muted/20">
              <th scope="colgroup" colSpan={plans.length + 1} className="px-4 py-2 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {group.title}
              </th>
            </tr>
            {group.rows.map((row) => (
              <tr key={row.key} className="border-b last:border-b-0">
                <th scope="row" className="px-4 py-2.5 text-left font-normal">
                  {row.label}
                </th>
                {row.values.map((value, index) => (
                  <td key={plans[index]?.code ?? index} className="px-4 py-2.5 text-center tabular-nums">
                    {typeof value === "string" ? (
                      value
                    ) : value ? (
                      <>
                        <Check className="mx-auto size-4 text-primary" aria-hidden />
                        <span className="sr-only">Incluido</span>
                      </>
                    ) : (
                      <>
                        <Minus className="mx-auto size-4 text-muted-foreground" aria-hidden />
                        <span className="sr-only">No incluido</span>
                      </>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
