import { createServiceClient } from "@/lib/supabase/server";
import { listClients } from "@/features/clients/repository";
import { Dashboard } from "@/features/dashboard/Dashboard";

// The counts are live inventory, so this must not be prerendered at build time — the same reason
// the clients and site pages opt out.
export const dynamic = "force-dynamic";

export default async function Home() {
  const db = createServiceClient();
  return <Dashboard clients={await listClients(db)} />;
}
