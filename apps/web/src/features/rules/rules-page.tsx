import { Bot as BotIcon, OctagonX, Pencil, Plus, Trash2, Workflow } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, ErrorMessage, PageHeader } from "@/components/ui/display";
import { ConfirmDialog, SkeletonRows } from "@/components/ui/feedback";
import { Switch } from "@/components/ui/form-controls";
import { useBots } from "@/features/bots/api";
import { useCategories } from "@/features/categories/api";
import { CategoryBadge } from "@/features/categories/category-badge";
import { getErrorMessage } from "@/lib/errors";
import { useOrganization } from "@/providers/organization-provider";
import { useRuleMutations, useRules, type EmailRule } from "./api";
import { describeCondition } from "./rule-form-model";

const ACTION_LABELS: Record<string, string> = {
  MARK_IMPORTANT: "Importante",
  MARK_READ: "Marcar leído",
  ARCHIVE: "Archivar",
  NOTIFY: "Notificar",
  EXTRACT: "Extraer"
};

function RuleCard({ rule, canManage, onDelete }: { rule: EmailRule; canManage: boolean; onDelete(): void }) {
  const { update } = useRuleMutations();
  const { data: categories } = useCategories();
  const { data: bots } = useBots();
  const category = categories?.find((candidate) => candidate.id === rule.categoryId);
  const bot = rule.botId ? bots?.find((candidate) => candidate.id === rule.botId) : undefined;

  return (
    <Card className={rule.enabled ? "p-4" : "p-4 opacity-70"}>
      <div className="flex flex-wrap items-start gap-3">
        <Badge variant="outline" title="Prioridad (menor = primero)" className="tabular-nums">
          #{rule.priority}
        </Badge>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/rules/${rule.id}`} className="font-medium hover:underline">
              {rule.name}
            </Link>
            {!rule.enabled ? <Badge variant="secondary">Desactivada</Badge> : null}
            {rule.stopProcessing ? (
              <Badge variant="warning" title="Detiene la evaluación de reglas posteriores">
                <OctagonX className="size-3" /> Detiene evaluación
              </Badge>
            ) : null}
          </div>
          {rule.description ? <p className="mt-0.5 text-sm text-muted-foreground">{rule.description}</p> : null}
          <p className="mt-2 text-sm">
            <span className="text-muted-foreground">Si </span>
            {rule.conditions.map((condition, index) => (
              <span key={index}>
                {index > 0 ? <strong className="text-xs text-primary"> {rule.matchMode === "AND" ? "Y" : "O"} </strong> : null}
                {describeCondition(condition)}
              </span>
            ))}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {bot ? (
              <Link to={`/bots/${bot.id}`} title="Bot de la regla">
                <Badge variant="outline">
                  <BotIcon className="size-3" /> {bot.name}
                </Badge>
              </Link>
            ) : null}
            {category ? <CategoryBadge category={category} /> : null}
            {rule.actions.map((action, index) => (
              <Badge key={index} variant="default">
                {action.type === "EXTRACT" ? `Extraer ${action.name}` : ACTION_LABELS[action.type]}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Switch
            label={rule.enabled ? "Desactivar regla" : "Activar regla"}
            checked={rule.enabled}
            disabled={!canManage || update.isPending}
            onCheckedChange={(enabled) =>
              update.mutate(
                { id: rule.id, patch: { enabled } },
                {
                  onSuccess: () => toast.success(enabled ? "Regla activada" : "Regla desactivada"),
                  onError: (error) => toast.error(getErrorMessage(error))
                }
              )
            }
          />
          <Button asChild variant="ghost" size="icon" aria-label={canManage ? "Editar regla" : "Ver regla"}>
            <Link to={`/rules/${rule.id}`}>
              <Pencil />
            </Link>
          </Button>
          {canManage ? (
            <Button variant="ghost" size="icon" aria-label="Eliminar regla" onClick={onDelete}>
              <Trash2 />
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

export function RulesPage() {
  const { can } = useOrganization();
  const canManage = can("rules:manage");
  const rules = useRules();
  const { remove } = useRuleMutations();
  const [deleting, setDeleting] = useState<EmailRule | null>(null);

  return (
    <div>
      <PageHeader
        title="Reglas"
        description="Solo se guardan los correos que coinciden con alguna regla activa. Se evalúan por prioridad."
        actions={
          canManage ? (
            <Button asChild>
              <Link to="/rules/new">
                <Plus /> Nueva regla
              </Link>
            </Button>
          ) : undefined
        }
      />

      {rules.isPending ? (
        <SkeletonRows rows={4} />
      ) : rules.error ? (
        <ErrorMessage error={new Error(getErrorMessage(rules.error))} />
      ) : rules.data.length === 0 ? (
        <EmptyState
          icon={<Workflow />}
          title="Aún no hay reglas"
          description="Por ejemplo: remitente contiene un dominio Y asunto contiene “código” → categoría Códigos + extraer código."
          action={
            canManage ? (
              <Button asChild>
                <Link to="/rules/new">Crear primera regla</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {rules.data.map((rule) => (
            <RuleCard key={rule.id} rule={rule} canManage={canManage} onDelete={() => setDeleting(rule)} />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Eliminar "${deleting?.name ?? ""}"`}
        description="Los correos ya procesados se conservan. La regla dejará de aplicarse a correos nuevos."
        confirmLabel="Eliminar"
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          toast.success("Regla eliminada");
        }}
      />
    </div>
  );
}
