import { readFileSync, statSync } from "node:fs";

/**
 * Private keys never live in the repo or in config files that get committed.
 * They are read from environment variables, or from a file path given in an
 * environment variable (chmod 600 enforced). The value is returned as a raw
 * string; each chain package turns it into its own signer type.
 *
 *   EVM_PRIVATE_KEY / EVM_PRIVATE_KEY_FILE   0x-prefixed 32-byte hex
 *   SUI_PRIVATE_KEY / SUI_PRIVATE_KEY_FILE   suiprivkey1... (bech32) or base64
 */
export function loadSecret(name: "EVM_PRIVATE_KEY" | "SUI_PRIVATE_KEY", env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env[name];
  if (direct && direct.trim()) return direct.trim();
  const file = env[`${name}_FILE`];
  if (!file) return undefined;
  const st = statSync(file);
  if ((st.mode & 0o077) !== 0) throw new Error(`${file}: permissions too open (${(st.mode & 0o777).toString(8)}); run chmod 600`);
  const v = readFileSync(file, "utf8").trim();
  return v || undefined;
}

export function requireSecret(name: "EVM_PRIVATE_KEY" | "SUI_PRIVATE_KEY", env: NodeJS.ProcessEnv = process.env): string {
  const v = loadSecret(name, env);
  if (!v) throw new Error(`${name} (or ${name}_FILE) is not set — live mode needs a signer`);
  return v;
}

/** Redact anything that looks like a key before it reaches a log line or Telegram. */
export function redact(s: string): string {
  return s
    .replace(/0x[0-9a-fA-F]{64}/g, "0x<redacted64>")
    .replace(/suiprivkey1[0-9a-z]+/g, "suiprivkey1<redacted>");
}
