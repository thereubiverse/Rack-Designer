"use server";

import { redirect } from "next/navigation";
import { createSessionClient } from "@/lib/supabase/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { getCurrentMember, normaliseEmail, NOT_A_MEMBER } from "./members";

/** Providers this app offers. Supabase names the Microsoft provider "azure". */
const PROVIDERS = { google: "google", microsoft: "azure" } as const;
type ProviderKey = keyof typeof PROVIDERS;

const PROVIDER_LABEL: Record<ProviderKey, string> = { google: "Google", microsoft: "Microsoft" };

/** Credentials live in the environment and nowhere else — never in config.toml, never committed. */
function providerConfigured(key: ProviderKey): boolean {
  return key === "google"
    ? Boolean(process.env.SUPABASE_AUTH_GOOGLE_CLIENT_ID)
    : Boolean(process.env.SUPABASE_AUTH_AZURE_CLIENT_ID);
}

/** Sign in, then apply the membership gate. Authenticating is not membership: a valid password for
 *  an auth user who is not an active member must NOT leave a usable session behind. */
export async function signInWithPasswordAction(
  formData: FormData
): Promise<{ ok: boolean; error?: string }> {
  const email = normaliseEmail(String(formData.get("email") ?? ""));
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { ok: false, error: "Enter your email and password." };

  const auth = await createSessionClient();
  const { error } = await auth.auth.signInWithPassword({ email, password });
  // Deliberately the same message as a non-member: a distinct "wrong password" reveals that the
  // address exists.
  if (error) return { ok: false, error: NOT_A_MEMBER };

  const member = await getCurrentMember();
  if (!member) {
    await auth.auth.signOut();
    return { ok: false, error: NOT_A_MEMBER };
  }
  await linkAuthUser(member.id, email);
  return { ok: true };
}

/** Record which auth user this member signed in as, the first time we see one. Purely informational
 *  — the gate matches on email — but it is what the admin screen shows as "has signed in". */
async function linkAuthUser(memberId: string, email: string): Promise<void> {
  const auth = await createSessionClient();
  const { data } = await auth.auth.getUser();
  if (!data.user) return;
  const db = createServiceClient();
  await db
    .from("members")
    .update({ auth_user_id: data.user.id })
    .eq("id", memberId)
    .is("auth_user_id", null);
  void email;
}

export async function signOutAction(): Promise<{ ok: boolean; error?: string }> {
  const auth = await createSessionClient();
  await auth.auth.signOut();
  redirect("/login");
}

/** Hand the browser a provider URL rather than building one client-side, so the redirect target is
 *  decided by the server and the client never needs to know provider names or keys. */
export async function oauthUrlAction(
  formData: FormData
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const key = String(formData.get("provider") ?? "") as ProviderKey;
  if (!(key in PROVIDERS)) return { ok: false, error: "Unknown sign-in provider." };
  if (!providerConfigured(key)) {
    return { ok: false, error: `${PROVIDER_LABEL[key]} sign-in isn't configured yet.` };
  }
  const auth = await createSessionClient();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3100";
  const { data, error } = await auth.auth.signInWithOAuth({
    provider: PROVIDERS[key],
    options: { redirectTo: `${origin}/auth/callback` },
  });
  if (error || !data.url) return { ok: false, error: `Couldn't start ${PROVIDER_LABEL[key]} sign-in.` };
  return { ok: true, url: data.url };
}
