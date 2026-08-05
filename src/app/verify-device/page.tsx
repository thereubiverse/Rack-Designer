import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/features/auth/members";
import { findDeviceByHash } from "@/features/devices/repository";
import { DEVICE_COOKIE, hashDeviceToken } from "@/features/devices/deviceRules";
import { VerifyDevice } from "@/features/devices/VerifyDevice";

export const dynamic = "force-dynamic";

/** The one page a member with no trusted device yet is allowed to reach — the middleware exempts
 *  it from the DEVICE check but NOT from the member check, so this page still has to enforce that
 *  half itself, same as every other page in the app.
 *
 *  It must ALSO refuse to sit there once approval has already happened: a member who already holds
 *  an approved device has nothing to do here, and leaving them on a page inviting them to
 *  re-verify a device that is already trusted is confusing for no reason — send them to "/"
 *  instead. */
export default async function VerifyDevicePage() {
  const member = await getCurrentMember();
  if (!member) redirect("/login");

  const jar = await cookies();
  const token = jar.get(DEVICE_COOKIE)?.value;
  if (token) {
    const db = createServiceClient();
    const device = await findDeviceByHash(db, hashDeviceToken(token));
    // Ownership check against the DATABASE, not the cookie alone: a cookie that happens to hash to
    // SOMEONE ELSE's device must not be treated as this member's approval.
    if (device && device.memberId === member.id && device.approvedAt !== null) {
      redirect("/");
    }
  }

  return <VerifyDevice />;
}
