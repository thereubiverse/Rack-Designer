import { notFound, redirect } from "next/navigation";
import { createTenantClient } from "@/lib/supabase/tenant";
import { getCurrentMember } from "@/features/auth/members";
import { getClientByCode, listSitesForClient } from "@/features/clients/repository";
import { ClientDetail } from "@/features/clients/ClientDetail";

export const dynamic = "force-dynamic";

export default async function ClientPage({ params }: { params: Promise<{ clientCode: string }> }) {
  const member = await getCurrentMember();
  // Middleware already redirects an unauthenticated visitor; this covers the gap where a session
  // exists but membership was revoked between the middleware check and this render.
  if (!member) redirect("/login");

  const { clientCode } = await params;
  const db = createTenantClient(member);
  const client = await getClientByCode(db, clientCode);
  if (!client) notFound();
  return <ClientDetail client={client} sites={await listSitesForClient(db, client.id)} />;
}
