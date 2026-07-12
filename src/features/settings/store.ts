import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

export interface SettingsStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

export const dbSettingsStore: SettingsStore = {
  async get(key) {
    const db = createServiceClient();
    const { data, error } = await db.from("app_settings").select("value").eq("key", key).maybeSingle();
    if (error) throw error;
    return data?.value ?? null;
  },
  async set(key, value) {
    const db = createServiceClient();
    const { error } = await db.from("app_settings").upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) throw error;
  },
  async del(key) {
    const db = createServiceClient();
    const { error } = await db.from("app_settings").delete().eq("key", key);
    if (error) throw error;
  },
};
