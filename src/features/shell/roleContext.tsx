"use client";

import { createContext, useContext } from "react";
import { satisfies, type Role } from "@/features/auth/roles";

/** The signed-in member's role, threaded down from the root layout through `AppShell` (see
 *  `layout.tsx`) so the create/rename/archive/delete controls below can decide what to render.
 *
 *  Defaults to "admin" — i.e. permissive. This is NOT a security boundary: the corresponding
 *  server action already refuses a viewer after Task 4, so a permissive default here costs
 *  nothing. It exists so every component test written before this task, which renders these
 *  components with no provider at all, keeps passing unchanged — a test suddenly rendering no
 *  buttons would be a confusing failure about something the test isn't testing. */
export const RoleContext = createContext<Role>("admin");

/** Whether the signed-in member's role can use the create/rename/archive/delete controls this
 *  task hides from a viewer. Presentation only: the server refuses a viewer's write regardless of
 *  what this returns, so hiding (or failing to hide) a control changes nothing about who can
 *  actually make the change. */
export function useCanEdit(): boolean {
  return satisfies(useContext(RoleContext), "editor");
}
