import "server-only";

import nodemailer from "nodemailer";

/** The SMTP boundary, deliberately thin so the action tests can fake this whole module — exactly
 *  like `src/features/profile/sms.ts`.
 *
 *  nodemailer speaks SMTP to both Mailpit (local dev) and Resend (production), so there is one
 *  code path rather than an HTTP client for production and something else for development.
 *
 *  Credentials come from the environment and MUST NOT be written into any committed file. Until
 *  they exist, emailConfigured() is false and the UI says so rather than failing obscurely — the
 *  same treatment the Google, Microsoft and Twilio integrations get. */

const HOST = () => process.env.SMTP_HOST;
const PORT = () => process.env.SMTP_PORT;
const USER = () => process.env.SMTP_USER;
const PASSWORD = () => process.env.SMTP_PASSWORD;
const FROM = () => process.env.SMTP_FROM;

export function emailConfigured(): boolean {
  return Boolean(HOST() && PORT() && FROM());
}

/** Sends a plain-text email. This NEVER throws or rejects — the caller always gets a result it can
 *  act on, never a promise it has to remember to catch. */
export async function sendEmail(
  to: string,
  subject: string,
  text: string
): Promise<{ sent: boolean; reason?: string }> {
  const host = HOST();
  const port = PORT();
  const from = FROM();

  if (!host || !port || !from) {
    // Not configured. This wrapper will carry one-time device-approval codes, so what happens here
    // is security-sensitive, not just a convenience log:
    //
    // In development, printing the subject and body to the console is what makes the flow usable
    // on a fresh checkout with no mail server set up — the member reads the code from the terminal
    // instead of an inbox.
    //
    // In production, doing the same thing would mean a missed environment variable turns every
    // approval code into a line in a log file that other people can read. So in production we log
    // only the fact that sending failed, never the body — a misconfiguration must fail loudly
    // enough to get fixed, but it must not leak the codes it failed to send.
    if (process.env.NODE_ENV !== "production") {
      console.info("sendEmail: SMTP is not configured; would have sent:", { to, subject, text });
    } else {
      console.error("sendEmail: SMTP is not configured; email not sent");
    }
    return { sent: false, reason: "sendEmail: email is not configured" };
  }

  const user = USER();
  const password = PASSWORD();
  const numericPort = Number(port);

  const transporter = nodemailer.createTransport({
    host,
    port: numericPort,
    secure: numericPort === 465,
    auth: user && password ? { user, pass: password } : undefined,
  });

  try {
    await transporter.sendMail({ from, to, subject, text });
    return { sent: true };
  } catch (e) {
    // The provider's rejection can echo the recipient address, so it stays out of the returned
    // message and is only logged server-side, the same treatment sms.ts gives a Twilio rejection.
    console.error("sendEmail: provider rejected the message", e instanceof Error ? e.message : e);
    return { sent: false, reason: "sendEmail: provider rejected the message" };
  }
}
