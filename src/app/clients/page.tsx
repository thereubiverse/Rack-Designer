import { redirect } from "next/navigation";
import { createTenantClient } from "@/lib/supabase/tenant";
import { getCurrentMember } from "@/features/auth/members";
import { listClients } from "@/features/clients/repository";
import { ClientsTable } from "@/features/clients/ClientsTable";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const member = await getCurrentMember();
  // Middleware already redirects an unauthenticated visitor; this covers the gap where a session
  // exists but membership was revoked between the middleware check and this render.
  if (!member) redirect("/login");

  const db = createTenantClient(member);
  return <ClientsTable clients={await listClients(db)} />;
}
