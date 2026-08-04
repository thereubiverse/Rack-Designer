"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@iconify/react";
import { signOutAction } from "@/features/auth/authActions";

export const SIDEBAR_WIDTH = 248;      // expanded rail width (px)
export const SIDEBAR_COLLAPSED = 52;   // icon-only rail width (px)

/** The app's left navigation rail. Clients, Device Library and Settings & Billing are live
 *  routes; the other destinations are placeholders until those areas ship. Active state is
 *  derived from the current pathname so it stays correct across navigations.
 *  Collapsing animates the aside's width while the inner content stays a fixed width and is clipped
 *  by `overflow-hidden`, so the labels slide out of view while the icons hold position (a small
 *  translate keeps them centred in the narrow rail).
 *
 *  `memberName` and `memberEmail` are resolved server-side (getCurrentMember is server-only) and
 *  passed down from the root layout; they are null only on the bare auth routes, where this
 *  component isn't rendered. */
export function AppSidebar({
  collapsed,
  memberName,
  memberEmail,
  memberAvatarUrl,
}: {
  collapsed: boolean;
  memberName: string | null;
  memberEmail: string | null;
  memberAvatarUrl: string | null;
}) {
  const pathname = usePathname();
  const displayName = memberName ?? "";
  const initial = displayName ? displayName.charAt(0).toUpperCase() : "?";
  const [menuOpen, setMenuOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  // Same dismissal contract as the editor's BrandPicker: pointer outside closes, Escape closes.
  // Both are bound only while open, so a closed menu costs nothing.
  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Collapsing the rail hides the labels, and a menu anchored to a 36px avatar reads as detached
  // from anything. Closing on collapse avoids that entirely.
  useEffect(() => { if (collapsed) setMenuOpen(false); }, [collapsed]);

  // signOutAction resolves to { ok, error } (it redirects before returning in practice), which isn't
  // assignable to a <form action> handler's expected `void | Promise<void>` — this wrapper discards
  // the value so the types line up.
  async function handleSignOut() {
    await signOutAction();
  }

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
          {/* Exact match, not startsWith: "/" prefixes every route, so a prefix test would light
              this up on every page. */}
          <NavItem icon="tabler:layout-dashboard" label="Dashboard" href="/" active={pathname === "/"} />
          <NavItem icon="tabler:building-community" label="Clients" href="/clients" active={pathname.startsWith("/clients")} />
          <NavItem icon="tabler:network" label="Networks" />
          <NavItem icon="tabler:folders" label="Resources" />
          <NavItem icon="tabler:history" label="Activity Log" />
        </nav>

        <nav className="space-y-0.5">
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

          {/* Account menu. The card is the trigger; the menu opens UPWARD because the card sits at
              the bottom of the rail and a downward menu would open off-screen. */}
          <div ref={accountRef} className="relative">
            {menuOpen && (
              <div
                role="menu"
                aria-label="Account"
                data-testid="account-menu"
                className="absolute bottom-full left-0 z-40 mb-2 w-full overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg"
              >
                {/* Which account, not just whose name — two members can share a display name. */}
                <div className="border-b border-neutral-100 px-3 py-2">
                  <div className="truncate text-sm font-semibold text-neutral-900">{displayName}</div>
                  {memberEmail && <div className="truncate text-xs text-neutral-500">{memberEmail}</div>}
                </div>

                {/* There is no Account screen: email is administered elsewhere, and password lives
                    on the profile page with the rest of a member's own settings. */}
                <Link
                  href="/profile"
                  role="menuitem"
                  title="Profile"
                  aria-label="Profile"
                  onClick={() => setMenuOpen(false)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100"
                >
                  <span className="shrink-0 text-neutral-500">
                    <Icon icon="tabler:user-circle" width={18} height={18} />
                  </span>
                  <span className="flex-1 whitespace-nowrap">Profile</span>
                </Link>

                <div className="my-1 border-t border-neutral-100" />

                <form action={handleSignOut}>
                  <button
                    type="submit"
                    role="menuitem"
                    title="Log out"
                    aria-label="Log out"
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
                  >
                    <span className="shrink-0 text-red-500">
                      <Icon icon="tabler:logout" width={18} height={18} />
                    </span>
                    <span className="flex-1 whitespace-nowrap">Log out</span>
                  </button>
                </form>
              </div>
            )}

            <button
              type="button"
              data-testid="account-trigger"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={displayName ? `Account menu for ${displayName}` : "Account menu"}
              onClick={() => setMenuOpen((o) => !o)}
              className={`flex w-full items-center gap-3 rounded-xl border p-2 text-left transition-colors ${
                menuOpen ? "border-neutral-300 bg-neutral-50" : "border-neutral-200 hover:bg-neutral-50"
              }`}
            >
              {memberAvatarUrl ? (
                <img src={memberAvatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
              ) : (
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-sm font-semibold text-white">
                  {initial}
                </span>
              )}
              <span
                title={displayName}
                className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900 transition-opacity duration-200 group-data-[collapsed=true]:opacity-0"
              >
                {displayName}
              </span>
              <span
                className={`shrink-0 text-neutral-400 transition-[transform,opacity] duration-200 group-data-[collapsed=true]:opacity-0 ${
                  menuOpen ? "rotate-180" : ""
                }`}
              >
                <Icon icon="tabler:chevron-up" width={16} height={16} />
              </span>
            </button>
          </div>
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
