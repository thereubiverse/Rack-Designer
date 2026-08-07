import "server-only";
import { dbSettingsStore } from "./store";
import { readDeviceWizardSettings, type DeviceWizardSettings } from "./deviceWizardSettings";

/** Plain server-side read — deliberately not a server action, unlike its sibling in actions.ts.
 *  It only returns {enabled, hasKey} (never the raw key) and is called exclusively from server
 *  components (settings, racks/[id], device-library) that already sit behind the middleware's
 *  membership gate, so wrapping it in withMember would just force those pages to handle a
 *  {ok:false} union for no benefit. This module carries no server-action directive, so it is not a
 *  remotely invocable Next.js endpoint — there is nothing here for an unauthenticated `Next-Action`
 *  POST to hit. Do NOT add that directive to this file, or add it back next to this export in
 *  actions.ts — see the branch review that split this out. */
export async function getDeviceWizardSettings(orgId: string): Promise<DeviceWizardSettings> {
  return readDeviceWizardSettings(dbSettingsStore, orgId);
}
