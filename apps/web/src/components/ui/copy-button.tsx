import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button, type ButtonProps } from "./button";

export function CopyButton({ value, label = "Copiar", ...props }: { value: string; label?: string } & ButtonProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Copiado al portapapeles");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("No se pudo copiar");
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={() => void copy()} aria-label={label} {...props}>
      {copied ? <Check /> : <Copy />}
      {label}
    </Button>
  );
}
