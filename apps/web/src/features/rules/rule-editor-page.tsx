import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { FormProvider, useFieldArray, useForm } from "react-hook-form";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorMessage, PageHeader } from "@/components/ui/display";
import { SkeletonRows } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { CheckboxCard, Input, Label, Select, Switch, Textarea } from "@/components/ui/form-controls";
import { useBots } from "@/features/bots/api";
import { useCategories } from "@/features/categories/api";
import { ApiError } from "@/lib/api-client";
import { getErrorMessage } from "@/lib/errors";
import { useOrganization } from "@/providers/organization-provider";
import { useRule, useRuleMutations } from "./api";
import { ConditionRow } from "./condition-row";
import { ExtractorRow } from "./extractor-row";
import {
  defaultRuleFormValues,
  emptyCondition,
  emptyExtractor,
  fromRule,
  ruleFormSchema,
  validateRulePayload,
  type RuleFormValues
} from "./rule-form-model";
import { RuleTestPanel } from "./rule-test-panel";

/** Create (/rules/new) and edit (/rules/:ruleId) a rule. */
export function RuleEditorPage() {
  const { ruleId } = useParams();
  const navigate = useNavigate();
  const { can } = useOrganization();
  const canManage = can("rules:manage");
  const isNew = !ruleId;
  const rule = useRule(ruleId);
  const categories = useCategories();
  const bots = useBots();
  const [searchParams] = useSearchParams();
  const { create, update, testDraft } = useRuleMutations();
  const [payloadIssues, setPayloadIssues] = useState<Array<{ path: string; message: string }>>([]);

  // New rule opened from a bot page (/rules/new?botId=...): preselect that bot.
  const form = useForm<RuleFormValues>({
    resolver: zodResolver(ruleFormSchema),
    defaultValues: { ...defaultRuleFormValues(), botId: isNew ? (searchParams.get("botId") ?? "") : "" }
  });
  const conditions = useFieldArray({ control: form.control, name: "conditions" });
  const extractors = useFieldArray({ control: form.control, name: "extractors" });

  useEffect(() => {
    if (rule.data) form.reset(fromRule(rule.data));
  }, [rule.data, form]);

  const saving = create.isPending || update.isPending;
  const saveError = create.error ?? update.error;
  const matchMode = form.watch("matchMode");
  const notify = form.watch("notify");

  const onSubmit = form.handleSubmit(async (values) => {
    const validation = validateRulePayload(values);
    if (!validation.ok) {
      setPayloadIssues(validation.issues);
      return;
    }
    setPayloadIssues([]);
    try {
      if (ruleId) await update.mutateAsync({ id: ruleId, patch: validation.payload });
      else await create.mutateAsync(validation.payload);
      toast.success(ruleId ? "Regla actualizada" : "Regla creada");
      navigate("/rules");
    } catch (error) {
      if (error instanceof ApiError && Array.isArray(error.details)) {
        setPayloadIssues(error.details as Array<{ path: string; message: string }>);
      }
    }
  });

  function runTest(email: Parameters<typeof testDraft.mutate>[0]["email"]) {
    const validation = validateRulePayload(form.getValues());
    if (!validation.ok) {
      setPayloadIssues(validation.issues);
      toast.error("Corrige la regla antes de probarla");
      return;
    }
    setPayloadIssues([]);
    testDraft.mutate({ rule: validation.payload, email });
  }

  if (ruleId && rule.isPending) return <SkeletonRows rows={6} />;
  if (ruleId && rule.error) return <ErrorMessage error={new Error(getErrorMessage(rule.error))} />;

  return (
    <div>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
        <Link to="/rules">
          <ArrowLeft /> Reglas
        </Link>
      </Button>
      <PageHeader
        title={isNew ? "Nueva regla" : canManage ? "Editar regla" : "Regla"}
        description="Define qué correos procesar y qué hacer con ellos. La evaluación ocurre en el servidor."
      />

      <FormProvider {...form}>
        <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
          <form onSubmit={onSubmit} noValidate>
            <fieldset disabled={!canManage} className="grid gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>General</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 sm:grid-cols-2">
                  <Field label="Nombre" htmlFor="rule-name" error={form.formState.errors.name?.message} className="sm:col-span-2">
                    <Input id="rule-name" placeholder="Códigos de verificación" {...form.register("name")} />
                  </Field>
                  <Field label="Descripción" htmlFor="rule-description" className="sm:col-span-2">
                    <Textarea id="rule-description" rows={2} {...form.register("description")} />
                  </Field>
                  <Field
                    label="Bot"
                    htmlFor="rule-bot"
                    hint="Sin bot, la regla solo clasifica. Si dos bots empatan en la prioridad más alta, el correo queda sin bot."
                    className="sm:col-span-2"
                  >
                    <Select id="rule-bot" {...form.register("botId")}>
                      <option value="">Regla general (sin bot)</option>
                      {(bots.data ?? []).map((bot) => (
                        <option key={bot.id} value={bot.id}>
                          {bot.name}
                          {bot.status === "PAUSED" ? " (pausado)" : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    label="Prioridad"
                    htmlFor="rule-priority"
                    hint="Menor número = se evalúa antes."
                    error={form.formState.errors.priority?.message}
                  >
                    <Input id="rule-priority" type="number" min={0} {...form.register("priority", { valueAsNumber: true })} />
                  </Field>
                  <div className="grid gap-1.5">
                    <Label>Estado</Label>
                    <div className="flex h-9 items-center gap-2">
                      <Switch
                        label="Regla activa"
                        checked={form.watch("enabled")}
                        disabled={!canManage}
                        onCheckedChange={(checked) => form.setValue("enabled", checked, { shouldDirty: true })}
                      />
                      <span className="text-sm">{form.watch("enabled") ? "Activa" : "Desactivada"}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Condiciones</CardTitle>
                  <CardDescription>
                    <span className="inline-flex items-center gap-2">
                      El correo debe cumplir
                      <Select aria-label="Modo de coincidencia" className="h-8 w-auto" {...form.register("matchMode")}>
                        <option value="AND">todas las condiciones (Y)</option>
                        <option value="OR">al menos una condición (O)</option>
                      </Select>
                    </span>
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2">
                  {conditions.fields.map((item, index) => (
                    <div key={item.id}>
                      {index > 0 ? (
                        <p className="py-1 text-center text-xs font-semibold text-primary">{matchMode === "AND" ? "Y" : "O"}</p>
                      ) : null}
                      <ConditionRow index={index} canRemove={conditions.fields.length > 1} onRemove={() => conditions.remove(index)} />
                    </div>
                  ))}
                  <p role="alert" className="text-xs text-destructive">
                    {form.formState.errors.conditions?.root?.message ?? form.formState.errors.conditions?.message}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="justify-self-start"
                    disabled={conditions.fields.length >= 25}
                    onClick={() => conditions.append(emptyCondition())}
                  >
                    <Plus /> Agregar condición
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Acciones</CardTitle>
                  <CardDescription>Se aplican al correo cuando la regla coincide.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <Field label="Asignar categoría" htmlFor="rule-category">
                    <Select id="rule-category" {...form.register("categoryId")}>
                      <option value="">Sin categoría</option>
                      {(categories.data ?? []).map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <CheckboxCard label="Marcar como importante" description="Destaca el correo en la bandeja." {...form.register("markImportant")} />
                    <CheckboxCard label="Marcar como leído" description="No aparecerá como pendiente." {...form.register("markRead")} />
                    <CheckboxCard label="Archivar" description="Se guarda fuera de la vista principal." {...form.register("archive")} />
                    <CheckboxCard
                      label="Detener evaluación"
                      description="No evaluar reglas de menor prioridad si esta coincide."
                      {...form.register("stopProcessing")}
                    />
                    <CheckboxCard label="Notificar" description="Notificación en la aplicación en tiempo real." {...form.register("notify")} />
                  </div>
                  {notify ? (
                    <Field label="Título de la notificación (opcional)" htmlFor="rule-notify-title" hint="Por defecto se usa el asunto del correo.">
                      <Input id="rule-notify-title" {...form.register("notifyTitle")} />
                    </Field>
                  ) : null}

                  <div className="grid gap-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">Extraer datos</p>
                        <p className="text-xs text-muted-foreground">Ej. el código de verificación se mostrará destacado en la bandeja.</p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={extractors.fields.length >= 10}
                        onClick={() => extractors.append(emptyExtractor())}
                      >
                        <Plus /> Extractor
                      </Button>
                    </div>
                    {extractors.fields.map((item, index) => (
                      <ExtractorRow key={item.id} index={index} onRemove={() => extractors.remove(index)} />
                    ))}
                  </div>
                </CardContent>
              </Card>

              {payloadIssues.length > 0 || saveError ? (
                <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  {saveError ? <p>{getErrorMessage(saveError)}</p> : null}
                  {payloadIssues.length > 0 ? (
                    <ul className="list-disc pl-5">
                      {payloadIssues.map((issue, index) => (
                        <li key={index}>
                          {issue.path ? <span className="font-mono">{issue.path}: </span> : null}
                          {issue.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              {canManage ? (
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => navigate("/rules")}>
                    Cancelar
                  </Button>
                  <Button type="submit" disabled={saving}>
                    {saving ? "Guardando…" : isNew ? "Crear regla" : "Guardar cambios"}
                  </Button>
                </div>
              ) : null}
            </fieldset>
          </form>

          <div className="xl:sticky xl:top-20 xl:self-start">
            <RuleTestPanel onTest={runTest} pending={testDraft.isPending} result={testDraft.data} error={testDraft.error} />
          </div>
        </div>
      </FormProvider>
    </div>
  );
}
