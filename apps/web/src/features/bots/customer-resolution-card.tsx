import { CUSTOMER_IDENTIFIER_TYPES, CUSTOMER_RESOLUTION_SOURCES, MULTIPLE_MATCH_POLICIES, type Bot } from "@emailbot/types";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorMessage } from "@/components/ui/display";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/form-controls";
import { useRules } from "@/features/rules/api";
import { getErrorMessage } from "@/lib/errors";
import { CUSTOMER_RESOLUTION_SOURCE_LABELS, IDENTIFIER_TYPE_LABELS, MULTIPLE_MATCH_POLICY_LABELS } from "@/lib/labels";
import { useBotMutations } from "./api";
import {
  deliveryEnabled,
  extractedFieldNames,
  resolutionError,
  resolutionHint,
  toResolutionForm,
  toResolutionPayload,
  type ResolutionFormValues
} from "./customer-resolution-model";

/** How the bot's emails reach the customer portal (bots.customer_resolution). */
export function CustomerResolutionCard({ bot, canManage }: { bot: Bot; canManage: boolean }) {
  const { update } = useBotMutations();
  const rules = useRules();
  const saved = JSON.stringify(bot.customerResolution);
  const [values, setValues] = useState<ResolutionFormValues>(() => toResolutionForm(bot.customerResolution));
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setValues(toResolutionForm(bot.customerResolution));
    setSubmitted(false);
    // Reset when the stored configuration changes (after saving or a refetch).
  }, [bot.id, saved]);

  const set = <K extends keyof ResolutionFormValues>(key: K, value: ResolutionFormValues[K]) => setValues((current) => ({ ...current, [key]: value }));
  const error = resolutionError(values);
  const dirty = JSON.stringify(toResolutionPayload(values)) !== JSON.stringify(toResolutionPayload(toResolutionForm(bot.customerResolution)));
  const fields = extractedFieldNames(rules.data ?? [], bot.id);
  const enabled = deliveryEnabled(bot.customerResolution);

  const save = async () => {
    setSubmitted(true);
    if (error) return;
    try {
      await update.mutateAsync({ id: bot.id, input: { customerResolution: toResolutionPayload(values) } });
      toast.success("Entrega al portal actualizada");
    } catch (cause) {
      toast.error(getErrorMessage(cause));
    }
  };

  return (
    <Card className={enabled ? undefined : "border-amber-500/40"}>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Entrega al portal</CardTitle>
          <Badge variant={enabled ? "success" : "warning"}>{enabled ? "Activa" : "Desactivada"}</Badge>
        </div>
        <CardDescription>
          Decide qué cliente recibe cada correo de este bot. Un cliente lo recibe solo si está asociado y activo en este bot y tiene un
          identificador que coincide.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!enabled ? (
          <p role="status" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            La entrega está desactivada: los correos de este bot no llegan al portal de ningún cliente. Los correos ya procesados no se
            reenvían al activarla; se entregan los que lleguen después.
          </p>
        ) : null}

        <Field label="Identificar al cliente por" htmlFor="resolution-source" hint={resolutionHint(values.source)}>
          <Select id="resolution-source" value={values.source} disabled={!canManage} onChange={(event) => set("source", event.target.value as ResolutionFormValues["source"])}>
            {CUSTOMER_RESOLUTION_SOURCES.map((source) => (
              <option key={source} value={source}>
                {CUSTOMER_RESOLUTION_SOURCE_LABELS[source]}
              </option>
            ))}
          </Select>
        </Field>

        {values.source === "EXTRACTED_FIELD" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Dato extraído"
              htmlFor="resolution-field"
              hint={fields.length === 0 ? "Nombre de una acción «Extraer» de las reglas de este bot." : undefined}
              error={submitted && error ? error : undefined}
            >
              {fields.length > 0 ? (
                <Select id="resolution-field" value={values.field} disabled={!canManage} onChange={(event) => set("field", event.target.value)}>
                  <option value="">Elige un dato…</option>
                  {[...new Set([...fields, ...(values.field ? [values.field] : [])])].sort().map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input id="resolution-field" placeholder="verification_code" value={values.field} disabled={!canManage} onChange={(event) => set("field", event.target.value)} />
              )}
            </Field>
            <Field label="Tipo de identificador" htmlFor="resolution-identifier-type">
              <Select
                id="resolution-identifier-type"
                value={values.identifierType}
                disabled={!canManage}
                onChange={(event) => set("identifierType", event.target.value as ResolutionFormValues["identifierType"])}
              >
                {CUSTOMER_IDENTIFIER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {IDENTIFIER_TYPE_LABELS[type]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : null}

        {values.source !== "NONE" ? (
          <Field label="Si coinciden varios clientes" htmlFor="resolution-multiple">
            <Select
              id="resolution-multiple"
              value={values.onMultipleMatches}
              disabled={!canManage}
              onChange={(event) => set("onMultipleMatches", event.target.value as ResolutionFormValues["onMultipleMatches"])}
            >
              {MULTIPLE_MATCH_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {MULTIPLE_MATCH_POLICY_LABELS[policy]}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {submitted && error && values.source !== "EXTRACTED_FIELD" ? <ErrorMessage error={new Error(error)} /> : null}

        {canManage ? (
          <div>
            <Button onClick={() => void save()} disabled={!dirty || update.isPending}>
              {update.isPending ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
