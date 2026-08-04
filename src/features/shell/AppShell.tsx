"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "@iconify/react";
import { AppSidebar, SIDEBAR_WIDTH, SIDEBAR_COLLAPSED } from "./AppSidebar";
import { HeaderTitleContext } from "./headerTitle";

const STORE_KEY = "dl-sidebar-collapsed";

// Fallback title per route — used until (or unless) a page publishes its own last-crumb title via
// useHeaderTitle. Dynamic pages (a client, a site, a rack) override this with their resolved name.
const TITLES: [prefix: string, title: string][] = [
  ["/racks", "Racks"],
  ["/device-library", "Device Library"],
  ["/settings", "Settings"],
  ["/clients", "Clients"],
  // Last: every path startsWith "/", so this entry can only ever be the fallback.
  ["/", "Dashboard"],
];

/** Client shell that owns the sidebar collapse state so the hamburger (in the top bar) and the
 *  sidebar can share it. Lives in the root layout, so the state survives route navigations; it's
 *  also persisted to localStorage. Both the rail and the content offset animate together. The
 *  page title in the top bar is derived from the current route. */
export function AppShell({
  children,
  memberName,
}: {
  children: React.ReactNode;
  memberName: string | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const pathname = usePathname();
  // The auth routes render bare: a sidebar full of links you cannot use, above a sign-in form, is
  // both confusing and a hint about what exists inside. AppShell already knows the pathname, so this
  // is cheaper than splitting every page into a route group.
  const bare = pathname === "/login" || pathname.startsWith("/auth/");
  const fallback = TITLES.find(([p]) => pathname.startsWith(p))?.[1] ?? "Rack Designer";
  const title = pageTitle ?? fallback;

  useEffect(() => { if (localStorage.getItem(STORE_KEY) === "1") setCollapsed(true); }, []);
  useEffect(() => { localStorage.setItem(STORE_KEY, collapsed ? "1" : "0"); }, [collapsed]);

  if (bare) return <>{children}</>;

  return (
    <HeaderTitleContext.Provider value={setPageTitle}>
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <AppSidebar collapsed={collapsed} memberName={memberName} />

      <div
        className="transition-[padding] duration-300 ease-in-out"
        style={{ paddingLeft: collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_WIDTH }}
      >
        {/* Top app bar */}
        <header className="border-b border-neutral-200 bg-white">
          <div className="flex items-center justify-between gap-3 px-6 py-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="Toggle sidebar"
                aria-expanded={!collapsed}
                onClick={() => setCollapsed((c) => !c)}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M4 7h16M4 12h16M4 17h16" />
                </svg>
              </button>
              <h1 className="text-lg font-bold tracking-tight">{title}</h1>
            </div>
            {/* Context-aware help: will open documentation relevant to the user's current area of
                the suite (href is a placeholder until that routing lands). */}
            <a
              href="/device-library"
              aria-label="Help & documentation"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-500 transition-colors hover:bg-neutral-100"
            >
              <Icon icon="tabler:notebook" width={18} height={18} />
            </a>
          </div>
        </header>

        <div className="px-6">
          <div className="py-4 pb-12">{children}</div>
        </div>
      </div>
    </div>
    </HeaderTitleContext.Provider>
  );
}
