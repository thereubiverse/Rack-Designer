import { createServiceClient } from "@/lib/supabase/server";
import { listRacksWithPath } from "@/features/locations/repository";
import { RackGrid } from "@/features/grid/RackGrid";
import { CreateRackForm } from "@/features/locations/CreateRackForm";

export const dynamic = "force-dynamic";

export default async function Home() {
  const db = createServiceClient();
  const racks = await listRacksWithPath(db);

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Racks</h1>
        <p className="text-sm text-neutral-400">
          Create the location hierarchy and see every rack with its derived label.
        </p>
      </header>
      <CreateRackForm />
      <RackGrid racks={racks} />
    </main>
  );
}
