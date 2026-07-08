// Pure rules for device-type codes ("ID prefixes") and names. Codes prefix generated device IDs
// (SW01, SW02, ...) so they must be short, uppercase, and unique — see the design spec.

export const CODE_RULE = /^[A-Z0-9]{1,4}$/;

export const CODE_HELP =
  "1–4 characters, uppercase letters and numbers only. Must be unique across all device type ID prefixes.";

/** Coerce raw input toward a valid code: uppercase, alphanumerics only, max 4 chars. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

/** Null when valid, else the helper message (also used as the inline error). */
export function validateCode(code: string): string | null {
  return CODE_RULE.test(code) ? null : CODE_HELP;
}

export function validateTypeName(name: string): string | null {
  return name.trim() ? null : "Name is required";
}
