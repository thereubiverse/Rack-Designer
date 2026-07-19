import { createServiceClient } from "@/lib/supabase/server";
import { listClients } from "@/features/clients/repository";
import { ClientsTable } from "@/features/clients/ClientsTable";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const db = createServiceClient();
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Clients</h2>
      <ClientsTable clients={await listClients(db)} />
    </div>
  );
}
