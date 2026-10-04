import { CheckCircle2, FlaskConical, XCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorMessage } from "@/components/ui/display";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/form-controls";
import { useCategories } from "@/features/categories/api";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import type { RuleTestResult, RuleTestSample } from "./api";
import { describeCondition } from "./rule-form-model";

const splitList = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Sends a sample email to the backend test endpoint; the real rule engine
 * evaluates it (nothing is evaluated in the browser, nothing is stored).
 */
export function RuleTestPanel({
  onTest,
  pending,
  result,
  error
}: {
  onTest(sample: RuleTestSample): void;
  pending: boolean;
  result: RuleTestResult | undefined;
  error: unknown;
}) {
  const { data: categories } = useCategories();
  const [sample, setSample] = useState({
    sender: "Servicio <no-reply@servicio.example>",
    recipients: "",
    subject: "Tu código temporal",
    body: "Tu código de acceso es 482913",
    attachments: "",
    receivedAt: ""
  });

  const update = (key: keyof typeof sample) => (event: { target: { value: string } }) =>
    setSample((current) => ({ ...current, [key]: event.target.value }));

  function run() {
    onTest({
      sender: sample.sender.trim(),
      recipients: splitList(sample.recipients),
      subject: sample.subject,
      body: sample.body,
      attachments: splitList(sample.attachments).map((filename) => ({ filename })),
      ...(sample.receivedAt ? { receivedAt: new Date(sample.receivedAt).toISOString() } : {})
    });
  }

  const category = categories?.find((candidate) => candidate.id === result?.actions?.categoryId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FlaskConical className="size-4" /> Probar regla
        </CardTitle>
        <CardDescription>Evalúa la regla actual del formulario contra un correo de ejemplo.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Field label="Remitente" htmlFor="test-sender">
          <Input id="test-sender" value={sample.sender} onChange={update("sender")} />
        </Field>
        <Field label="Destinatarios" htmlFor="test-recipients" hint="Separados por comas">
          <Input id="test-recipients" value={sample.recipients} onChange={update("recipients")} />
        </Field>
        <Field label="Asunto" htmlFor="test-subject">
          <Input id="test-subject" value={sample.subject} onChange={update("subject")} />
        </Field>
        <Field label="Cuerpo" htmlFor="test-body">
          <Textarea id="test-body" rows={4} value={sample.body} onChange={update("body")} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Adjuntos" htmlFor="test-attachments" hint="Nombres separados por comas">
            <Input id="test-attachments" value={sample.attachments} onChange={update("attachments")} />
          </Field>
          <Field label="Fecha" htmlFor="test-date" hint="Vacío = ahora">
            <Input id="test-date" type="datetime-local" value={sample.receivedAt} onChange={update("receivedAt")} />
          </Field>
        </div>
        <Button onClick={run} disabled={pending || !sample.sender.trim()}>
          {pending ? "Evaluando…" : "Probar"}
        </Button>

        <ErrorMessage error={error ? new Error(getErrorMessage(error)) : null} />

        {result ? (
          <div className="space-y-3 rounded-md border p-3" aria-live="polite">
            <div
              className={cn(
                "flex items-center gap-2 font-medium",
                result.matched ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"
              )}
            >
              {result.matched ? <CheckCircle2 className="size-5" /> : <XCircle className="size-5" />}
              {result.matched ? "La regla coincide" : "La regla no coincide"}
              {!result.enabled ? <Badge variant="secondary">Desactivada</Badge> : null}
            </div>
            {result.regexTimedOut ? (
              <p role="alert" className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                Una expresión regular tardó demasiado y se detuvo (se considera “no coincide”). Simplifícala para que la
                regla funcione de forma fiable.
              </p>
            ) : null}
            <ul className="space-y-1 text-sm">
              {result.conditionResults.map((entry, index) => (
                <li key={index} className="flex items-start gap-2">
                  {entry.matched ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  )}
                  {describeCondition(entry.condition)}
                </li>
              ))}
            </ul>
            {result.actions ? (
              <div className="space-y-2 border-t pt-3 text-sm">
                <p className="font-medium">Acciones resultantes</p>
                <div className="flex flex-wrap gap-1.5">
                  {category ? <Badge variant="outline">Categoría: {category.name}</Badge> : null}
                  {result.actions.markImportant ? <Badge>Importante</Badge> : null}
                  {result.actions.markRead ? <Badge>Marcar leído</Badge> : null}
                  {result.actions.archive ? <Badge>Archivar</Badge> : null}
                  {result.actions.notify ? <Badge>Notificar</Badge> : null}
                </div>
                {Object.keys(result.actions.extracted).length > 0 ? (
                  <dl className="grid gap-1">
                    {Object.entries(result.actions.extracted).map(([key, value]) => (
                      <div key={key} className="flex gap-2">
                        <dt className="text-muted-foreground">{key}:</dt>
                        <dd className="font-mono font-semibold">{value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
