import "server-only";
import { createTenantClient } from "@/lib/supabase/tenant";

export interface SettingsStore {
  get(orgId: string, key: string): Promise<string | null>;
  set(orgId: string, key: string, value: string): Promise<void>;
  del(orgId: string, key: string): Promise<void>;
}

// Each method mints the tenant token from the SAME `orgId` it filters by — one variable, read
// twice, never two separately-sourced values that could disagree. The explicit `.eq("org_id", ...)`
// stays even though the policy already enforces it: it costs nothing and documents intent.
export const dbSettingsStore: SettingsStore = {
  async get(orgId, key) {
    const db = createTenantClient({ orgId });
    const { data, error } = await db
      .from("app_settings").select("value").eq("org_id", orgId).eq("key", key).maybeSingle();
    if (error) throw error;
    return data?.value ?? null;
  },
  async set(orgId, key, value) {
    const db = createTenantClient({ orgId });
    const { error } = await db.from("app_settings")
      .upsert({ org_id: orgId, key, value, updated_at: new Date().toISOString() },
              { onConflict: "org_id,key" });
    if (error) throw error;
  },
  async del(orgId, key) {
    const db = createTenantClient({ orgId });
    const { error } = await db.from("app_settings")
      .delete().eq("org_id", orgId).eq("key", key);
    if (error) throw error;
  },
};
