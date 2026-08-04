import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { createSessionClient } from "@/lib/supabase/auth";
import { getCurrentMember } from "@/features/auth/members";
import { readProfile } from "@/features/profile/repository";
import { createAvatarSignedUrl } from "@/features/profile/avatarStorage";
import { ProfileForm } from "@/features/profile/ProfileForm";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const member = await getCurrentMember();
  // Middleware already redirects an unauthenticated visitor; this covers the gap where a session
  // exists but membership was revoked between the middleware check and this render.
  if (!member) redirect("/login");

  const db = createServiceClient();
  const profile = await readProfile(db, member.id);
  if (!profile) redirect("/login");

  const avatarUrl = profile.avatarPath
    ? await createAvatarSignedUrl(db, profile.avatarPath)
    : null;

  // A member who signed in with Google or Microsoft has no password. Offering to "change" one
  // would quietly SET one, creating a second way into an account whose owner believes their
  // provider protects it.
  const auth = await createSessionClient();
  const { data } = await auth.auth.getUser();
  const hasPassword = (data.user?.identities ?? []).some((i) => i.provider === "email");

  return <ProfileForm profile={profile} avatarUrl={avatarUrl} hasPassword={hasPassword} />;
}
