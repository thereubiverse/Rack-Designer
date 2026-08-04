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

/** Distinguishes a message that definitely never went out from one whose fate is unknown.
 *
 *  A 4xx means Twilio looked at the request and rejected it before doing anything — bad number,
 *  bad auth, malformed body. Nothing was sent, nothing was billed, so `definitelyNotSent` is true
 *  and the caller may treat this exactly like it never happened (e.g. free the pending row and its
 *  cooldown for an immediate retry).
 *
 *  A 5xx, or a fetch that throws before any response arrives (network failure, timeout), means we
 *  simply don't know: Twilio may have accepted and billed the message despite the failure we saw.
 *  `definitelyNotSent` is false in both cases, and the caller must NOT treat this as safe to retry
 *  freely — a retry loop here is a retry loop that bills a real text message on every pass. */
export class SmsError extends Error {
  constructor(message: string, readonly definitelyNotSent: boolean) {
    super(message);
    this.name = "SmsError";
  }
}

export async function sendSms(to: string, body: string): Promise<void> {
  const sid = SID(), token = TOKEN(), from = FROM();
  // Not configured means nothing was attempted at all — definitely not sent.
  if (!sid || !token || !from) throw new SmsError("sendSms: SMS is not configured", true);

  let res: Response;
  try {
    res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    });
  } catch (e) {
    // The request never got a response at all: Twilio may or may not have received it before the
    // connection died. Ambiguous, not a rejection.
    const detail = e instanceof Error ? e.message : String(e);
    throw new SmsError(`sendSms: request failed: ${detail}`, false);
  }
  if (!res.ok) {
    // Twilio's body can echo the destination number; keep it out of the message that reaches a
    // browser and log the detail server-side instead.
    console.error("sendSms: Twilio rejected the message", res.status, await res.text());
    // Only a 4xx is a definitive, pre-send rejection. A 5xx is Twilio's own failure and does not
    // prove the message wasn't accepted and billed before that failure occurred.
    const definitelyNotSent = res.status >= 400 && res.status < 500;
    throw new SmsError(`sendSms: provider returned ${res.status}`, definitelyNotSent);
  }
}
