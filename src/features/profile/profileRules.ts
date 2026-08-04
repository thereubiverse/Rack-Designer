/** Profile validation, kept PURE so it can be tested without a database, a session or a network.
 *  The actions call these and do nothing clever of their own. */

export interface ProfileFields {
  name: string;
  phone: string;
  position: string;
  address: string;
}

/** 2 MB. Enforced server-side in the action: a client-side check is a courtesy, not a control. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** Matches `minimum_password_length` in supabase/config.toml. Supabase rejects anything shorter,
 *  and finding that out from a raw API error rather than a field message is a poor experience. */
export const MIN_PASSWORD_LENGTH = 6;

export function cleanProfileFields(
  raw: Partial<Record<keyof ProfileFields, unknown>>
): ProfileFields {
  // Trim the ends only. An address has line breaks and a name has spaces; collapsing interior
  // whitespace would quietly corrupt both.
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    name: s(raw.name),
    phone: s(raw.phone),
    position: s(raw.position),
    address: s(raw.address),
  };
}

export function checkAvatar(file: { size: number; type: string }): string | null {
  if (file.size === 0) return "That file is empty.";
  if (!file.type.startsWith("image/")) return "Choose an image file.";
  if (file.size > MAX_AVATAR_BYTES) return "Images must be 2 MB or smaller.";
  return null;
}

export function checkNewPassword(current: string, next: string, confirm: string): string | null {
  if (!current) return "Enter your current password.";
  if (next.length < MIN_PASSWORD_LENGTH) {
    return `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (next !== confirm) return "Those passwords don't match.";
  if (next === current) return "Your new password must be different from the current one.";
  return null;
}
