#!/usr/bin/env bun
// stagedoor: the Discord Developer Portal from the terminal, for developers and AI agents.
//
//   stagedoor <command> [args] [--json] [--dry-run] [--yes] [--env-file .env | --token-file path]
//
// Exit codes: 0 done, 1 usage error, 2 Discord refused or failed, 3 needs --yes.

import { createApi, DiscordApiError, type FetchFn } from "./api.ts";
import { type Command, COMMANDS, type Context, UsageError } from "./commands.ts";
import { loadToken } from "./token.ts";

const GLOBAL_OPTIONS: Record<string, { type: "string" | "boolean"; description: string }> = {
  json: { type: "boolean", description: "Machine-readable output: {ok, data} or {ok:false, error}" },
  "dry-run": { type: "boolean", description: "Show the request a change would send, without sending it" },
  yes: { type: "boolean", description: "Confirm a destructive command (deletes or overwrites)" },
  verbose: { type: "boolean", description: "Print each request (method and path; never the token) to stderr" },
  "env-file": { type: "string", description: "Read DISCORD_BOT_TOKEN or DISCORD_TOKEN from this .env file" },
  "token-file": { type: "string", description: "Read the bot token from this file" },
};

export interface Parsed {
  words: string[];
  options: Record<string, string | boolean>;
}

/** --flag value, --flag=value and boolean --flag; everything else is a word. */
export function parseArgs(argv: string[], booleans: Set<string>): Parsed {
  const words: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      words.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (eq > 0) options[name] = a.slice(eq + 1);
    else if (booleans.has(name)) options[name] = true;
    else {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      options[name] = value;
      i++;
    }
  }
  return { words, options };
}

/** The command with the longest matching path; the rest of the words are its arguments. */
export function findCommand(words: string[]): { command: Command; args: string[] } | null {
  let best: Command | null = null;
  for (const c of COMMANDS) {
    if (c.path.every((p, i) => words[i] === p) && (!best || c.path.length > best.path.length)) best = c;
  }
  return best ? { command: best, args: words.slice(best.path.length) } : null;
}

export function describe() {
  return {
    name: "stagedoor",
    about: "The Discord Developer Portal from the terminal. Works with an app's bot token; it can't create apps or rename them (the API has no such endpoint).",
    token: "DISCORD_BOT_TOKEN or DISCORD_TOKEN in the environment, or --env-file / --token-file",
    exitCodes: { 0: "done", 1: "usage error", 2: "Discord refused or failed", 3: "destructive: rerun with --yes" },
    globalOptions: GLOBAL_OPTIONS,
    commands: COMMANDS.map((c) => ({
      command: c.path.join(" "),
      summary: c.summary,
      args: c.args ?? [],
      options: c.options ?? {},
      mutating: Boolean(c.mutating),
      destructive: Boolean(c.destructive),
    })),
  };
}

function usage(): string {
  const rows = COMMANDS.map((c) => `  ${[...c.path, ...(c.args ?? []).map((a) => `<${a.name}>`)].join(" ").padEnd(34)} ${c.summary}`);
  return [
    "stagedoor: the Discord Developer Portal from the terminal",
    "",
    "Commands:",
    ...rows,
    `  ${"describe".padEnd(34)} Every command, its arguments and options, as JSON (for agents)`,
    "",
    "Options:",
    ...Object.entries(GLOBAL_OPTIONS).map(([k, v]) => `  --${k.padEnd(32)} ${v.description}`),
    "",
    "`stagedoor help <command>` shows a command's own options.",
  ].join("\n");
}

function commandHelp(c: Command): string {
  const lines = [`stagedoor ${[...c.path, ...(c.args ?? []).map((a) => `<${a.name}>`)].join(" ")}`, "", c.summary];
  for (const a of c.args ?? []) lines.push(`  <${a.name}>  ${a.description}`);
  for (const [k, v] of Object.entries(c.options ?? {})) lines.push(`  --${k}${v.type === "string" ? " <value>" : ""}  ${v.description}`);
  if (c.mutating) lines.push("", "Changes Discord; --dry-run shows the request without sending it.");
  if (c.destructive) lines.push("Deletes or overwrites: needs --yes.");
  return lines.join("\n");
}

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  /** Tests pass a fake Discord. */
  fetch?: FetchFn;
}

const realIo: Io = { out: (s) => console.log(s), err: (s) => console.error(s), env: process.env as Record<string, string | undefined> };

export async function main(argv: string[], io: Io = realIo): Promise<number> {
  const booleans = new Set(Object.entries(GLOBAL_OPTIONS).filter(([, v]) => v.type === "boolean").map(([k]) => k));
  for (const c of COMMANDS) for (const [k, v] of Object.entries(c.options ?? {})) if (v.type === "boolean") booleans.add(k);
  let json = argv.includes("--json");
  const fail = (code: number, message: string, extra: Record<string, unknown> = {}) => {
    if (json) io.out(JSON.stringify({ ok: false, error: { message, ...extra } }));
    else io.err(message);
    return code;
  };

  let parsed: Parsed;
  try {
    parsed = parseArgs(argv, booleans);
  } catch (err) {
    return fail(1, (err as Error).message);
  }
  json = parsed.options.json === true;
  const [first, ...rest] = parsed.words;
  if (!first || first === "help" || parsed.options.help === true) {
    const target = first === "help" ? findCommand(rest) : null;
    io.out(target ? commandHelp(target.command) : usage());
    return 0;
  }
  if (first === "describe") {
    io.out(JSON.stringify(describe(), null, 2));
    return 0;
  }
  const found = findCommand(parsed.words);
  if (!found) return fail(1, `Unknown command "${parsed.words.join(" ")}". Run \`stagedoor help\`.`);
  const { command, args } = found;
  const known = new Set([...Object.keys(GLOBAL_OPTIONS), ...Object.keys(command.options ?? {})]);
  const unknown = Object.keys(parsed.options).filter((k) => !known.has(k));
  if (unknown.length) return fail(1, `Unknown option ${unknown.map((u) => `--${u}`).join(", ")} for \`${command.path.join(" ")}\`. Run \`stagedoor help ${command.path.join(" ")}\`.`);
  const dryRun = parsed.options["dry-run"] === true;
  if (command.destructive && !dryRun && parsed.options.yes !== true) {
    return fail(3, `\`${command.path.join(" ")}\` deletes or overwrites. Rerun with --yes, or --dry-run to see what it would do.`, { needsYes: true });
  }

  let token: string;
  try {
    token = await loadToken({ tokenFile: parsed.options["token-file"] as string | undefined, envFile: parsed.options["env-file"] as string | undefined, env: io.env });
  } catch (err) {
    return fail(1, (err as Error).message);
  }
  const api = createApi({ token, fetch: io.fetch, sleep: io.fetch ? async () => {} : undefined, onRequest: parsed.options.verbose === true ? (m, p) => io.err(`→ ${m} ${p}`) : undefined });
  let appId: string | null = null;
  const sent: { method: string; path: string; body?: unknown }[] = [];
  const ctx: Context = {
    api,
    dryRun,
    async appId() {
      appId ??= (await api.request<{ id: string }>("GET", "/applications/@me")).id;
      return appId;
    },
    async send(method, path, body) {
      if (dryRun) {
        sent.push({ method, path, body: shortenImages(body) });
        return null;
      }
      return api.request(method, path, body);
    },
  };

  try {
    const result = await command.run(ctx, args, parsed.options);
    if (json) io.out(JSON.stringify({ ok: true, ...(dryRun ? { dryRun: true, requests: sent } : {}), data: result.data }));
    else {
      io.out(result.text);
      for (const r of sent) io.out(`[dry run] ${r.method} ${r.path}${r.body === undefined ? "" : ` ${JSON.stringify(r.body)}`}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof UsageError) return fail(1, err.message);
    if (err instanceof DiscordApiError) {
      const details = err.details.length ? `\n${err.details.map((d) => `  ${d}`).join("\n")}` : "";
      return json ? fail(2, err.message, { status: err.status, code: err.code, details: err.details }) : fail(2, err.message + details);
    }
    return fail(2, err instanceof Error ? err.message : String(err));
  }
}

/** Data URIs in a dry-run body become "data:image/png;base64,… (12 KiB)". */
function shortenImages(body: unknown): unknown {
  if (typeof body === "string" && body.startsWith("data:")) return `${body.slice(0, body.indexOf(",") + 1)}… (${Math.ceil(body.length / 1024)} KiB)`;
  if (Array.isArray(body)) return body.map(shortenImages);
  if (typeof body === "object" && body !== null) return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, shortenImages(v)]));
  return body;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
