"use client";

import { createContext, useContext, useEffect } from "react";

/** The app-bar title reflects the CURRENT page's last breadcrumb crumb (e.g. a client's name),
 *  which is dynamic data the shell can't derive from the URL alone. A page publishes its crumb via
 *  `useHeaderTitle`; the shell displays it, falling back to a static per-route title. */
export const HeaderTitleContext = createContext<(title: string | null) => void>(() => {});

/** Publish this page's last breadcrumb crumb as the app-bar title; clears it on unmount so the next
 *  page's own title (or the route fallback) takes over. */
export function useHeaderTitle(title: string | null | undefined) {
  const setTitle = useContext(HeaderTitleContext);
  useEffect(() => {
    setTitle(title ?? null);
    return () => setTitle(null);
  }, [title, setTitle]);
}
