import { redirect } from "next/navigation";
import { createTenantClient } from "@/lib/supabase/tenant";
import { createServiceClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/features/auth/members";
import { listMembers } from "@/features/users/repository";
import { UsersTable, type PendingDeviceView } from "@/features/users/UsersTable";
import { listPendingDevices } from "@/features/devices/repository";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const member = await getCurrentMember();
  // Middleware already redirects an unauthenticated visitor; this covers the gap where a session
  // exists but membership was revoked between the middleware check and this render.
  if (!member) redirect("/login");

  // A list of every colleague's email address and access level is not something the whole company
  // needs to see — this is a real server-side gate, not a UI nicety that a direct link would bypass.
  if (member.role !== "admin") redirect("/");

  const db = createTenantClient(member);
  const members = await listMembers(db);

  // Grouped by member id here, in the server component, rather than handing the client a flat
  // list to re-group on every render. `tokenHash` is dropped: nobody viewing this screen holds
  // these devices, so there is no reason for the hash to leave this layer at all, same reasoning
  // as ProfileForm's DeviceView.
  const pendingDevicesByMember: Record<string, PendingDeviceView[]> = {};
  // NOT the tenant client: trusted_devices carries no grant for app_tenant at all, deliberately,
  // per migration 0042/0043 — confirmed directly ("permission denied for table trusted_devices").
  for (const d of await listPendingDevices(createServiceClient())) {
    (pendingDevicesByMember[d.memberId] ??= []).push({ id: d.id, label: d.label, createdAt: d.createdAt });
  }

  return (
    <UsersTable members={members} meId={member.id} pendingDevicesByMember={pendingDevicesByMember} />
  );
}
