/**
 * Email delivery layer (audit remediation: "mailer is a dev stub").
 *
 * Provider abstraction: a pluggable MailTransport sends a message and reports
 * whether the provider ACCEPTED it. Nothing here ever fakes delivery —
 * `sendMail` returns `delivered: false` with a reason whenever no transport is
 * configured or the provider rejects the message, so callers and logs always
 * reflect reality.
 *
 * Transports (selected by MAIL_TRANSPORT, or inferred from env):
 *   - smtp  — SMTP via nodemailer (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD)
 *   - http  — transactional HTTP JSON API (MAIL_HTTP_URL, optional MAIL_HTTP_TOKEN)
 *   - none  — no transport configured; development logs a preview only
 *
 * Logging policy: message bodies may contain reset links / verification codes,
 * so bodies are NEVER written to logs in production. Development (when no
 * transport is configured) logs a local preview to keep the dev loop usable.
 *
 * Credentials always come from environment variables — never hard-coded.
 */
import type { Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailSendResult {
  delivered: boolean;
  provider: string;
  reason?: string;
  messageId?: string;
}

export interface MailTransport {
  readonly name: string;
  send(message: MailMessage): Promise<{ messageId?: string }>;
}

export interface MailConfig {
  /** From-header for outgoing mail. */
  from: string;
}

function mailConfig(): MailConfig {
  return { from: process.env.MAIL_FROM || 'LINKUPCHAT <no-reply@localhost>' };
}

// ── Transports ─────────────────────────────────────────────────────────────

class SmtpTransport implements MailTransport {
  readonly name = 'smtp';
  private transporter: Transporter | null = null;

  private async client(): Promise<Transporter> {
    if (!this.transporter) {
      const nodemailer = (await import('nodemailer')).default;
      const port = Number(process.env.SMTP_PORT ?? 587);
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: port === 465,
        ...(process.env.SMTP_USER
          ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? '' } }
          : {})
      });
    }
    return this.transporter;
  }

  async send(message: MailMessage): Promise<{ messageId?: string }> {
    const transporter = await this.client();
    const info = await transporter.sendMail({
      from: mailConfig().from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {})
    });
    return { messageId: info.messageId };
  }
}

/**
 * Generic transactional HTTP transport: POSTs JSON `{to, subject, text, html}`
 * to MAIL_HTTP_URL with an optional Bearer token. This is the integration
 * point for Resend/SendGrid-style JSON APIs (or a company relay) without
 * coupling this module to any single vendor SDK.
 */
class HttpJsonTransport implements MailTransport {
  readonly name = 'http';

  async send(message: MailMessage): Promise<{ messageId?: string }> {
    const url = process.env.MAIL_HTTP_URL!;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.MAIL_HTTP_TOKEN
          ? { authorization: `Bearer ${process.env.MAIL_HTTP_TOKEN}` }
          : {})
      },
      body: JSON.stringify({
        from: mailConfig().from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {})
      })
    });
    if (!res.ok) throw new Error(`mail http transport rejected: HTTP ${res.status}`);
    return { messageId: res.headers.get('x-message-id') ?? undefined };
  }
}

function configuredTransportName(): 'smtp' | 'http' | 'none' {
  const explicit = process.env.MAIL_TRANSPORT?.toLowerCase();
  if (explicit === 'smtp' || explicit === 'http' || explicit === 'none') return explicit;
  if (process.env.SMTP_HOST) return 'smtp';
  if (process.env.MAIL_HTTP_URL) return 'http';
  return 'none';
}

function createTransport(): MailTransport | null {
  switch (configuredTransportName()) {
    case 'smtp':
      return new SmtpTransport();
    case 'http':
      return new HttpJsonTransport();
    default:
      return null;
  }
}

// ── Test seam (mocked transports in unit tests) ────────────────────────────
let testTransport: MailTransport | null = null;

/** Inject a mock transport for tests. Pass null to restore env-based config. */
export function setMailTransportForTests(transport: MailTransport | null) {
  testTransport = transport;
}

// ── Logging (never leaks bodies/tokens/links in production) ────────────────

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function logMailFailure(message: MailMessage, reason: string) {
  // Subject + recipient only — never the body (it may contain a reset URL).
  console.warn(`[mailer] delivery failed (${reason}) to=${message.to} subject="${message.subject}"`);
}

function logDevPreview(message: MailMessage) {
  console.info('\n────────── 📧 [MAIL:DEV] ──────────');
  console.info(`To:      ${message.to}`);
  console.info(`Subject: ${message.subject}`);
  console.info(message.text);
  console.info('───────────────────────────────────\n');
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function sendMail(message: MailMessage): Promise<MailSendResult> {
  if (!message.to) {
    logMailFailure(message, 'no-recipient');
    return { delivered: false, provider: 'none', reason: 'no-recipient' };
  }

  const transport = testTransport ?? createTransport();

  if (!transport) {
    if (isProduction()) {
      // Production without email configuration: fail clearly, log NO body.
      logMailFailure(message, 'not-configured');
      return { delivered: false, provider: 'none', reason: 'not-configured' };
    }
    // Development convenience: show the message locally. This is NOT
    // delivery — the result says so.
    logDevPreview(message);
    return { delivered: false, provider: 'none', reason: 'not-configured (dev preview logged)' };
  }

  try {
    const { messageId } = await transport.send(message);
    return { delivered: true, provider: transport.name, ...(messageId ? { messageId } : {}) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'transport-error';
    logMailFailure(message, reason);
    return { delivered: false, provider: transport.name, reason };
  }
}

export function verificationEmail(to: string, name: string, code: string): MailMessage {
  return {
    to,
    subject: 'Your LINKUPCHAT verification code',
    text: `Hi ${name},\n\nYour LINKUPCHAT verification code is: ${code}\n\nIt expires in 15 minutes. If you did not request this, you can safely ignore this email.\n\n— The LINKUPCHAT team`
  };
}

export function passwordResetEmail(to: string, name: string, resetUrl: string): MailMessage {
  return {
    to,
    subject: 'Reset your LINKUPCHAT password',
    text: `Hi ${name},\n\nWe received a request to reset your LINKUPCHAT password.\n\nOpen this link to choose a new password (valid for 1 hour):\n${resetUrl}\n\nIf you did not request this, you can safely ignore this email.\n\n— The LINKUPCHAT team`
  };
}
