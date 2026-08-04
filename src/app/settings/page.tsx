import { getDeviceWizardSettings } from "@/features/settings/getDeviceWizardSettings";
import { SettingsPage } from "@/features/settings/SettingsPage";

export const dynamic = "force-dynamic";

export default async function Settings() {
  const deviceWizard = await getDeviceWizardSettings();
  return <SettingsPage deviceWizard={deviceWizard} />;
}
