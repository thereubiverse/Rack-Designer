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

  // Guarded for the same reason the root layout is, and this one matters more: if the row names an
  // object that is gone, an unguarded throw takes down the ONE page where the member could remove
  // the broken picture. Falling back to the initial leaves Remove reachable, so the state is
  // self-correcting rather than a dead end.
  let avatarUrl: string | null = null;
  if (profile.avatarPath) {
    try {
      avatarUrl = await createAvatarSignedUrl(db, profile.avatarPath);
    } catch (e) {
      console.error("ProfilePage: could not sign the member avatar", e);
    }
  }

  // A member who signed in with Google or Microsoft has no password. Offering to "change" one
  // would quietly SET one, creating a second way into an account whose owner believes their
  // provider protects it.
  const auth = await createSessionClient();
  const { data } = await auth.auth.getUser();
  const hasPassword = (data.user?.identities ?? []).some((i) => i.provider === "email");

  return <ProfileForm profile={profile} avatarUrl={avatarUrl} hasPassword={hasPassword} />;
}
