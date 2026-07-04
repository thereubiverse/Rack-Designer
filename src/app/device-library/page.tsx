import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { listDeviceTemplates, listDeviceTypes, listBrands } from "@/features/device-library/repository";
import { RackDeviceTable } from "@/features/device-library/RackDeviceTable";
import { CreateDeviceForm } from "@/features/device-library/CreateDeviceForm";

export const dynamic = "force-dynamic";

export default async function DeviceLibraryPage() {
  const db = createServiceClient();
  const [rows, types, brands] = await Promise.all([
    listDeviceTemplates(db), listDeviceTypes(db), listBrands(db),
  ]);
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Device Library</h1>
        <nav className="mt-3 flex gap-2 border-b border-neutral-800 text-sm">
          <span className="rounded-t bg-neutral-800 px-3 py-2 font-semibold">Rack Devices</span>
          <Link href="/device-library/types" className="px-3 py-2 text-neutral-400">Device Types</Link>
        </nav>
      </header>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Custom Rack Devices</h2>
        <CreateDeviceForm types={types} brands={brands} />
        <RackDeviceTable rows={rows} />
      </section>
    </main>
  );
}
