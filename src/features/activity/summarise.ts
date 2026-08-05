/** Turns one activity_log row into a short English sentence. PURE — no database, no React.
 *
 *  `VERBS` SHOULD cover every key in `LOGGED_FIELDS` (see redact.ts) — summarise.test.ts asserts
 *  this as a drift guard — but an action added later without a VERBS entry still falls back to
 *  rendering its raw key rather than throwing or going blank, so a gap here is a readable regression
 *  the guard test catches, not a crash. */

export interface Describable {
  action: string;
  details: Record<string, string>;
  outcome: "ok" | "refused" | "failed";
}

/** `verb` is the base (infinitive) form, e.g. "rename" or "clear the outline of" — used as-is for
 *  `refused`/`failed` ("Not allowed to rename client ACME") and conjugated to past tense for `ok`
 *  ("Renamed client ACME"). Only the leading word of a multi-word verb is conjugated.
 *
 *  Exported only for the drift-guard test below, which checks it against LOGGED_FIELDS — not
 *  meant to be used elsewhere; go through summarise()/actionLabel() instead. */
export const VERBS: Readonly<Record<string, { verb: string; noun: string }>> = {
  "client.create": { verb: "create", noun: "client" },
  "client.rename": { verb: "rename", noun: "client" },
  "client.archive": { verb: "archive", noun: "client" },
  "client.restore": { verb: "restore", noun: "client" },
  "client.delete": { verb: "delete", noun: "client" },
  "site.create": { verb: "create", noun: "site" },
  "site.rename": { verb: "rename", noun: "site" },
  "site.archive": { verb: "archive", noun: "site" },
  "site.restore": { verb: "restore", noun: "site" },
  "site.locate": { verb: "locate", noun: "site" },
  "site.delete": { verb: "delete", noun: "site" },
  "floor.create": { verb: "create", noun: "floor" },
  "floor.rename": { verb: "rename", noun: "floor" },
  "floor.archive": { verb: "archive", noun: "floor" },
  "floor.restore": { verb: "restore", noun: "floor" },
  "floor.delete": { verb: "delete", noun: "floor" },
  "room.create": { verb: "create", noun: "room" },
  "room.rename": { verb: "rename", noun: "room" },
  "room.delete": { verb: "delete", noun: "room" },
  "room.polygon.set": { verb: "set the outline of", noun: "room" },
  "room.polygon.clear": { verb: "clear the outline of", noun: "room" },
  "floorDevice.create": { verb: "create", noun: "floor device" },
  "floorDevice.update": { verb: "update", noun: "floor device" },
  "floorDevice.delete": { verb: "delete", noun: "floor device" },
  "floorDevice.place": { verb: "place", noun: "floor device" },
  "floorDevice.clearPlacement": { verb: "clear the placement of", noun: "floor device" },
  "floorPlan.upload": { verb: "upload", noun: "floor plan" },
  "floorPlan.delete": { verb: "delete", noun: "floor plan" },
  "rack.create": { verb: "create", noun: "rack" },
  "rack.update": { verb: "update", noun: "rack" },
  "rack.delete": { verb: "delete", noun: "rack" },
  "rack.place": { verb: "place", noun: "rack" },
  "rack.clearPlacement": { verb: "clear the placement of", noun: "rack" },
  "rack.layout.save": { verb: "save the layout of", noun: "rack" },
  "rack.connections.save": { verb: "save the connections of", noun: "rack" },
  "rack.endpoints.save": { verb: "save the endpoints of", noun: "rack" },

  "deviceTemplate.create": { verb: "create", noun: "device template" },
  "deviceTemplate.update": { verb: "update", noun: "device template" },
  "deviceTemplate.delete": { verb: "delete", noun: "device template" },
  "deviceTemplate.duplicate": { verb: "duplicate", noun: "device template" },
  // Pure reads, wrapped with { log: false } — never actually written to the log (see redact.ts) —
  // but still given an entry so the drift guard (every LOGGED_FIELDS key has a VERBS entry) holds
  // for the whole allowlist, not just the keys that happen to get logged today.
  "deviceTemplate.list": { verb: "list", noun: "device templates" },
  "deviceTemplate.get": { verb: "look up", noun: "device template" },
  "brand.create": { verb: "create", noun: "brand" },
  "brand.delete": { verb: "delete", noun: "brand" },
  "deviceType.create": { verb: "create", noun: "device type" },
  "deviceType.save": { verb: "save", noun: "device type" },
  "deviceType.delete": { verb: "delete", noun: "device type" },

  "ai.discoverRooms": { verb: "run room discovery on", noun: "floor" },
  "ai.discoverDevices": { verb: "run device discovery on", noun: "floor" },
  "ai.discoverSymbols": { verb: "run symbol discovery on", noun: "floor" },
  "ai.pickSymbol": { verb: "pick a symbol on", noun: "floor" },
  "ai.extractGeometry": { verb: "extract geometry from", noun: "floor" },
  "ai.detectPorts": { verb: "run port detection on", noun: "device" },
  "ai.identifyDevice": { verb: "identify", noun: "device" },

  "member.invite": { verb: "invite", noun: "member" },
  "member.setRole": { verb: "set the role of", noun: "member" },
  "member.setActive": { verb: "set the active state of", noun: "member" },

  "profile.update": { verb: "update", noun: "profile" },
  "profile.avatar.upload": { verb: "upload", noun: "avatar" },
  "profile.avatar.remove": { verb: "remove", noun: "avatar" },
  "phone.sendCode": { verb: "send a code to", noun: "phone" },

  "password.change": { verb: "change", noun: "password" },
  "settings.deviceWizard.update": { verb: "update", noun: "device wizard settings" },
  "phone.confirm": { verb: "confirm", noun: "phone" },

  // Rendering for these two is special-cased in summarise() below — the generic verb/noun
  // composition reads badly for them ("Not allowed to signed in"). These entries exist only to
  // satisfy the drift guard and to give actionLabel() something sensible for the filter menu.
  "auth.signIn": { verb: "sign in", noun: "" },
  "auth.signOut": { verb: "sign out", noun: "" },

  // Trusted devices. `device.challenge` covers both the first request and a resend — see
  // redact.ts — and, per the design note there, is also the entry that stands in for an
  // unrecognised device announcing itself, since the middleware that would otherwise log a refused
  // sign-in runs on the Edge runtime and cannot reach the service-role client.
  "device.challenge": { verb: "request approval for", noun: "a device" },
  "device.approve": { verb: "approve", noun: "a device" },
  "device.revoke": { verb: "revoke", noun: "a device" },
  "device.adminApprove": { verb: "approve", noun: "a device" },
  "device.adminRevoke": { verb: "revoke", noun: "a device" },
};

/** `method` as it reads after "with", e.g. "Signed in with a password". Supabase's provider name
 *  for Microsoft is `azure`; the log must not expose that implementation detail. */
const METHOD_WITH_LABELS: Readonly<Record<string, string>> = {
  password: "a password",
  google: "Google",
  azure: "Microsoft",
};

/** `method` as it reads inside parentheses, e.g. "Sign-in refused (password)" — no article. */
const METHOD_PAREN_LABELS: Readonly<Record<string, string>> = {
  password: "password",
  google: "Google",
  azure: "Microsoft",
};

/** Irregular past tenses for the leading verb word. Everything else is conjugated by rule. */
const IRREGULAR_PAST: Readonly<Record<string, string>> = {
  set: "set",
  run: "ran",
  send: "sent",
};

function conjugate(word: string): string {
  const irregular = IRREGULAR_PAST[word];
  if (irregular) return irregular;
  if (word.endsWith("e")) return `${word}d`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ied`;
  return `${word}ed`;
}

/** Conjugates only the leading word of a (possibly multi-word) base-form verb phrase. */
function pastTensePhrase(phrase: string): string {
  const [first, ...rest] = phrase.split(" ");
  return [conjugate(first), ...rest].join(" ");
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function identifier(details: Record<string, string>): string | null {
  return details.code || details.name || details.email || null;
}

/** Short noun-and-verb label for the filter dropdown; the raw key when `action` is unknown. */
export function actionLabel(action: string): string {
  const entry = VERBS[action];
  if (!entry) return action;
  return [entry.noun, entry.verb].filter(Boolean).join(" ");
}

export function summarise(e: Describable): string {
  // Special-cased: the generic verb/noun composition below reads badly for these two
  // ("Not allowed to signed in"). See the design doc, section 1, for why sign-in/sign-out cannot
  // go through withMember's normal logging path in the first place.
  if (e.action === "auth.signIn" || e.action === "auth.signOut") {
    if (e.action === "auth.signOut") return "Signed out";
    switch (e.outcome) {
      case "ok": {
        const method = METHOD_WITH_LABELS[e.details.method];
        return method ? `Signed in with ${method}` : "Signed in";
      }
      case "refused": {
        const method = METHOD_PAREN_LABELS[e.details.method];
        return method ? `Sign-in refused (${method})` : "Sign-in refused";
      }
      case "failed": {
        const method = METHOD_PAREN_LABELS[e.details.method];
        return method ? `Sign-in failed (${method})` : "Sign-in failed";
      }
    }
  }

  const entry = VERBS[e.action];

  // Unknown action: render the key itself, still with the outcome treatment, so an entry for an
  // action added later is a readable gap rather than a blank or a throw.
  if (!entry) {
    switch (e.outcome) {
      case "ok":
        return e.action;
      case "refused":
        return `Not allowed to ${e.action}`;
      case "failed":
        return `Tried to ${e.action}`;
    }
  }

  const id = identifier(e.details);
  const subject = [entry.noun, id].filter(Boolean).join(" ");
  const basePhrase = subject ? `${entry.verb} ${subject}` : entry.verb;

  switch (e.outcome) {
    case "ok":
      return capitalize(pastTensePhrase(basePhrase));
    case "refused":
      return `Not allowed to ${basePhrase}`;
    case "failed":
      return `Tried to ${basePhrase}`;
  }
}
