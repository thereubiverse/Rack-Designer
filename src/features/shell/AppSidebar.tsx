"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@iconify/react";

export const SIDEBAR_WIDTH = 248;      // expanded rail width (px)
export const SIDEBAR_COLLAPSED = 52;   // icon-only rail width (px)

// Signed-in user (placeholder until auth lands). The avatar defaults to the first-name initial.
const USER = { name: "Reuben Singh" };

/** The app's left navigation rail. Racks and Device Library are live routes; the other
 *  destinations are placeholders until those areas ship. Active state is derived from the
 *  current pathname so it stays correct across navigations.
 *  Collapsing animates the aside's width while the inner content stays a fixed width and is clipped
 *  by `overflow-hidden`, so the labels slide out of view while the icons hold position (a small
 *  translate keeps them centred in the narrow rail). */
export function AppSidebar({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();

  return (
    <aside
      className="fixed inset-y-0 left-0 z-30 overflow-hidden border-r border-neutral-200 bg-white transition-[width] duration-300 ease-in-out"
      style={{ width: collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_WIDTH }}
    >
      <div
        className="group flex h-full flex-col gap-6 p-4 transition-transform duration-300 ease-in-out"
        style={{ width: SIDEBAR_WIDTH, transform: collapsed ? "translateX(-12px)" : "none" }}
        data-collapsed={collapsed ? "true" : "false"}
      >
        {/* Search */}
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400">
            <Icon icon="tabler:search" width={17} height={17} />
          </span>
          <input
            placeholder="Search"
            className="h-10 w-full rounded-xl border border-neutral-200 pl-9 pr-3 text-sm text-neutral-900 placeholder:text-neutral-400 transition-opacity duration-200 focus:border-neutral-400 focus:outline-none group-data-[collapsed=true]:pointer-events-none group-data-[collapsed=true]:opacity-0"
          />
        </div>

        {/* Primary nav */}
        <nav className="space-y-0.5">
          <NavItem icon="tabler:building-community" label="Clients" />
          <NavItem icon="tabler:network" label="Networks" />
          <NavItem icon="tabler:folders" label="Resources" />
          <NavItem icon="tabler:history" label="Activity Log" />
        </nav>

        <nav className="space-y-0.5">
          <NavItem icon="tabler:server-2" label="Racks" href="/racks" active={pathname.startsWith("/racks")} />
          <NavItem icon="tabler:book-2" label="Device Library" href="/device-library" active={pathname.startsWith("/device-library")} />
          <NavItem icon="tabler:users" label="Users & Permissions" />
          <NavItem icon="tabler:settings" label="Settings & Billing" href="/settings" active={pathname.startsWith("/settings")} />
        </nav>

        {/* Bottom cluster */}
        <div className="mt-auto space-y-4">
          <nav className="space-y-0.5">
            <NavItem icon="tabler:speakerphone" label="Announcements" muted />
            <NavItem icon="tabler:lifebuoy" label="Get support" muted />
            <NavItem icon="tabler:file-text" label="Documentation" muted />
            <NavItem icon="tabler:scale" label="Legal information" muted />
          </nav>

          <div className="px-3 text-xs text-neutral-400 transition-opacity duration-200 group-data-[collapsed=true]:opacity-0">2026.7.1 · <span className="text-neutral-500">Changelog</span></div>

          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-xl border border-neutral-200 p-2 text-left transition-colors hover:bg-neutral-50"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-sm font-semibold text-white">
              {USER.name.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900 transition-opacity duration-200 group-data-[collapsed=true]:opacity-0">{USER.name}</span>
            <span className="shrink-0 text-neutral-400 transition-opacity duration-200 group-data-[collapsed=true]:opacity-0">
              <Icon icon="tabler:selector" width={16} height={16} />
            </span>
          </button>
        </div>
      </div>
    </aside>
  );
}

function NavItem({ icon, label, href, active, muted }: {
  icon: string; label: string; href?: string; active?: boolean; muted?: boolean;
}) {
  const cls = `flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
    active ? "text-blue-700" : `${muted ? "text-neutral-600" : "text-neutral-700"} hover:bg-neutral-100`
  }`;
  const body = (
    <>
      <span className={`shrink-0 ${active ? "text-blue-600" : "text-neutral-500"}`}>
        <Icon icon={icon} width={20} height={20} />
      </span>
      <span className="flex-1 whitespace-nowrap transition-opacity duration-200 group-data-[collapsed=true]:opacity-0">{label}</span>
    </>
  );
  return href
    ? <Link href={href} title={label} className={cls}>{body}</Link>
    : <button type="button" title={label} className={cls}>{body}</button>;
}
