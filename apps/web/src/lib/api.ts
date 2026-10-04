import { createApiClient } from "./api-client";
import { env } from "./env";
import { getStoredOrganizationId } from "./organization-storage";
import { supabase } from "./supabase";

export const api = createApiClient({
  baseUrl: env.apiUrl,
  async getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  },
  getOrganizationId: getStoredOrganizationId
});

export { ApiError, buildQuery } from "./api-client";
