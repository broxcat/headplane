import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import nodemailer from "nodemailer";
import { ulid } from "ulidx";

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

export async function createGuestMailer(config: HeadplaneConfig): Promise<GuestMailer> {
  const options = config.guest_invitations;
  if (!options?.enabled) return { enabled: false, send: async () => err("disabled") };
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

  return {
    enabled: true,
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
): GuestMail {
  const text = `${service} invitation\n\nHello ${name},\nAn administrator invited you to prepare guest access.\nAccept before ${expires.toISOString()} at:\n${link}\n\nA separate verification code will be sent to this email address before acceptance. Accepting does not activate VPN or network access. Ignore this message if it was not expected.`;
  return {
    to,
    subject: `${service}: guest invitation`,
    text,
    html: `<h1>${html(service)} invitation</h1><p>Hello ${html(name)},</p><p>An administrator invited you to prepare guest access.</p><p>Accept before ${html(expires.toISOString())}.</p><p><a href="${html(link)}">Review invitation</a></p><p>A separate verification code will be sent to this email address before acceptance.</p><p><strong>Accepting does not activate VPN or network access.</strong> Ignore this message if it was not expected.</p>`,
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
