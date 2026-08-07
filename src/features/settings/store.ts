import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

export interface SettingsStore {
  get(orgId: string, key: string): Promise<string | null>;
  set(orgId: string, key: string, value: string): Promise<void>;
  del(orgId: string, key: string): Promise<void>;
}

export const dbSettingsStore: SettingsStore = {
  async get(orgId, key) {
    const db = createServiceClient();
    const { data, error } = await db
      .from("app_settings").select("value").eq("org_id", orgId).eq("key", key).maybeSingle();
    if (error) throw error;
    return data?.value ?? null;
  },
  async set(orgId, key, value) {
    const db = createServiceClient();
    const { error } = await db.from("app_settings")
      .upsert({ org_id: orgId, key, value, updated_at: new Date().toISOString() },
              { onConflict: "org_id,key" });
    if (error) throw error;
  },
  async del(orgId, key) {
    const db = createServiceClient();
    const { error } = await db.from("app_settings")
      .delete().eq("org_id", orgId).eq("key", key);
    if (error) throw error;
  },
};
