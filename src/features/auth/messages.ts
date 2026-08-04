/** The one refusal message every sign-in path shares — password, OAuth, and the server-action gate.
 *
 *  Lives outside members.ts on purpose: members.ts carries a `"server-only"` import guarding the
 *  service-role database client, and that import throws the instant it is evaluated in a client
 *  bundle. LoginForm is a client component that needs this exact string to render `?error=1`, so the
 *  string — which is pure data, not a server capability — lives here where a client component can
 *  read it without dragging the database client along. members.ts re-exports it so every existing
 *  server-side import of NOT_A_MEMBER from "./members" keeps working unchanged. */
export const NOT_A_MEMBER =
  "That account doesn't have access to this app. Ask an administrator to invite you.";
