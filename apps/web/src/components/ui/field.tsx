import type * as React from "react";
import { cn } from "@/lib/utils";
import { FieldError, Label } from "./form-controls";

/** Label + control + hint/error, consistently spaced. */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  className,
  children
}: {
  label: string;
  htmlFor?: string;
  error?: string | undefined;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      <FieldError message={error} />
    </div>
  );
}
