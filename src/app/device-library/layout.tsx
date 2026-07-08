import { DeviceLibraryShell } from "@/features/device-library/DeviceLibraryShell";

/** Shared shell for the Device Library: the collapsible left rail, top app bar, and section tabs.
 *  The light theme is scoped to this section (the global body theme is dark). */
export default function DeviceLibraryLayout({ children }: { children: React.ReactNode }) {
  return <DeviceLibraryShell>{children}</DeviceLibraryShell>;
}
