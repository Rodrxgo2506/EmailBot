import { RULE_FIELDS, type RuleField, type RuleOperator } from "@emailbot/validation";
import { Trash2 } from "lucide-react";
import { useFormContext, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Select } from "@/components/ui/form-controls";
import { FIELD_LABELS, OPERATOR_LABELS, operatorNeedsValue, operatorsFor, type RuleFormValues } from "./rule-form-model";

const PLACEHOLDERS: Record<RuleField, string> = {
  sender: "ej. ejemplo.com",
  recipient: "ej. soporte@miempresa.com",
  subject: "ej. código temporal",
  body: "ej. tu código es",
  date: "AAAA-MM-DD o fecha ISO",
  attachment: "ej. .pdf"
};

export function ConditionRow({ index, canRemove, onRemove }: { index: number; canRemove: boolean; onRemove(): void }) {
  const { register, setValue, formState } = useFormContext<RuleFormValues>();
  const field = useWatch<RuleFormValues, `conditions.${number}.field`>({ name: `conditions.${index}.field` });
  const operator = useWatch<RuleFormValues, `conditions.${number}.operator`>({ name: `conditions.${index}.operator` });
  const errors = formState.errors.conditions?.[index];
  const operators = operatorsFor(field);
  const needsValue = operatorNeedsValue(operator);
  const textOperator = needsValue && field !== "date" && operator !== "regex";

  return (
    <div className="grid gap-2 rounded-md border bg-background p-3 sm:grid-cols-[10rem_11rem_1fr_auto] sm:items-start">
      <div>
        <label className="sr-only" htmlFor={`condition-${index}-field`}>
          Campo
        </label>
        <Select
          id={`condition-${index}-field`}
          {...register(`conditions.${index}.field`, {
            onChange: (event: { target: { value: RuleField } }) => {
              if (!operatorsFor(event.target.value).includes(operator)) {
                setValue(`conditions.${index}.operator`, "contains");
              }
            }
          })}
        >
          {RULE_FIELDS.map((value) => (
            <option key={value} value={value}>
              {FIELD_LABELS[value]}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <label className="sr-only" htmlFor={`condition-${index}-operator`}>
          Operador
        </label>
        <Select id={`condition-${index}-operator`} {...register(`conditions.${index}.operator`)}>
          {operators.map((value: RuleOperator) => (
            <option key={value} value={value}>
              {OPERATOR_LABELS[value]}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-1">
        {needsValue ? (
          <>
            <label className="sr-only" htmlFor={`condition-${index}-value`}>
              Valor
            </label>
            <Input
              id={`condition-${index}-value`}
              placeholder={operator === "regex" ? "Expresión regular, ej. \\b\\d{6}\\b" : PLACEHOLDERS[field]}
              className={operator === "regex" ? "font-mono" : undefined}
              aria-invalid={Boolean(errors?.value)}
              {...register(`conditions.${index}.value`)}
            />
            {textOperator ? (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" className="size-3.5 accent-[var(--primary)]" {...register(`conditions.${index}.caseSensitive`)} />
                Distinguir mayúsculas y tildes
              </label>
            ) : null}
          </>
        ) : (
          <p className="py-2 text-sm text-muted-foreground">Sin valor</p>
        )}
        <FieldError message={errors?.value?.message} />
      </div>
      <Button variant="ghost" size="icon" aria-label="Quitar condición" disabled={!canRemove} onClick={onRemove}>
        <Trash2 />
      </Button>
    </div>
  );
}
