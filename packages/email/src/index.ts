/**
 * Outbound email. Phase 2 provides the transport abstraction and the
 * security emails authentication needs; Phase 10 adds the notification
 * outbox, more templates and inbound forwarding.
 *
 * Email is never on the critical path: `sendSafely` logs failures instead of
 * throwing, so an SMTP outage cannot block registration, payments or
 * withdrawals. Users can always request another verification or reset email.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from '@actualpay/shared';

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  readonly from: string;
  readonly username?: string;
  readonly password?: string;
}

export class SmtpMailer implements Mailer {
  readonly #transport: Transporter;
  readonly #from: string;

  constructor(options: SmtpOptions) {
    this.#from = options.from;
    this.#transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      // Port 465 is implicit TLS; other ports must upgrade with STARTTLS.
      secure: options.port === 465,
      requireTLS: options.port !== 465,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      ...(options.username && options.password
        ? { auth: { user: options.username, pass: options.password } }
        : {}),
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.#transport.sendMail({
      from: this.#from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

/** Test double: keeps messages in memory for assertions. */
export class MemoryMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
  lastTo(to: string): EmailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}

/**
 * Development only: writes emails (including one-time links) to the log so a
 * developer can click them without an SMTP server. Constructing it outside
 * development/test throws, because those links are credentials.
 */
export class DevLogMailer implements Mailer {
  readonly #logger: Logger;
  constructor(logger: Logger, env: string) {
    if (env !== 'development' && env !== 'test') {
      throw new Error('DevLogMailer is only allowed in development and test');
    }
    this.#logger = logger;
  }
  send(message: EmailMessage): Promise<void> {
    this.#logger.warn(
      { devEmail: { to: message.to, subject: message.subject, body: message.text } },
      'DEV EMAIL (not sent)',
    );
    return Promise.resolve();
  }
}

export async function sendSafely(
  mailer: Mailer,
  message: EmailMessage,
  logger: Logger,
): Promise<boolean> {
  try {
    await mailer.send(message);
    return true;
  } catch (error) {
    // Log the subject only: the body may contain one-time links.
    logger.error({ err: error, subject: message.subject }, 'email delivery failed');
    return false;
  }
}

export * from './templates';
