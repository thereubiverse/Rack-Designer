import Link from "next/link";

/** The Settings sub-nav, shared by every settings page. Extracted from SettingsPage when the
 *  archive gained its own route: the items are links now, not the static span the single-page
 *  version could get away with. */
const ITEMS: { key: string; label: string; href: string; group: string }[] = [
  { key: "device-wizard", label: "Device Wizard", href: "/settings", group: "Features" },
  { key: "archive", label: "Archive", href: "/settings/archive", group: "Data" },
];

export function SettingsShell({
  active,
  children,
}: {
  active: string;
  children: React.ReactNode;
}) {
  const groups = [...new Set(ITEMS.map((i) => i.group))];
  return (
    <div className="flex gap-8">
      <nav className="w-56 shrink-0 space-y-4">
        {groups.map((group) => (
          <div key={group}>
            <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
              {group}
            </p>
            {ITEMS.filter((i) => i.group === group).map((item) => (
              <Link
                key={item.key}
                href={item.href}
                data-testid={`settings-nav-${item.key}`}
                className={`block rounded-lg px-3 py-2 text-sm font-medium ${
                  active === item.key
                    ? "bg-blue-50 text-blue-700"
                    : "text-neutral-600 hover:bg-neutral-100"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <section className="min-w-0 flex-1">{children}</section>
    </div>
  );
}
