import * as crypto from "node:crypto";

import { argon2id } from "hash-wasm";

// PHC strings retain their own parameters. Increase these to upgrade on login.
export const ARGON2_POLICY = { memory: 65536, passes: 3, parallelism: 1, length: 32 };

export function validPassword(password: string): boolean {
  if (password.length > 512) return false;
  const length = [...password].length;
  return length >= 12 && length <= 256 && !password.includes("\0");
}

async function derive(
  password: string,
  salt: Buffer,
  memory: number,
  passes: number,
  parallelism: number,
  length: number,
) {
  // Node 24.2 remains supported. Native Argon2 arrived in 24.7; the bundled
  // WASM implementation keeps older Node installs and distribution formats working.
  if (typeof crypto.argon2 === "function") {
    return new Promise<Buffer>((resolve, reject) => {
      crypto.argon2(
        "argon2id",
        {
          message: password,
          nonce: salt,
          memory,
          passes,
          parallelism,
          tagLength: length,
        },
        (error, result) => (error ? reject(error) : resolve(result)),
      );
    });
  }
  return Buffer.from(
    await argon2id({
      password,
      salt,
      memorySize: memory,
      iterations: passes,
      parallelism,
      hashLength: length,
      outputType: "binary",
    }),
  );
}

export async function hashPassword(password: string, previous?: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const old = previous ? /m=(\d+),t=(\d+),p=(\d+)/.exec(previous) : null;
  const p = {
    ...ARGON2_POLICY,
    memory: Math.max(ARGON2_POLICY.memory, Number(old?.[1] ?? 0)),
    passes: Math.max(ARGON2_POLICY.passes, Number(old?.[2] ?? 0)),
    parallelism: Math.max(ARGON2_POLICY.parallelism, Number(old?.[3] ?? 0)),
  };
  const digest = await derive(password, salt, p.memory, p.passes, p.parallelism, p.length);
  return `$argon2id$v=19$m=${p.memory},t=${p.passes},p=${p.parallelism}$${salt.toString("base64").replaceAll("=", "")}$${digest.toString("base64").replaceAll("=", "")}`;
}

export async function verifyPassword(
  encoded: string,
  password: string,
): Promise<{ valid: boolean; rehash: boolean }> {
  const match =
    /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(encoded);
  if (!match) return { valid: false, rehash: false };
  const [, m, t, p, salt64, digest64] = match;
  const [memory, passes, parallelism] = [Number(m), Number(t), Number(p)];
  const salt = Buffer.from(salt64, "base64");
  const expected = Buffer.from(digest64, "base64");
  // Corrupt database values must not trigger unbounded allocations.
  if (
    memory < 8 * parallelism ||
    memory > 262144 ||
    passes < 1 ||
    passes > 10 ||
    parallelism < 1 ||
    parallelism > 4 ||
    salt.length < 8 ||
    expected.length !== 32
  )
    return { valid: false, rehash: false };
  const actual = await derive(password, salt, memory, passes, parallelism, expected.length);
  const valid = crypto.timingSafeEqual(expected, actual);
  return {
    valid,
    rehash:
      valid &&
      (memory < ARGON2_POLICY.memory ||
        passes < ARGON2_POLICY.passes ||
        parallelism < ARGON2_POLICY.parallelism ||
        salt.length < 16),
  };
}
