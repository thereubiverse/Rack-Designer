"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/device-library", label: "Rack Devices" },
  { href: "/device-library/types", label: "Device Types" },
];

/** Light, pill-style tabs matching the editor. The active tab is derived from the path. */
export function DeviceLibraryTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 text-sm">
      {TABS.map((t) => {
        const active = t.href === "/device-library" ? pathname === t.href : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`rounded-lg px-3 py-1.5 font-semibold transition-colors ${
              active ? "bg-neutral-100 text-neutral-900" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
