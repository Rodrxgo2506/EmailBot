import { Inbox } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorMessage, Spinner } from "@/components/ui/display";
import { Pagination, SkeletonRows } from "@/components/ui/feedback";
import { useEmailAccounts } from "@/features/accounts/api";
import { useCategories } from "@/features/categories/api";
import { useCurrentOrganization } from "@/features/organization/api";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useOrganization } from "@/providers/organization-provider";
import { useEmails } from "./api";
import { EmailDetailPanel, NoEmailSelected } from "./email-detail";
import { EmailListItem } from "./email-list-item";
import { defaultView, INBOX_PAGE_SIZE, parseInboxFilters, serializeInboxFilters, toEmailQuery, type InboxFilters } from "./filters";
import { InboxToolbar } from "./inbox-toolbar";

/**
 * Two-pane inbox on wide screens (list + detail), single pane on small
 * screens (the detail route replaces the list). Filters live in the URL.
 */
export function InboxPage() {
  const { emailId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { can } = useOrganization();
  const current = useCurrentOrganization();
  const categories = useCategories();
  const accounts = useEmailAccounts();

  const filters = useMemo(
    () => parseInboxFilters(searchParams, defaultView(current.data?.settings?.defaultInboxFilter)),
    [searchParams, current.data?.settings?.defaultInboxFilter]
  );
  const emails = useEmails(toEmailQuery(filters));

  const updateFilters = useCallback(
    (patch: Partial<InboxFilters>) => setSearchParams(serializeInboxFilters({ ...filters, ...patch })),
    [filters, setSearchParams]
  );

  const queryString = searchParams.toString();
  const listPath = `/inbox${queryString ? `?${queryString}` : ""}`;
  const categoryById = new Map((categories.data ?? []).map((category) => [category.id, category]));

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] overflow-hidden border-t bg-card sm:-m-6">
      <section
        aria-label="Lista de correos"
        className={cn("flex w-full flex-col border-r xl:w-[28rem] xl:shrink-0", emailId && "hidden xl:flex")}
      >
        <InboxToolbar
          filters={filters}
          categories={categories.data ?? []}
          accounts={accounts.data ?? []}
          onChange={updateFilters}
        />

        <div className="flex-1 overflow-y-auto" aria-busy={emails.isFetching}>
          {emails.isPending ? (
            <SkeletonRows rows={8} className="p-3" />
          ) : emails.error ? (
            <div className="p-4">
              <ErrorMessage error={new Error(getErrorMessage(emails.error))} />
            </div>
          ) : emails.data.items.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<Inbox />}
                title="No hay correos en esta vista"
                description={
                  filters.search || filters.categoryId || filters.accountId
                    ? "Prueba con otros filtros o busca otro término."
                    : "EmailBot solo guarda los correos que coinciden con tus reglas activas."
                }
                action={
                  can("rules:manage") ? (
                    <Button asChild variant="outline" size="sm">
                      <Link to="/rules/new">Crear una regla</Link>
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <ul>
              {emails.data.items.map((email) => (
                <li key={email.id}>
                  <EmailListItem
                    email={email}
                    category={email.categoryId ? categoryById.get(email.categoryId) : undefined}
                    to={`/inbox/${email.id}${queryString ? `?${queryString}` : ""}`}
                    selected={email.id === emailId}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        {emails.data && emails.data.total > 0 ? (
          <div className="flex items-center gap-2 border-t px-3 py-2">
            {emails.isFetching && !emails.isPending ? <Spinner /> : null}
            <div className="flex-1">
              <Pagination
                page={filters.page}
                pageSize={INBOX_PAGE_SIZE}
                total={emails.data.total}
                onPageChange={(page) => updateFilters({ page })}
              />
            </div>
          </div>
        ) : null}
      </section>

      <section aria-label="Detalle del correo" className={cn("min-w-0 flex-1", !emailId && "hidden xl:block")}>
        {emailId ? (
          <EmailDetailPanel key={emailId} emailId={emailId} categories={categories.data ?? []} backTo={listPath} />
        ) : (
          <NoEmailSelected />
        )}
      </section>
    </div>
  );
}
