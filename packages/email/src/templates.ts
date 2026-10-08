/**
 * Plain-text security emails. Plain text avoids HTML injection entirely;
 * user-controlled values (names, organization names) appear only on their own
 * line and never as link targets.
 */
import type { EmailMessage } from './index';

interface Base {
  readonly to: string;
  readonly appName: string;
}

const footer = (appName: string) =>
  `\n\nIf you did not expect this email, you can ignore it. Never share links from ${appName} emails.\n`;

export function verificationEmail(p: Base & { link: string }): EmailMessage {
  return {
    to: p.to,
    subject: `Verify your email for ${p.appName}`,
    text: `Confirm your email address to finish creating your account:\n\n${p.link}\n\nThis link expires in 24 hours.${footer(p.appName)}`,
  };
}

export function existingAccountEmail(p: Base & { resetLink: string }): EmailMessage {
  return {
    to: p.to,
    subject: `Sign-up attempt for your ${p.appName} account`,
    text:
      `Someone tried to create a new account with this email address, but you already have one.\n\n` +
      `If it was you, sign in instead. If you forgot your password, reset it here:\n\n${p.resetLink}${footer(p.appName)}`,
  };
}

export function passwordResetEmail(p: Base & { link: string }): EmailMessage {
  return {
    to: p.to,
    subject: `Reset your ${p.appName} password`,
    text: `Use this link to choose a new password:\n\n${p.link}\n\nThis link expires in 30 minutes and can be used once. Resetting signs out all sessions.${footer(p.appName)}`,
  };
}

export function securityNoticeEmail(p: Base & { event: string }): EmailMessage {
  return {
    to: p.to,
    subject: `Security notice from ${p.appName}`,
    text: `This is a notice that the following happened on your account:\n\n  ${p.event}\n\nIf this was not you, reset your password immediately and contact your administrator.${footer(p.appName)}`,
  };
}

export function invitationEmail(
  p: Base & { organizationName: string; role: string; link: string },
): EmailMessage {
  return {
    to: p.to,
    subject: `You have been invited to an organization on ${p.appName}`,
    text: `You were invited to join this organization as ${p.role}:\n\n  ${p.organizationName}\n\nAccept the invitation while signed in with this email address:\n\n${p.link}\n\nThis invitation expires in 7 days.${footer(p.appName)}`,
  };
}
