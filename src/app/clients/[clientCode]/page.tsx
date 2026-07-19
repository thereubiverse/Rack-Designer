import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { getClientByCode, listSitesForClient } from "@/features/clients/repository";
import { ClientDetail } from "@/features/clients/ClientDetail";

export const dynamic = "force-dynamic";

export default async function ClientPage({ params }: { params: Promise<{ clientCode: string }> }) {
  const { clientCode } = await params;
  const db = createServiceClient();
  const client = await getClientByCode(db, clientCode);
  if (!client) notFound();
  return <ClientDetail client={client} sites={await listSitesForClient(db, client.id)} />;
}
