import { redirect } from "next/navigation";
import { createTenantClient } from "@/lib/supabase/tenant";
import { getCurrentMember } from "@/features/auth/members";
import { listClients } from "@/features/clients/repository";
import { Dashboard } from "@/features/dashboard/Dashboard";

// The counts are live inventory, so this must not be prerendered at build time — the same reason
// the clients and site pages opt out.
export const dynamic = "force-dynamic";

export default async function Home() {
  const member = await getCurrentMember();
  // Middleware already redirects an unauthenticated visitor; this covers the gap where a session
  // exists but membership was revoked between the middleware check and this render.
  if (!member) redirect("/login");

  const db = createTenantClient(member);
  return <Dashboard clients={await listClients(db)} />;
}
