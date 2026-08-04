import "server-only";

/** The Twilio boundary, deliberately thin so the action tests can fake this whole module.
 *
 *  Credentials come from the environment and MUST NOT be written into any committed file. Until
 *  they exist, smsConfigured() is false and the UI says so rather than failing obscurely — the same
 *  treatment the Google and Microsoft buttons get. */

const SID = () => process.env.TWILIO_ACCOUNT_SID;
const TOKEN = () => process.env.TWILIO_AUTH_TOKEN;
const FROM = () => process.env.TWILIO_FROM_NUMBER;

export function smsConfigured(): boolean {
  return Boolean(SID() && TOKEN() && FROM());
}

export async function sendSms(to: string, body: string): Promise<void> {
  const sid = SID(), token = TOKEN(), from = FROM();
  if (!sid || !token || !from) throw new Error("sendSms: SMS is not configured");

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!res.ok) {
    // Twilio's body can echo the destination number; keep it out of the message that reaches a
    // browser and log the detail server-side instead.
    console.error("sendSms: Twilio rejected the message", res.status, await res.text());
    throw new Error(`sendSms: provider returned ${res.status}`);
  }
}
