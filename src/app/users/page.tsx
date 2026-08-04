import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/features/auth/members";
import { listMembers } from "@/features/users/repository";
import { UsersTable } from "@/features/users/UsersTable";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const member = await getCurrentMember();
  // Middleware already redirects an unauthenticated visitor; this covers the gap where a session
  // exists but membership was revoked between the middleware check and this render.
  if (!member) redirect("/login");

  // A list of every colleague's email address and access level is not something the whole company
  // needs to see — this is a real server-side gate, not a UI nicety that a direct link would bypass.
  if (member.role !== "admin") redirect("/");

  const db = createServiceClient();
  const members = await listMembers(db);
  return <UsersTable members={members} meId={member.id} />;
}
