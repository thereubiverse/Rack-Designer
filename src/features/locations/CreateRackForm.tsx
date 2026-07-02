"use client";

import { useState } from "react";
import { ROOM_TYPES } from "@/domain/hierarchy";
import { createRackWithHierarchyAction } from "./actions";

export function CreateRackForm() {
  const [error, setError] = useState<string | null>(null);

  async function action(formData: FormData) {
    setError(null);
    const result = await createRackWithHierarchyAction(formData);
    if (!result.ok) setError(result.error ?? "Failed");
  }

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input name="siteCode" placeholder="Site (HQ)" className="input" required />
      <input name="floorCode" placeholder="Floor (28)" className="input" required />
      <input name="roomCode" placeholder="Room (SL)" className="input" required />
      <select name="roomType" className="input" defaultValue="other">
        {ROOM_TYPES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      <input name="rackCode" placeholder="Rack (RK001_M)" className="input" required />
      <input name="heightU" type="number" placeholder="U" defaultValue={42} className="input w-20" required />
      <button type="submit" className="rounded bg-blue-600 px-3 py-2 text-sm text-white">
        Add rack
      </button>
      {error && <span className="text-sm text-red-400">{error}</span>}
    </form>
  );
}
