import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createTenantClient } from "@/lib/supabase/tenant";
import { createServiceClient } from "@/lib/supabase/server";
import { createSessionClient } from "@/lib/supabase/auth";
import { getCurrentMember } from "@/features/auth/members";
import { readProfile } from "@/features/profile/repository";
import { createAvatarSignedUrl } from "@/features/profile/avatarStorage";
import { ProfileForm, type DeviceView } from "@/features/profile/ProfileForm";
import { listDevicesForMember } from "@/features/devices/repository";
import { DEVICE_COOKIE, hashDeviceToken } from "@/features/devices/deviceRules";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const member = await getCurrentMember();
  // Middleware already redirects an unauthenticated visitor; this covers the gap where a session
  // exists but membership was revoked between the middleware check and this render.
  if (!member) redirect("/login");

  const db = createTenantClient(member);
  const profile = await readProfile(db, member.id);
  if (!profile) redirect("/login");

  // Guarded for the same reason the root layout is, and this one matters more: if the row names an
  // object that is gone, an unguarded throw takes down the ONE page where the member could remove
  // the broken picture. Falling back to the initial leaves Remove reachable, so the state is
  // self-correcting rather than a dead end.
  let avatarUrl: string | null = null;
  if (profile.avatarPath) {
    try {
      // NOT the tenant client: storage.objects carries no grant for app_tenant at all — confirmed
      // directly against the local stack ("permission denied for schema storage"), not assumed.
      avatarUrl = await createAvatarSignedUrl(createServiceClient(), profile.avatarPath);
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

  // `isCurrent` is decided HERE, server-side, by comparing the request's own cookie against each
  // row's stored hash — never by sending the hash itself down to the client. A device row this
  // member does not currently hold (a stale cookie, a signed-out browser) simply matches nothing.
  const jar = await cookies();
  const token = jar.get(DEVICE_COOKIE)?.value;
  const currentHash = token ? hashDeviceToken(token) : null;
  // NOT the tenant client: trusted_devices carries no grant for app_tenant at all, deliberately,
  // per migration 0042/0043 — confirmed directly ("permission denied for table trusted_devices").
  const devices: DeviceView[] = (await listDevicesForMember(createServiceClient(), member.id)).map((d) => ({
    id: d.id,
    label: d.label,
    approvedAt: d.approvedAt,
    lastSeenAt: d.lastSeenAt,
    isCurrent: currentHash !== null && d.tokenHash === currentHash,
  }));

  return (
    <ProfileForm profile={profile} avatarUrl={avatarUrl} hasPassword={hasPassword} devices={devices} />
  );
}
