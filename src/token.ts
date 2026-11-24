// Where the bot token comes from, in order: --token-file, --env-file, then the environment.
// The token is never printed, logged or put in an error message.

import { readFile } from "node:fs/promises";

export const TOKEN_VARIABLES = ["DISCORD_BOT_TOKEN", "DISCORD_TOKEN"];

export interface TokenSources {
  tokenFile?: string;
  envFile?: string;
  env?: Record<string, string | undefined>;
}

/** A dotenv line's value: KEY=value, KEY="value" or KEY='value'; # comments ignored. */
export function readDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = (m[2] ?? "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1] as string] = value;
  }
  return out;
}

export async function loadToken(sources: TokenSources): Promise<string> {
  if (sources.tokenFile) {
    const token = (await readFile(sources.tokenFile, "utf8")).trim();
    if (token) return token;
    throw new Error(`${sources.tokenFile} is empty`);
  }
  const fromFile = sources.envFile ? readDotenv(await readFile(sources.envFile, "utf8")) : {};
  const env = sources.env ?? process.env;
  for (const name of TOKEN_VARIABLES) {
    const value = fromFile[name] ?? env[name];
    if (value?.trim()) return value.trim();
  }
  throw new Error(
    `No bot token. Set ${TOKEN_VARIABLES.join(" or ")}, or pass --env-file <path> or --token-file <path>. Copy it from the Developer Portal: your app -> Bot -> Reset Token.`,
  );
}
