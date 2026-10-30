import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import nodemailer from "nodemailer";
import { ulid } from "ulidx";

import { accessDurationLabel, type AccessPlan } from "~/utils/guest-access";

import type { HeadplaneConfig } from "./config/config-schema";
import { ConfigError } from "./config/error";
import { err, ok, type Result } from "./result";

export interface GuestMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}
export interface GuestMailer {
  enabled: boolean;
  send(message: GuestMail): Promise<Result<void, "delivery_failed" | "disabled">>;
}

export function invitationPublicUrl(config: HeadplaneConfig) {
  const base = config.server.base_url;
  if (!base)
    throw ConfigError.from("INVALID_REQUIRED_FIELDS", {
      messages: ["Guest invitations require server.base_url."],
    });
  const url = new URL(base);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname) ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && local && config.guest_invitations?.transport === "file"))
  ) {
    throw ConfigError.from("INVALID_REQUIRED_FIELDS", {
      messages: [
        "Guest invitations require an HTTPS server.base_url origin. Loopback HTTP is allowed only for the file transport.",
      ],
    });
  }
  return `${url.origin}${config.server.base_path}/invite`;
}

export interface GuestMailTransport extends GuestMailer {
  check(): Promise<Result<"smtp" | "file", "delivery_failed" | "disabled" | "rate_limited">>;
}

export async function createGuestMailer(config: HeadplaneConfig): Promise<GuestMailTransport> {
  const options = config.guest_invitations;
  if (!options?.enabled)
    return {
      enabled: false,
      send: async () => err("disabled"),
      check: async () => err("disabled"),
    };
  invitationPublicUrl(config);
  if (options.transport === "smtp" && !config.server.cookie_secure) {
    throw ConfigError.from("INVALID_REQUIRED_FIELDS", {
      messages: ["SMTP invitations require server.cookie_secure: true."],
    });
  }
  if (/[\r\n]/.test(options.service_name + options.from_name)) {
    throw ConfigError.from("INVALID_REQUIRED_FIELDS", {
      messages: ["Guest invitation sender names must be single-line text."],
    });
  }
  const smtp = options.smtp;
  if (
    options.transport === "smtp" &&
    (!smtp?.host || Boolean(smtp.username) !== Boolean(smtp.password))
  ) {
    throw ConfigError.from("INVALID_REQUIRED_FIELDS", {
      messages: ["SMTP requires a host and either both credentials or neither."],
    });
  }
  const file = options.transport === "file";
  const directory = join(config.server.data_path, "guest-mail");
  if (file) await mkdir(directory, { recursive: true, mode: 0o700 });
  const transport = file
    ? nodemailer.createTransport({
        streamTransport: true,
        buffer: true,
        newline: "unix",
        disableFileAccess: true,
        disableUrlAccess: true,
      })
    : nodemailer.createTransport({
        host: smtp!.host,
        port: smtp!.port,
        secure: smtp!.security === "tls",
        requireTLS: smtp!.security === "starttls",
        auth: smtp!.username ? { user: smtp!.username, pass: smtp!.password! } : undefined,
        tls: {
          rejectUnauthorized: true,
          ca: smtp!.ca_path ? await readFile(smtp!.ca_path) : undefined,
        },
        connectionTimeout: options.timeout_ms,
        greetingTimeout: options.timeout_ms,
        socketTimeout: options.timeout_ms,
        dnsTimeout: options.timeout_ms,
        logger: false,
        debug: false,
        disableFileAccess: true,
        disableUrlAccess: true,
      });

  let checkedAt = -Infinity;
  return {
    enabled: true,
    async check() {
      if (Date.now() - checkedAt < 60_000) return err("rate_limited");
      checkedAt = Date.now();
      try {
        if (file) await access(directory, constants.W_OK);
        else await transport.verify();
        return ok(file ? "file" : "smtp");
      } catch {
        return err("delivery_failed");
      }
    },
    async send(message) {
      for (let attempt = 0; attempt <= options.retries; attempt++) {
        try {
          if (!file) await transport.verify();
          const result = await transport.sendMail({
            ...message,
            from: { name: options.from_name, address: options.from_address },
          });
          if (file)
            await writeFile(join(directory, `${ulid()}.eml`), result.message, {
              mode: 0o600,
              flag: "wx",
            });
          return ok(undefined);
        } catch (error) {
          // SMTP exceptions can contain recipients, credentials, or message data.
          // Return a fixed code; never forward or log the underlying exception.
          const code =
            error && typeof error === "object" && "responseCode" in error
              ? Number(error.responseCode)
              : 0;
          if (file || code >= 500 || attempt === options.retries) return err("delivery_failed");
        }
      }
      return err("delivery_failed");
    },
  };
}

function html(text: string) {
  return text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

export function invitationMail(
  to: string,
  name: string,
  service: string,
  expires: Date,
  link: string,
  accessPlan?: AccessPlan,
): GuestMail {
  const duration = accessPlan
    ? accessDurationLabel(accessPlan)
    : "To be confirmed by the administrator";
  const accessText = accessPlan?.requested_expires_at
    ? `Access expires at ${accessPlan.requested_expires_at.toISOString()} (absolute UTC deadline). If this deadline passes before VPN activation, access must not be activated.`
    : "The relative access countdown starts only when VPN permissions are actually activated in a future phase.";
  const deadline = expires.toISOString();
  const text = `${service} invitation\n\nHello ${name},\nRecipient: ${to}\nAn administrator invited you to prepare guest access.\nInvitation link expires at ${deadline} (UTC).\nPlanned access duration: ${duration}.\n${accessText}\n\n1. Open the invitation link:\n${link}\n2. Request a separate verification code at this email address.\n3. Enter the code and explicitly accept the administrative invitation.\n\nAccepting does not activate VPN or network access. Link expiration does not delete the guest record, which is retained for audit. Ignore this message if it was not expected.`;
  return {
    to,
    subject: `${service}: guest invitation`,
    text,
    html: `<main style="font-family:system-ui,sans-serif;max-width:600px;margin:auto;line-height:1.6"><h1>${html(service)} invitation</h1><p>Hello ${html(name)},</p><p>Recipient: ${html(to)}</p><p>An administrator invited you to prepare guest access.</p><dl><dt>Invitation link expires at</dt><dd>${html(deadline)} (UTC)</dd><dt>Planned access duration</dt><dd>${html(duration)}</dd></dl><p>${html(accessText)}</p><p><a href="${html(link)}">Review invitation</a></p><ol><li>Open the invitation link.</li><li>Request a separate verification code at this email address.</li><li>Enter the code and explicitly accept the administrative invitation.</li></ol><p><strong>Accepting does not activate VPN or network access.</strong></p><p>Link expiration does not delete the guest record, which is retained for audit.</p><p>Ignore this message if it was not expected.</p></main>`,
  };
}

export function verificationMail(to: string, service: string, code: string): GuestMail {
  return {
    to,
    subject: `${service}: verify your guest invitation`,
    text: `Your ${service} verification code is ${code}. It expires in 10 minutes. Enter it only on the invitation page. No VPN access will be activated. Ignore this message if it was not requested.`,
    html: `<p>Your ${html(service)} verification code is <strong>${html(code)}</strong>.</p><p>It expires in 10 minutes. Enter it only on the invitation page. No VPN access will be activated. Ignore this message if it was not requested.</p>`,
  };
}
