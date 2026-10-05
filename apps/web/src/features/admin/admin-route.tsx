import { useMemo } from "react";
import { RequirePlatformAdmin } from "@/components/layout/guards";
import { api } from "@/lib/api";
import { useAuth } from "@/providers/auth-provider";
import { useOrganization } from "@/providers/organization-provider";
import { createAdminApi } from "./admin-api";
import { AdminApp } from "./admin-app";

/** /admin/* entry: platform admin guard + the console wired to the real API client. */
export function AdminRoute() {
  const { user, signOut } = useAuth();
  const { memberships } = useOrganization();
  const adminApi = useMemo(() => createAdminApi(api), []);

  return (
    <RequirePlatformAdmin>
      <AdminApp api={adminApi} userEmail={user?.email ?? null} panelAvailable={memberships.length > 0} onSignOut={() => void signOut()} />
    </RequirePlatformAdmin>
  );
}
