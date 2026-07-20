import { createServiceClient } from "@/lib/supabase/server";
import { listClients } from "@/features/clients/repository";
import { ClientsTable } from "@/features/clients/ClientsTable";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const db = createServiceClient();
  return <ClientsTable clients={await listClients(db)} />;
}
