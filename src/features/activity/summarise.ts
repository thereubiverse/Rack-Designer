/** Turns one activity_log row into a short English sentence. PURE — no database, no React.
 *
 *  `VERBS` covers the keys in `LOGGED_FIELDS` (see redact.ts) but does not need to cover every one:
 *  an action added later without a VERBS entry falls back to rendering its raw key, which is a far
 *  better failure than throwing or going blank. */

export interface Describable {
  action: string;
  details: Record<string, string>;
  outcome: "ok" | "refused" | "failed";
}

/** `verb` is the base (infinitive) form, e.g. "rename" or "clear the outline of" — used as-is for
 *  `refused`/`failed` ("Not allowed to rename client ACME") and conjugated to past tense for `ok`
 *  ("Renamed client ACME"). Only the leading word of a multi-word verb is conjugated. */
const VERBS: Readonly<Record<string, { verb: string; noun: string }>> = {
  "client.create": { verb: "create", noun: "client" },
  "client.rename": { verb: "rename", noun: "client" },
  "client.archive": { verb: "archive", noun: "client" },
  "client.restore": { verb: "restore", noun: "client" },
  "site.create": { verb: "create", noun: "site" },
  "site.rename": { verb: "rename", noun: "site" },
  "site.archive": { verb: "archive", noun: "site" },
  "site.restore": { verb: "restore", noun: "site" },
  "site.locate": { verb: "locate", noun: "site" },
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
  "brand.create": { verb: "create", noun: "brand" },
  "brand.delete": { verb: "delete", noun: "brand" },
  "deviceType.create": { verb: "create", noun: "device type" },
  "deviceType.save": { verb: "save", noun: "device type" },
  "deviceType.delete": { verb: "delete", noun: "device type" },

  "ai.discoverRooms": { verb: "run room discovery on", noun: "floor" },
  "ai.discoverDevices": { verb: "run device discovery on", noun: "floor" },
  "ai.discoverSymbols": { verb: "run symbol discovery on", noun: "floor" },
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
  return `${entry.noun} ${entry.verb}`;
}

export function summarise(e: Describable): string {
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
