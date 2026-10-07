import type { Permission } from "@emailbot/types";
import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { AppShell } from "@/components/layout/app-shell";
import {
  FullScreenLoader,
  RedirectIfAuthenticated,
  RequireAuth,
  RequireLegalAcceptance,
  RequireOrganization,
  RequirePermission
} from "@/components/layout/guards";
import { SkeletonRows } from "@/components/ui/feedback";
import { createQueryClient } from "@/lib/query-client";
import { AuthProvider } from "@/providers/auth-provider";
import { OrganizationProvider } from "@/providers/organization-provider";

/* Route-level code splitting: each page is loaded on demand. */
const page = <K extends string>(loader: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(async () => ({ default: (await loader())[name] }));

const LoginPage = page(() => import("@/features/auth/auth-pages"), "LoginPage");
const RegisterPage = page(() => import("@/features/auth/auth-pages"), "RegisterPage");
const ForgotPasswordPage = page(() => import("@/features/auth/auth-pages"), "ForgotPasswordPage");
const ResetPasswordPage = page(() => import("@/features/auth/auth-pages"), "ResetPasswordPage");
const OnboardingPage = page(() => import("@/features/onboarding/onboarding-page"), "OnboardingPage");
const DashboardPage = page(() => import("@/features/dashboard/dashboard-page"), "DashboardPage");
const InboxPage = page(() => import("@/features/inbox/inbox-page"), "InboxPage");
const RulesPage = page(() => import("@/features/rules/rules-page"), "RulesPage");
const RuleEditorPage = page(() => import("@/features/rules/rule-editor-page"), "RuleEditorPage");
const CategoriesPage = page(() => import("@/features/categories/categories-page"), "CategoriesPage");
const BotsPage = page(() => import("@/features/bots/bots-page"), "BotsPage");
const BotDetailPage = page(() => import("@/features/bots/bot-detail-page"), "BotDetailPage");
const CustomersPage = page(() => import("@/features/customers/customers-page"), "CustomersPage");
const CustomerDetailPage = page(() => import("@/features/customers/customer-detail-page"), "CustomerDetailPage");
const AccountsPage = page(() => import("@/features/accounts/accounts-page"), "AccountsPage");
const MembersPage = page(() => import("@/features/organization/members-page"), "MembersPage");
const SettingsPage = page(() => import("@/features/organization/settings-page"), "SettingsPage");
const AuditPage = page(() => import("@/features/organization/audit-page"), "AuditPage");
const ProfilePage = page(() => import("@/features/profile/profile-page"), "ProfilePage");
const LegalAcceptancePage = page(() => import("@/features/legal/legal-acceptance-page"), "LegalAcceptancePage");
const PrivacyPage = page(() => import("@/features/legal/privacy-page"), "PrivacyPage");
const TermsPage = page(() => import("@/features/legal/terms-page"), "TermsPage");
const PlansPage = page(() => import("@/features/plans/plans-page"), "PlansPage");
const PortalApp = page(() => import("@/features/portal/portal-app"), "PortalApp");
const AdminRoute = page(() => import("@/features/admin/admin-route"), "AdminRoute");

function guarded(permission: Permission, element: ReactNode) {
  return (
    <RequirePermission permission={permission}>
      <Suspense fallback={<SkeletonRows rows={6} />}>{element}</Suspense>
    </RequirePermission>
  );
}

/** Public page outside the session/organization providers (no auth, no organization). */
function publicPage(element: ReactNode) {
  return <Suspense fallback={<FullScreenLoader />}>{element}</Suspense>;
}

export function App() {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Public legal pages (linked from the Google OAuth consent screen). */}
          <Route path="/privacy" element={publicPage(<PrivacyPage />)} />
          <Route path="/terms" element={publicPage(<TermsPage />)} />
          {/* Customer portal: Access ID + httpOnly session cookie, no Supabase session, no organization. */}
          <Route path="/portal/*" element={publicPage(<PortalApp />)} />
          <Route path="*" element={<SessionRoutes />} />
        </Routes>
      </BrowserRouter>
      <Toaster richColors closeButton position="top-right" />
    </QueryClientProvider>
  );
}

/** Everything that depends on the Supabase session and the active organization. */
function SessionRoutes() {
  return (
    <AuthProvider>
      <OrganizationProvider>
        <Suspense fallback={<FullScreenLoader />}>
          <Routes>
            <Route element={<RedirectIfAuthenticated />}>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            </Route>
            {/* Reachable with the temporary recovery session from the email link. */}
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            {/* Public pricing page; inside the session providers only to recognize the current plan. */}
            <Route path="/planes" element={<PlansPage />} />

            <Route element={<RequireAuth />}>
              {/* Acceptance of the current Terms / Privacy versions; everything else waits for it. */}
              <Route path="/legal/accept" element={<LegalAcceptancePage />} />
              <Route element={<RequireLegalAcceptance />}>
                <Route path="/onboarding" element={<OnboardingPage />} />
                {/* Platform administration: no organization needed (RequirePlatformAdmin inside). */}
                <Route path="/admin/*" element={<AdminRoute />} />
                <Route element={<RequireOrganization />}>
                  <Route element={<AppShell />}>
                    <Route index element={guarded("emails:read", <DashboardPage />)} />
                    <Route path="inbox" element={guarded("emails:read", <InboxPage />)} />
                    <Route path="inbox/:emailId" element={guarded("emails:read", <InboxPage />)} />
                    <Route path="rules" element={guarded("rules:read", <RulesPage />)} />
                    <Route path="rules/new" element={guarded("rules:manage", <RuleEditorPage />)} />
                    <Route path="rules/:ruleId" element={guarded("rules:read", <RuleEditorPage />)} />
                    <Route path="categories" element={guarded("categories:read", <CategoriesPage />)} />
                    <Route path="bots" element={guarded("bots:read", <BotsPage />)} />
                    <Route path="bots/:botId" element={guarded("bots:read", <BotDetailPage />)} />
                    <Route path="customers" element={guarded("customers:read", <CustomersPage />)} />
                    <Route path="customers/:customerId" element={guarded("customers:read", <CustomerDetailPage />)} />
                    <Route path="accounts" element={guarded("email-accounts:read", <AccountsPage />)} />
                    <Route path="members" element={guarded("members:read", <MembersPage />)} />
                    <Route path="settings" element={guarded("organization:read", <SettingsPage />)} />
                    <Route path="audit" element={guarded("audit:read", <AuditPage />)} />
                    <Route
                      path="profile"
                      element={
                        <Suspense fallback={<SkeletonRows rows={4} />}>
                          <ProfilePage />
                        </Suspense>
                      }
                    />
                  </Route>
                </Route>
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </OrganizationProvider>
    </AuthProvider>
  );
}
