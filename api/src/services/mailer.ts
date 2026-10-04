import crypto from 'node:crypto';
import type { Db } from '../db';
import { config } from '../config';

export interface OutgoingEmail {
  to: string;
  cc?: string | null;
  replyTo?: string | null;
  subject: string;
  text: string;
  html?: string | null;
}

export interface MailProvider {
  send(m: OutgoingEmail): Promise<{ id: string }>;
}

class ConsoleProvider implements MailProvider {
  sent: OutgoingEmail[] = [];
  async send(m: OutgoingEmail) {
    this.sent.push(m);
    if (!config.isTest) console.log(`[email:console] to=${m.to} subject="${m.subject}"`);
    return { id: `console-${crypto.randomUUID()}` };
  }
}

class SmtpProvider implements MailProvider {
  async send(m: OutgoingEmail) {
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport(config.email.smtpUrl);
    const info = await transport.sendMail({
      from: `"${config.email.fromName}" <${config.email.from}>`,
      to: m.to,
      cc: m.cc ?? undefined,
      replyTo: m.replyTo ?? undefined,
      subject: m.subject,
      text: m.text,
      html: m.html ?? undefined,
    });
    return { id: String(info.messageId) };
  }
}

class AcsProvider implements MailProvider {
  async send(m: OutgoingEmail) {
    const { EmailClient } = await import('@azure/communication-email');
    let client;
    if (config.email.acsConnectionString) {
      client = new EmailClient(config.email.acsConnectionString);
    } else {
      const { DefaultAzureCredential } = await import('@azure/identity');
      client = new EmailClient(config.email.acsEndpoint, new DefaultAzureCredential());
    }
    const poller = await client.beginSend({
      senderAddress: config.email.from,
      content: { subject: m.subject, plainText: m.text, html: m.html ?? undefined },
      recipients: { to: [{ address: m.to }], cc: m.cc ? [{ address: m.cc }] : undefined },
      replyTo: m.replyTo ? [{ address: m.replyTo }] : undefined,
    });
    // Accepted for delivery is enough here; delivery status can be tracked via Event Grid later.
    return { id: (poller.getOperationState() as { id?: string }).id ?? crypto.randomUUID() };
  }
}

let provider: MailProvider | null = null;
export function getMailProvider(): MailProvider {
  if (!provider) {
    provider =
      config.email.provider === 'smtp'
        ? new SmtpProvider()
        : config.email.provider === 'acs'
          ? new AcsProvider()
          : new ConsoleProvider();
  }
  return provider;
}
export function setMailProviderForTests(p: MailProvider | null): void {
  provider = p;
}
export { ConsoleProvider };

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** Queue an email. Delivery happens in processOutbox so requests never wait on (or fail because of) the mail provider. */
export async function queueEmail(
  db: Db,
  args: OutgoingEmail & { kind: string; communityId?: string | null; incidentId?: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db('email_outbox').insert({
    id,
    community_id: args.communityId ?? null,
    incident_id: args.incidentId ?? null,
    kind: args.kind,
    to_addr: args.to,
    cc_addr: args.cc ?? null,
    reply_to: args.replyTo ?? null,
    subject: args.subject,
    text_body: args.text,
    html_body: args.html ?? null,
    status: 'queued',
    attempts: 0,
    created_at: now,
    next_attempt_at: now,
  });
  return id;
}

export type OutboxHook = (row: { id: string; incident_id: string | null; kind: string; status: 'sent' | 'failed'; error?: string }) => Promise<void>;

const MAX_ATTEMPTS = 5;

export async function processOutbox(db: Db, onResult?: OutboxHook): Promise<{ sent: number; failed: number; retried: number }> {
  const now = new Date().toISOString();
  const due = await db('email_outbox').where('status', 'queued').andWhere('next_attempt_at', '<=', now).orderBy('created_at').limit(25);
  let sent = 0;
  let failed = 0;
  let retried = 0;
  for (const row of due) {
    try {
      const res = await getMailProvider().send({
        to: row.to_addr,
        cc: row.cc_addr,
        replyTo: row.reply_to,
        subject: row.subject,
        text: row.text_body,
        html: row.html_body,
      });
      await db('email_outbox').where({ id: row.id }).update({ status: 'sent', sent_at: new Date().toISOString(), provider_id: res.id, attempts: row.attempts + 1, last_error: null });
      sent++;
      await onResult?.({ id: row.id, incident_id: row.incident_id, kind: row.kind, status: 'sent' });
    } catch (e) {
      const attempts = row.attempts + 1;
      const message = e instanceof Error ? e.message.slice(0, 500) : 'send failed';
      if (attempts >= MAX_ATTEMPTS) {
        await db('email_outbox').where({ id: row.id }).update({ status: 'failed', attempts, last_error: message });
        failed++;
        await onResult?.({ id: row.id, incident_id: row.incident_id, kind: row.kind, status: 'failed', error: message });
      } else {
        const backoffMin = 2 ** attempts * 2; // 4, 8, 16, 32 minutes
        await db('email_outbox')
          .where({ id: row.id })
          .update({ attempts, last_error: message, next_attempt_at: new Date(Date.now() + backoffMin * 60_000).toISOString() });
        retried++;
      }
    }
  }
  return { sent, failed, retried };
}
