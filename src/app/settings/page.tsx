import { redirect } from "next/navigation";
import { getCurrentMember } from "@/features/auth/members";
import { getDeviceWizardSettings } from "@/features/settings/getDeviceWizardSettings";
import { SettingsPage } from "@/features/settings/SettingsPage";

export const dynamic = "force-dynamic";

export default async function Settings() {
  const member = await getCurrentMember();
  if (!member) redirect("/login");

  const deviceWizard = await getDeviceWizardSettings(member.orgId);
  return <SettingsPage deviceWizard={deviceWizard} />;
}
