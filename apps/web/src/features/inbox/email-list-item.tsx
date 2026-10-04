import type { Category, EmailSummary } from "@emailbot/types";
import { KeyRound, Paperclip, Star } from "lucide-react";
import { Link } from "react-router-dom";
import { CategoryBadge } from "@/features/categories/category-badge";
import { cn, formatShortDate } from "@/lib/utils";
import { primaryCode } from "./extracted";

export function EmailListItem({
  email,
  category,
  to,
  selected
}: {
  email: EmailSummary;
  category: Category | undefined;
  to: string;
  selected: boolean;
}) {
  const code = primaryCode(email.extractedData);
  const sender = email.senderName ?? email.senderEmail;

  return (
    <Link
      to={to}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "block border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none",
        selected && "bg-accent",
        !email.isRead && "bg-primary/[0.03]"
      )}
    >
      <div className="flex items-center gap-2">
        <span
          aria-label={email.isRead ? undefined : "No leído"}
          className={cn("size-2 shrink-0 rounded-full", email.isRead ? "bg-transparent" : "bg-primary")}
        />
        <span className={cn("min-w-0 flex-1 truncate text-sm", !email.isRead && "font-semibold")}>{sender}</span>
        {email.isImportant ? <Star aria-label="Importante" className="size-3.5 shrink-0 fill-amber-400 text-amber-400" /> : null}
        {email.attachmentCount > 0 ? (
          <Paperclip aria-label={`${email.attachmentCount} adjuntos`} className="size-3.5 shrink-0 text-muted-foreground" />
        ) : null}
        <time dateTime={email.receivedAt} className="shrink-0 text-xs text-muted-foreground">
          {formatShortDate(email.receivedAt)}
        </time>
      </div>
      <p className={cn("mt-1 truncate pl-4 text-sm", email.isRead ? "text-foreground/80" : "font-medium")}>
        {email.subject || "(sin asunto)"}
      </p>
      <div className="mt-1.5 flex items-center gap-2 pl-4">
        <CategoryBadge category={category} />
        {code ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 font-mono text-xs text-emerald-700 dark:text-emerald-300">
            <KeyRound className="size-3" />
            {code}
          </span>
        ) : null}
        {email.snippet ? <span className="min-w-0 truncate text-xs text-muted-foreground">{email.snippet}</span> : null}
      </div>
    </Link>
  );
}
