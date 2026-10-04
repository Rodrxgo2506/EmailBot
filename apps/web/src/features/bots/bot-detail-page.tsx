import { ArrowLeft, Pause, Pencil, Play, Plus, Trash2, Workflow } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, ErrorMessage, PageHeader } from "@/components/ui/display";
import { ConfirmDialog, SkeletonRows } from "@/components/ui/feedback";
import { useRules } from "@/features/rules/api";
import { getErrorMessage } from "@/lib/errors";
import { BOT_STATUS_LABELS } from "@/lib/labels";
import { useOrganization } from "@/providers/organization-provider";
import { useBot, useBotMutations } from "./api";
import { BotCustomersCard } from "./bot-customers-card";
import { BotDialog } from "./bot-dialog";

export function BotDetailPage() {
  const { botId } = useParams();
  const navigate = useNavigate();
  const { can } = useOrganization();
  const canManage = can("bots:manage");
  const canManageRules = can("rules:manage");
  const canManageCustomers = can("customers:manage");
  const bot = useBot(botId);
  const rules = useRules();
  const { update, remove } = useBotMutations();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (bot.isPending) return <SkeletonRows rows={5} />;
  if (bot.error) return <ErrorMessage error={new Error(getErrorMessage(bot.error))} />;

  const current = bot.data;
  const botRules = (rules.data ?? []).filter((rule) => rule.botId === current.id);
  const paused = current.status === "PAUSED";

  const toggleStatus = async () => {
    try {
      await update.mutateAsync({ id: current.id, input: { status: paused ? "ACTIVE" : "PAUSED" } });
      toast.success(paused ? "Bot reanudado" : "Bot pausado");
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  return (
    <div>
      <Link to="/bots" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Bots
      </Link>
      <PageHeader
        title={current.name}
        description={current.description ?? undefined}
        actions={
          canManage ? (
            <>
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil /> Editar
              </Button>
              <Button variant="outline" onClick={() => void toggleStatus()} disabled={update.isPending}>
                {paused ? <Play /> : <Pause />} {paused ? "Reanudar" : "Pausar"}
              </Button>
              <Button variant="outline" aria-label={`Eliminar ${current.name}`} onClick={() => setDeleting(true)}>
                <Trash2 />
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={paused ? "secondary" : "success"}>{BOT_STATUS_LABELS[current.status]}</Badge>
        <span className="font-mono text-xs text-muted-foreground">{current.slug}</span>
        {paused ? <span className="text-muted-foreground">Sus reglas no se evalúan mientras está pausado. El historial se conserva.</span> : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div className="grid gap-1.5">
              <CardTitle>Reglas del bot</CardTitle>
              <CardDescription>Un correo pertenece a este bot cuando su regla de mayor prioridad es de este bot.</CardDescription>
            </div>
            {canManageRules ? (
              <Button size="sm" onClick={() => navigate(`/rules/new?botId=${current.id}`)}>
                <Plus /> Nueva regla
              </Button>
            ) : null}
          </CardHeader>
          <CardContent>
            {rules.isPending ? (
              <SkeletonRows rows={3} />
            ) : botRules.length === 0 ? (
              <EmptyState icon={<Workflow />} title="Sin reglas" description="Crea reglas para que este bot reciba correos." />
            ) : (
              <ul className="divide-y">
                {botRules.map((rule) => (
                  <li key={rule.id} className="flex items-center gap-3 py-2">
                    <Badge variant="outline" className="tabular-nums" title="Prioridad (menor = primero)">
                      #{rule.priority}
                    </Badge>
                    <Link to={`/rules/${rule.id}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
                      {rule.name}
                    </Link>
                    {!rule.enabled ? <Badge variant="secondary">Desactivada</Badge> : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Correos</CardTitle>
            <CardDescription>Correos procesados que el motor de reglas asignó a este bot.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => navigate(`/inbox?view=all&bot=${current.id}`)}>
              Ver correos del bot
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6">
        <BotCustomersCard botId={current.id} canManage={canManageCustomers} />
      </div>

      <BotDialog open={editing} onOpenChange={setEditing} bot={current} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Eliminar "${current.name}"`}
        description="Sus reglas pasarán a ser reglas generales. No se puede eliminar si ya tiene correos procesados (páusalo para conservar el historial) ni mientras tenga clientes o identificadores asociados."
        confirmLabel="Eliminar"
        onConfirm={async () => {
          try {
            await remove.mutateAsync(current.id);
            toast.success("Bot eliminado");
            navigate("/bots");
          } catch (error) {
            toast.error(getErrorMessage(error));
          }
        }}
      />
    </div>
  );
}
