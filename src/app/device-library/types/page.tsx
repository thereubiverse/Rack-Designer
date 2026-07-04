import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { listDeviceTypes } from "@/features/device-library/repository";
import { DeviceTypesPanel } from "@/features/device-library/DeviceTypesPanel";

export const dynamic = "force-dynamic";

export default async function DeviceTypesPage() {
  const db = createServiceClient();
  const types = await listDeviceTypes(db);
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Device Library</h1>
        <nav className="mt-3 flex gap-2 border-b border-neutral-800 text-sm">
          <Link href="/device-library" className="px-3 py-2 text-neutral-400">Rack Devices</Link>
          <span className="rounded-t bg-neutral-800 px-3 py-2 font-semibold">Device Types</span>
        </nav>
      </header>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Device Types</h2>
        <DeviceTypesPanel types={types} />
      </section>
    </main>
  );
}
