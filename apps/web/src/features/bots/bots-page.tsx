import { Bot as BotIcon, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, ErrorMessage, PageHeader } from "@/components/ui/display";
import { SkeletonRows } from "@/components/ui/feedback";
import { useRules } from "@/features/rules/api";
import { getErrorMessage } from "@/lib/errors";
import { BOT_STATUS_LABELS } from "@/lib/labels";
import { useOrganization } from "@/providers/organization-provider";
import { useBots } from "./api";
import { BotDialog } from "./bot-dialog";

export function BotsPage() {
  const { can } = useOrganization();
  const canManage = can("bots:manage");
  const bots = useBots();
  const rules = useRules();
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);

  const ruleCount = (botId: string) => (rules.data ?? []).filter((rule) => rule.botId === botId).length;

  return (
    <div>
      <PageHeader
        title="Bots"
        description="Cada bot representa un servicio de correo. Sus reglas deciden qué correos le pertenecen."
        actions={
          canManage ? (
            <Button onClick={() => setDialogOpen(true)}>
              <Plus /> Nuevo bot
            </Button>
          ) : undefined
        }
      />

      {bots.isPending ? (
        <SkeletonRows rows={4} />
      ) : bots.error ? (
        <ErrorMessage error={new Error(getErrorMessage(bots.error))} />
      ) : bots.data.length === 0 ? (
        <EmptyState
          icon={<BotIcon />}
          title="Sin bots"
          description="Crea un bot por servicio, por ejemplo Netflix o Yape, y asígnale sus reglas."
          action={canManage ? <Button onClick={() => setDialogOpen(true)}>Crear bot</Button> : undefined}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {bots.data.map((bot) => (
            <Card key={bot.id} className={bot.status === "ACTIVE" ? "p-4" : "p-4 opacity-70"}>
              <div className="flex items-center gap-2">
                <Link to={`/bots/${bot.id}`} className="truncate font-medium hover:underline">
                  {bot.name}
                </Link>
                <Badge variant={bot.status === "ACTIVE" ? "success" : "secondary"}>{BOT_STATUS_LABELS[bot.status]}</Badge>
              </div>
              <p className="font-mono text-xs text-muted-foreground">{bot.slug}</p>
              {bot.description ? <p className="mt-1 text-sm text-muted-foreground">{bot.description}</p> : null}
              <p className="mt-2 text-xs text-muted-foreground">
                {rules.data ? `${ruleCount(bot.id)} ${ruleCount(bot.id) === 1 ? "regla" : "reglas"}` : null}
              </p>
            </Card>
          ))}
        </div>
      )}

      <BotDialog open={dialogOpen} onOpenChange={setDialogOpen} bot={null} onCreated={(bot) => navigate(`/bots/${bot.id}`)} />
    </div>
  );
}
