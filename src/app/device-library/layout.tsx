import { DeviceLibraryTabs } from "@/features/device-library/DeviceLibraryTabs";

/** Section tabs for Device Library; the app shell (rail + top bar) comes from the root layout. */
export default function DeviceLibraryLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="pb-4"><DeviceLibraryTabs /></div>
      {children}
    </>
  );
}
