// Every stagedoor command: what it takes, whether it changes anything, and what it does.
// `stagedoor describe` prints this table as JSON, so an agent can learn the CLI in one call.

import type { Api } from "./api.ts";
import { flagNames, INTENTS, type IntentName, intentStates, isIntentName, withIntent } from "./flags.ts";
import { imageDataUri } from "./image.ts";

export interface OptionSpec {
  type: "string" | "boolean";
  description: string;
}

export interface Context {
  api: Api;
  /** The app's ID, from GET /applications/@me (cached). */
  appId(): Promise<string>;
  /** Mutating requests go through here: with --dry-run they are recorded, not sent. */
  send<T = unknown>(method: string, path: string, body?: unknown): Promise<T | null>;
  dryRun: boolean;
}

export interface Result {
  /** For people. */
  text: string;
  /** For --json. */
  data: unknown;
}

export interface Command {
  path: string[];
  summary: string;
  args?: { name: string; description: string; optional?: boolean }[];
  options?: Record<string, OptionSpec>;
  /** Changes something in Discord. Supports --dry-run. */
  mutating?: boolean;
  /** Deletes or overwrites; refused without --yes. */
  destructive?: boolean;
  run(ctx: Context, args: string[], opts: Record<string, string | boolean | undefined>): Promise<Result>;
}

const GUILD: OptionSpec = { type: "string", description: "A server ID: guild commands instead of global ones" };
const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);

type App = Record<string, any>;

function appText(app: App): string {
  const intents = intentStates(app.flags ?? 0);
  const install = app.install_params ? `${app.install_params.scopes?.join(" ")} (permissions ${app.install_params.permissions})` : "not set";
  return [
    `${app.name} (${app.id})`,
    app.description ? `  description: ${app.description}` : "  description: (none)",
    `  tags: ${(app.tags ?? []).join(", ") || "(none)"}`,
    `  public bot: ${app.bot_public ? "yes" : "no"} · requires code grant: ${app.bot_require_code_grant ? "yes" : "no"}`,
    `  servers: ~${app.approximate_guild_count ?? "?"} · user installs: ~${app.approximate_user_install_count ?? "?"}`,
    `  intents: ${Object.entries(intents).map(([k, v]) => `${k} ${v}`).join(" · ")}`,
    `  interactions endpoint: ${app.interactions_endpoint_url || "(gateway)"}`,
    `  default install: ${install}`,
    `  flags: ${flagNames(app.flags ?? 0).join(", ") || "(none)"}`,
  ].join("\n");
}

async function image(path: string | undefined, maxBytes?: number): Promise<string | null | undefined> {
  if (path === undefined) return undefined;
  if (path === "none") return null; // remove it
  return imageDataUri(path, { maxBytes });
}

async function intentChange(ctx: Context, names: string[], on: boolean): Promise<Result> {
  if (names.length === 0) throw new UsageError(`Name the intents: ${Object.keys(INTENTS).join(", ")}`);
  for (const n of names) if (!isIntentName(n)) throw new UsageError(`Unknown intent "${n}"; use ${Object.keys(INTENTS).join(", ")}`);
  const app = await ctx.api.request<App>("GET", "/applications/@me");
  let flags = app.flags ?? 0;
  for (const n of names as IntentName[]) flags = withIntent(flags, n, on);
  const updated = await ctx.send<App>("PATCH", "/applications/@me", { flags });
  if (!updated) return { text: `Would send flags=${flags}`, data: { flags } };
  const states = intentStates(updated.flags ?? 0);
  const failed = (names as IntentName[]).filter((n) => (states[n] === "off") === on);
  return {
    text: `${Object.entries(states).map(([k, v]) => `${k}: ${v}`).join("\n")}${failed.length ? `\nDiscord didn't change: ${failed.join(", ")}` : ""}`,
    data: { intents: states, unchanged: failed },
  };
}

async function commandsPath(ctx: Context, guild: string | undefined): Promise<string> {
  const id = await ctx.appId();
  return guild ? `/applications/${id}/guilds/${guild}/commands` : `/applications/${id}/commands`;
}

/** The fields Discord accepts when creating a command; the rest are Discord's own. */
function creatable(cmd: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, application_id: _a, version: _v, guild_id: _g, ...rest } = cmd;
  return rest;
}

async function findEmoji(ctx: Context, name: string): Promise<{ id: string; name: string }> {
  const list = await ctx.api.request<{ items: { id: string; name: string }[] }>("GET", `/applications/${await ctx.appId()}/emojis`);
  const found = list.items.find((e) => e.name === name);
  if (!found) throw new UsageError(`No app emoji named "${name}"`);
  return found;
}

export class UsageError extends Error {
  name = "UsageError";
}

/** Permission names for invite links (a common subset; numbers work too). */
export const PERMISSIONS: Record<string, bigint> = {
  Administrator: 1n << 3n,
  ManageChannels: 1n << 4n,
  AddReactions: 1n << 6n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  ManageMessages: 1n << 13n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  MentionEveryone: 1n << 17n,
  UseExternalEmojis: 1n << 18n,
  Connect: 1n << 20n,
  Speak: 1n << 21n,
  ManageRoles: 1n << 28n,
  SendMessagesInThreads: 1n << 38n,
};

export function parsePermissions(value: string): bigint {
  if (/^\d+$/.test(value)) return BigInt(value);
  let total = 0n;
  for (const name of value.split(",").map((s) => s.trim()).filter(Boolean)) {
    const bit = PERMISSIONS[name];
    if (bit === undefined) throw new UsageError(`Unknown permission "${name}"; use a number or ${Object.keys(PERMISSIONS).join(", ")}`);
    total |= bit;
  }
  return total;
}

export const COMMANDS: Command[] = [
  {
    path: ["app"],
    summary: "Show the application: name, description, tags, intents, install settings, server count",
    async run(ctx) {
      const app = await ctx.api.request<App>("GET", "/applications/@me");
      return { text: appText(app), data: { ...app, intents: intentStates(app.flags ?? 0), flag_names: flagNames(app.flags ?? 0) } };
    },
  },
  {
    path: ["app", "set"],
    summary: "Change the application's description, tags, icon, cover image or URLs (the name can't be changed through the API)",
    mutating: true,
    options: {
      description: { type: "string", description: "The app's description (shown on its profile)" },
      tags: { type: "string", description: "Up to 5 comma-separated tags, 20 characters each" },
      icon: { type: "string", description: "PNG, JPEG or GIF file, or 'none' to remove it" },
      cover: { type: "string", description: "Rich Presence invite cover image file, or 'none'" },
      "interactions-url": { type: "string", description: "Interactions endpoint URL; empty string to use the gateway" },
      "install-url": { type: "string", description: "Custom install URL" },
      "role-connections-url": { type: "string", description: "Role connections verification URL" },
    },
    async run(ctx, _args, o) {
      const body: Record<string, unknown> = {};
      if (str(o.description) !== undefined) body.description = str(o.description);
      if (str(o.tags) !== undefined) {
        const tags = (str(o.tags) as string).split(",").map((t) => t.trim()).filter(Boolean);
        if (tags.length > 5 || tags.some((t) => t.length > 20)) throw new UsageError("At most 5 tags, 20 characters each");
        body.tags = tags;
      }
      const icon = await image(str(o.icon));
      if (icon !== undefined) body.icon = icon;
      const cover = await image(str(o.cover));
      if (cover !== undefined) body.cover_image = cover;
      if (str(o["interactions-url"]) !== undefined) body.interactions_endpoint_url = str(o["interactions-url"]);
      if (str(o["install-url"]) !== undefined) body.custom_install_url = str(o["install-url"]);
      if (str(o["role-connections-url"]) !== undefined) body.role_connections_verification_url = str(o["role-connections-url"]);
      if (Object.keys(body).length === 0) throw new UsageError("Nothing to change; see `stagedoor help app set`");
      const app = await ctx.send<App>("PATCH", "/applications/@me", body);
      return app ? { text: appText(app), data: app } : { text: "Would change the application", data: body };
    },
  },
  {
    path: ["intents"],
    summary: "Show the privileged gateway intents (presence, members, message-content)",
    async run(ctx) {
      const app = await ctx.api.request<App>("GET", "/applications/@me");
      const states = intentStates(app.flags ?? 0);
      return { text: Object.entries(states).map(([k, v]) => `${k}: ${v}`).join("\n"), data: states };
    },
  },
  {
    path: ["intents", "on"],
    summary: "Switch privileged intents on, like the toggles on the portal's Bot page (apps in under 100 servers)",
    args: [{ name: "intent...", description: "presence, members, message-content" }],
    mutating: true,
    run: (ctx, args) => intentChange(ctx, args, true),
  },
  {
    path: ["intents", "off"],
    summary: "Switch privileged intents off",
    args: [{ name: "intent...", description: "presence, members, message-content" }],
    mutating: true,
    run: (ctx, args) => intentChange(ctx, args, false),
  },
  {
    path: ["bot"],
    summary: "Show the bot user",
    async run(ctx) {
      const u = await ctx.api.request<App>("GET", "/users/@me");
      return { text: `${u.username} (${u.id})${u.avatar ? "" : " · no avatar"}${u.banner ? "" : " · no banner"}`, data: u };
    },
  },
  {
    path: ["bot", "set"],
    summary: "Change the bot's username, avatar or banner (Discord limits how often a username can change)",
    mutating: true,
    options: {
      username: { type: "string", description: "2-32 characters; no @ # : ``` or 'discord'" },
      avatar: { type: "string", description: "PNG, JPEG or GIF file, or 'none'" },
      banner: { type: "string", description: "PNG, JPEG or GIF file, or 'none'" },
    },
    async run(ctx, _args, o) {
      const body: Record<string, unknown> = {};
      if (str(o.username) !== undefined) body.username = str(o.username);
      const avatar = await image(str(o.avatar));
      if (avatar !== undefined) body.avatar = avatar;
      const banner = await image(str(o.banner));
      if (banner !== undefined) body.banner = banner;
      if (Object.keys(body).length === 0) throw new UsageError("Nothing to change; see `stagedoor help bot set`");
      const u = await ctx.send<App>("PATCH", "/users/@me", body);
      return u ? { text: `Updated ${u.username} (${u.id})`, data: u } : { text: "Would change the bot user", data: Object.keys(body) };
    },
  },
  {
    path: ["guilds"],
    summary: "List the servers the bot is in",
    async run(ctx) {
      const guilds = await ctx.api.request<{ id: string; name: string; owner: boolean }[]>("GET", "/users/@me/guilds?limit=200");
      return { text: guilds.map((g) => `${g.id}  ${g.name}`).join("\n") || "(none)", data: guilds };
    },
  },
  {
    path: ["commands"],
    summary: "List the app's slash commands (global, or one server's with --guild)",
    options: { guild: GUILD },
    async run(ctx, _a, o) {
      const list = await ctx.api.request<Record<string, any>[]>("GET", await commandsPath(ctx, str(o.guild)));
      return { text: list.map((c) => `/${c.name}  ${c.description ?? ""}  (${c.id})`).join("\n") || "(none)", data: list };
    },
  },
  {
    path: ["commands", "export"],
    summary: "Print the slash commands as JSON that `commands import` accepts",
    options: { guild: GUILD },
    async run(ctx, _a, o) {
      const list = (await ctx.api.request<Record<string, unknown>[]>("GET", await commandsPath(ctx, str(o.guild)))).map(creatable);
      return { text: JSON.stringify(list, null, 2), data: list };
    },
  },
  {
    path: ["commands", "import"],
    summary: "Replace all slash commands with the ones in a JSON file (Discord's bulk overwrite)",
    args: [{ name: "file", description: "A JSON array of commands, as `commands export` prints" }],
    options: { guild: GUILD },
    mutating: true,
    destructive: true,
    async run(ctx, args, o) {
      const file = args[0];
      if (!file) throw new UsageError("Name the JSON file");
      const list = JSON.parse(await Bun.file(file).text());
      if (!Array.isArray(list)) throw new UsageError(`${file} must hold a JSON array of commands`);
      const done = await ctx.send<Record<string, any>[]>("PUT", await commandsPath(ctx, str(o.guild)), list.map(creatable));
      return done ? { text: `Now ${done.length} commands: ${done.map((c) => `/${c.name}`).join(", ")}`, data: done } : { text: `Would set ${list.length} commands`, data: list };
    },
  },
  {
    path: ["commands", "delete"],
    summary: "Delete one slash command by name",
    args: [{ name: "name", description: "The command's name, without /" }],
    options: { guild: GUILD },
    mutating: true,
    destructive: true,
    async run(ctx, args, o) {
      const name = (args[0] ?? "").replace(/^\//, "");
      const path = await commandsPath(ctx, str(o.guild));
      const found = (await ctx.api.request<{ id: string; name: string }[]>("GET", path)).find((c) => c.name === name);
      if (!found) throw new UsageError(`No command named /${name}`);
      await ctx.send("DELETE", `${path}/${found.id}`);
      return { text: `${ctx.dryRun ? "Would delete" : "Deleted"} /${name}`, data: { deleted: found } };
    },
  },
  {
    path: ["commands", "clear"],
    summary: "Delete all slash commands (global, or one server's with --guild)",
    options: { guild: GUILD },
    mutating: true,
    destructive: true,
    async run(ctx, _a, o) {
      await ctx.send("PUT", await commandsPath(ctx, str(o.guild)), []);
      return { text: ctx.dryRun ? "Would delete every command" : "Deleted every command", data: { cleared: true } };
    },
  },
  {
    path: ["emojis"],
    summary: "List the app's own emojis (up to 2,000, usable only by the app)",
    async run(ctx) {
      const list = await ctx.api.request<{ items: { id: string; name: string; animated?: boolean }[] }>("GET", `/applications/${await ctx.appId()}/emojis`);
      return {
        text: list.items.map((e) => `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`).join("\n") || "(none)",
        data: list.items,
      };
    },
  },
  {
    path: ["emojis", "upload"],
    summary: "Upload an app emoji (PNG, JPEG, GIF or WebP, 256 KiB at most; 128x128 recommended)",
    args: [
      { name: "name", description: "2-32 letters, digits or _" },
      { name: "file", description: "The image file" },
    ],
    mutating: true,
    async run(ctx, args) {
      const [name, file] = args;
      if (!name || !file) throw new UsageError("Usage: stagedoor emojis upload <name> <file>");
      if (!/^\w{2,32}$/.test(name)) throw new UsageError("Emoji names are 2-32 letters, digits or _");
      const imageData = await imageDataUri(file, { maxBytes: 256 * 1024, allowed: ["image/png", "image/jpeg", "image/gif", "image/webp"] });
      const e = await ctx.send<{ id: string; name: string; animated?: boolean }>("POST", `/applications/${await ctx.appId()}/emojis`, { name, image: imageData });
      return e ? { text: `Uploaded <${e.animated ? "a" : ""}:${e.name}:${e.id}>`, data: e } : { text: `Would upload :${name}:`, data: { name } };
    },
  },
  {
    path: ["emojis", "rename"],
    summary: "Rename an app emoji",
    args: [
      { name: "name", description: "Its current name" },
      { name: "new-name", description: "The new name" },
    ],
    mutating: true,
    async run(ctx, args) {
      const [name, newName] = args;
      if (!name || !newName) throw new UsageError("Usage: stagedoor emojis rename <name> <new-name>");
      const found = await findEmoji(ctx, name);
      const e = await ctx.send<{ id: string; name: string }>("PATCH", `/applications/${await ctx.appId()}/emojis/${found.id}`, { name: newName });
      return { text: e ? `Renamed to :${e.name}:` : `Would rename :${name}: to :${newName}:`, data: e ?? { name: newName } };
    },
  },
  {
    path: ["emojis", "delete"],
    summary: "Delete an app emoji",
    args: [{ name: "name", description: "The emoji's name" }],
    mutating: true,
    destructive: true,
    async run(ctx, args) {
      const found = await findEmoji(ctx, args[0] ?? "");
      await ctx.send("DELETE", `/applications/${await ctx.appId()}/emojis/${found.id}`);
      return { text: `${ctx.dryRun ? "Would delete" : "Deleted"} :${found.name}:`, data: { deleted: found } };
    },
  },
  {
    path: ["invite"],
    summary: "Print the link that adds the bot to a server (or installs it for a user)",
    options: {
      permissions: { type: "string", description: "A number, or names: ViewChannel,SendMessages,EmbedLinks" },
      guild: { type: "string", description: "Preselect this server" },
      "user-install": { type: "boolean", description: "A user-install link (commands only, no bot)" },
    },
    async run(ctx, _a, o) {
      const params = new URLSearchParams({ client_id: await ctx.appId() });
      if (o["user-install"] === true) {
        params.set("integration_type", "1");
        params.set("scope", "applications.commands");
      } else {
        params.set("scope", "bot applications.commands");
        if (str(o.permissions)) params.set("permissions", parsePermissions(str(o.permissions) as string).toString());
        if (str(o.guild)) params.set("guild_id", str(o.guild) as string);
      }
      const url = `https://discord.com/oauth2/authorize?${params.toString().replace(/\+/g, "%20")}`;
      return { text: url, data: { url } };
    },
  },
];
