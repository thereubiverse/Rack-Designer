/** What may be written into an activity entry, per action. PURE.
 *
 *  This is an ALLOWLIST and must stay one. A denylist protects only against the field names someone
 *  thought of; the next secret field added to a form is logged by default and nobody notices. An
 *  allowlist fails the other way — a new field is invisible until someone adds it, and a gap in a
 *  report is a far better failure than a live credential in a table every member can read. */

export const MAX_VALUE_LENGTH = 200;

/** Empty array = "record that it happened, and nothing about it". Absent key = the same, by default.
 *  Every action that carries a secret MUST appear here with an empty array, so the intent is stated
 *  rather than relying on someone never adding it. */
export const LOGGED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // Clients and locations
  "client.create": ["code", "name"],
  "client.rename": ["code", "name"],
  "client.archive": ["id"],
  "client.restore": ["id"],
  "client.delete": ["id"],
  "site.create": ["code", "name", "address"],
  "site.rename": ["code", "name", "address"],
  "site.archive": ["id"],
  "site.restore": ["id"],
  "site.locate": ["id"],
  "site.delete": ["id"],
  "floor.create": ["code", "name"],
  "floor.rename": ["code", "name"],
  "floor.archive": ["id"],
  "floor.restore": ["id"],
  "floor.delete": ["id"],
  "room.create": ["code", "name", "type"],
  "room.rename": ["code", "name", "type"],
  "room.delete": ["id"],
  "room.polygon.set": ["id"],
  "room.polygon.clear": ["id"],
  "floorDevice.create": ["code", "name", "typeId"],
  "floorDevice.update": ["code", "name", "typeId"],
  "floorDevice.delete": ["id"],
  "floorDevice.place": ["id"],
  "floorDevice.clearPlacement": ["id"],
  "floorPlan.upload": ["floorId"],
  "floorPlan.delete": ["floorId"],
  "rack.create": ["code", "name"],
  "rack.update": ["code", "name"],
  "rack.delete": ["id"],
  "rack.place": ["id"],
  "rack.clearPlacement": ["id"],
  "rack.layout.save": ["rackId"],
  "rack.connections.save": ["rackId"],
  "rack.endpoints.save": ["rackId"],

  // Device library
  "deviceTemplate.create": ["name"],
  "deviceTemplate.update": ["name"],
  "deviceTemplate.delete": ["id"],
  "deviceTemplate.duplicate": ["id"],
  // Pure reads (listTemplatesForTypeAction, getDeviceTemplateAction) — wrapped with { log: false },
  // so nothing is ever written for these. Listed anyway so the key is documented rather than an
  // unexplained gap, per the same reasoning as the SECRET-CARRYING entries below.
  "deviceTemplate.list": [],
  "deviceTemplate.get": [],
  "brand.create": ["name"],
  "brand.delete": ["id"],
  "deviceType.create": ["code", "name"],
  "deviceType.save": [],
  "deviceType.delete": ["id"],

  // AI — the inputs are floor/plan ids; the outputs are not logged.
  "ai.discoverRooms": ["floorId"],
  "ai.discoverDevices": ["floorId"],
  "ai.discoverSymbols": ["floorId"],
  "ai.pickSymbol": ["floorId"],
  "ai.extractGeometry": ["floorId"],
  "ai.detectPorts": [],
  "ai.identifyDevice": ["modelName"],

  // Members
  "member.invite": ["email", "name", "role"],
  "member.setRole": ["id", "role"],
  "member.setActive": ["id", "active"],

  // Own profile
  "profile.update": ["name", "position"],
  "profile.avatar.upload": [],
  "profile.avatar.remove": [],
  "phone.sendCode": [],

  // SECRET-CARRYING. These stay empty. That the action happened is the entire record.
  "password.change": [],
  "settings.deviceWizard.update": [],
  "phone.confirm": [],

  // Which door somebody came through is the useful part. The address is in actor_email (shape-
  // checked — see authLog.ts), and there is nothing else about a sign-in worth keeping.
  "auth.signIn": ["method"],
  "auth.signOut": ["method"],

  // Trusted devices. `label` (a browser/OS guess like "Chrome on Mac") is the one thing worth
  // showing in a report — which device, in terms a person recognises. Neither the six-digit code
  // nor the device token is EVER passed to these actions as a field named here, so redact() drops
  // both by default; the empty-allowlist actions below carry nothing else worth logging at all.
  // Empty, not ["label"], because a label CANNOT arrive here. `redact` is handed the action's first
  // argument, and the device label is derived server-side from the user-agent header — it is never
  // in the FormData. Allowing a field that can never be supplied is worse than allowing none: it
  // reads as "labels are recorded" to anyone auditing this list, when every entry is in fact empty.
  // Actor, action and outcome are what these entries carry.
  "device.challenge": [],
  "device.approve": [],
  "device.revoke": [],
  "device.adminApprove": [],
  "device.adminRevoke": [],
};

export function redact(action: string, raw: unknown): Record<string, string> {
  const allowed = LOGGED_FIELDS[action];
  // Unknown action: record nothing about it. Defaulting to "everything" here would mean any action
  // added later logs its whole payload, secrets included, until someone notices.
  if (!allowed || allowed.length === 0) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};

  const source = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const field of allowed) {
    const value = source[field];
    if (value === undefined || value === null || value === "") continue;
    out[field] = String(value).slice(0, MAX_VALUE_LENGTH);
  }
  return out;
}
