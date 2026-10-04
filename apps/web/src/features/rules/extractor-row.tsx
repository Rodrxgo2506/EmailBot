import { EXTRACT_PRESETS } from "@emailbot/validation";
import { Trash2 } from "lucide-react";
import { useFormContext, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/form-controls";
import { PRESET_LABELS, SOURCE_LABELS, type RuleFormValues } from "./rule-form-model";

export function ExtractorRow({ index, onRemove }: { index: number; onRemove(): void }) {
  const { register, formState } = useFormContext<RuleFormValues>();
  const mode = useWatch<RuleFormValues, `extractors.${number}.mode`>({ name: `extractors.${index}.mode` });
  const errors = formState.errors.extractors?.[index];

  return (
    <div className="grid gap-3 rounded-md border bg-background p-3 sm:grid-cols-2 lg:grid-cols-[1fr_9rem_1fr_9rem_auto] lg:items-end">
      <Field label="Nombre del dato" htmlFor={`extractor-${index}-name`} error={errors?.name?.message}>
        <Input id={`extractor-${index}-name`} className="font-mono" placeholder="verification_code" {...register(`extractors.${index}.name`)} />
      </Field>
      <Field label="Tipo" htmlFor={`extractor-${index}-mode`}>
        <Select id={`extractor-${index}-mode`} {...register(`extractors.${index}.mode`)}>
          <option value="preset">Predefinido</option>
          <option value="pattern">Regex propia</option>
        </Select>
      </Field>
      {mode === "preset" ? (
        <Field label="Extractor" htmlFor={`extractor-${index}-preset`}>
          <Select id={`extractor-${index}-preset`} {...register(`extractors.${index}.preset`)}>
            {EXTRACT_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {PRESET_LABELS[preset]}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <Field
          label="Expresión regular"
          htmlFor={`extractor-${index}-pattern`}
          hint="Se usa el primer grupo de captura si existe."
          error={errors?.pattern?.message}
        >
          <Input id={`extractor-${index}-pattern`} className="font-mono" placeholder="Pedido N° (\d+)" {...register(`extractors.${index}.pattern`)} />
        </Field>
      )}
      <Field label="Buscar en" htmlFor={`extractor-${index}-source`}>
        <Select id={`extractor-${index}-source`} {...register(`extractors.${index}.source`)}>
          {(Object.keys(SOURCE_LABELS) as Array<keyof typeof SOURCE_LABELS>).map((source) => (
            <option key={source} value={source}>
              {SOURCE_LABELS[source]}
            </option>
          ))}
        </Select>
      </Field>
      <Button variant="ghost" size="icon" aria-label="Quitar extractor" onClick={onRemove}>
        <Trash2 />
      </Button>
    </div>
  );
}
