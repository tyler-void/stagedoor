import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flattenErrors } from "../src/api.ts";
import { parsePermissions } from "../src/commands.ts";
import { findCommand, main, parseArgs } from "../src/cli.ts";
import { FLAGS, intentStates, withIntent } from "../src/flags.ts";
import { sniffImage } from "../src/image.ts";
import { readDotenv } from "../src/token.ts";

const TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.fake.token-value-0000";
const APP_ID = "123456789012345678";

/** A fake Discord: an app, a bot user, commands and emojis in memory; records every request. */
function fakeDiscord(over: { flags?: number; failNext?: { status: number; body: unknown } } = {}) {
  const state = {
    app: { id: APP_ID, name: "daily-drip", description: "", tags: [] as string[], flags: over.flags ?? FLAGS.APPLICATION_COMMAND_BADGE!, bot_public: false, approximate_guild_count: 1 },
    commands: [{ id: "c1", application_id: APP_ID, version: "v", name: "shop", description: "Show today's shop", type: 1 }],
    emojis: [{ id: "e1", name: "vp", animated: false }],
  };
  const requests: { method: string; path: string; body: any; auth: string }[] = [];
  let failNext = over.failNext;
  const fetch = async (url: string, init: RequestInit) => {
    const path = url.replace("https://discord.com/api/v10", "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method: String(init.method), path, body, auth: String((init.headers as Record<string, string>).Authorization) });
    if (failNext) {
      const f = failNext;
      failNext = undefined;
      return Response.json(f.body, { status: f.status, headers: f.status === 429 ? { "retry-after": "0" } : {} });
    }
    const m = `${init.method} ${path}`;
    if (m === "GET /applications/@me") return Response.json(state.app);
    if (m === "PATCH /applications/@me") {
      if (body.flags !== undefined) state.app.flags = (state.app.flags & ~(FLAGS.GATEWAY_PRESENCE_LIMITED! | FLAGS.GATEWAY_GUILD_MEMBERS_LIMITED! | FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED!)) | body.flags;
      Object.assign(state.app, { ...body, flags: state.app.flags });
      return Response.json(state.app);
    }
    if (m === "GET /users/@me") return Response.json({ id: APP_ID, username: "daily-drip", avatar: "abc", banner: null });
    if (m === `GET /applications/${APP_ID}/commands`) return Response.json(state.commands);
    if (m === `PUT /applications/${APP_ID}/commands`) {
      state.commands = body.map((c: any, i: number) => ({ ...c, id: `n${i}`, application_id: APP_ID, version: "v2" }));
      return Response.json(state.commands);
    }
    if (m.startsWith(`DELETE /applications/${APP_ID}/commands/`)) return new Response(null, { status: 204 });
    if (m === `GET /applications/${APP_ID}/emojis`) return Response.json({ items: state.emojis });
    if (m === `POST /applications/${APP_ID}/emojis`) return Response.json({ id: "e2", name: body.name, animated: false });
    if (m.startsWith(`DELETE /applications/${APP_ID}/emojis/`)) return new Response(null, { status: 204 });
    return Response.json({ message: "Unknown route", code: 0 }, { status: 404 });
  };
  return { state, requests, fetch };
}

async function run(argv: string[], d = fakeDiscord(), env: Record<string, string> = { DISCORD_BOT_TOKEN: TOKEN }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), env, fetch: d.fetch });
  return { code, out: out.join("\n"), err: err.join("\n"), d };
}

test("app: shows the app, with intents decoded; the token goes in a Bot header and never in the output", async () => {
  const r = await run(["app"], fakeDiscord({ flags: FLAGS.GATEWAY_PRESENCE_LIMITED! }));
  expect(r.code).toBe(0);
  expect(r.out).toContain("daily-drip (123456789012345678)");
  expect(r.out).toContain("presence on · members off · message-content off");
  expect(r.d.requests[0]?.auth).toBe(`Bot ${TOKEN}`);
  expect(r.out + r.err).not.toContain(TOKEN);
});

test("--json: {ok, data} on success, {ok:false, error} on failure, with Discord's code and field errors", async () => {
  const ok = await run(["intents", "--json"]);
  expect(JSON.parse(ok.out)).toEqual({ ok: true, data: { presence: "off", members: "off", "message-content": "off" } });
  const bad = await run(["app", "set", "--description", "x", "--json"], fakeDiscord({ failNext: { status: 400, body: { code: 50035, message: "Invalid Form Body", errors: { description: { _errors: [{ message: "Too long" }] } } } } }));
  expect(bad.code).toBe(2);
  expect(JSON.parse(bad.out)).toMatchObject({ ok: false, error: { status: 400, code: 50035, details: ["description: Too long"] } });
});

test("intents on/off sends only the settable bits and reports the result", async () => {
  const r = await run(["intents", "on", "presence", "message-content"]);
  expect(r.code).toBe(0);
  const patch = r.d.requests.find((q) => q.method === "PATCH");
  expect(patch?.body).toEqual({ flags: FLAGS.GATEWAY_PRESENCE_LIMITED! | FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED! });
  expect(r.out).toContain("presence: on");
  const off = await run(["intents", "off", "presence"], r.d);
  expect(off.d.requests.at(-1)?.body).toEqual({ flags: FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED! });
  expect((await run(["intents", "on", "typing"])).code).toBe(1);
});

test("--dry-run shows the request and sends nothing that changes anything", async () => {
  const r = await run(["app", "set", "--description", "Daily shop", "--tags", "valorant,shop", "--dry-run"]);
  expect(r.code).toBe(0);
  expect(r.d.requests.every((q) => q.method === "GET")).toBe(true);
  expect(r.out).toContain('[dry run] PATCH /applications/@me {"description":"Daily shop","tags":["valorant","shop"]}');
});

test("destructive commands need --yes (exit 3); --dry-run doesn't", async () => {
  const refused = await run(["commands", "clear", "--json"]);
  expect(refused.code).toBe(3);
  expect(JSON.parse(refused.out).error.needsYes).toBe(true);
  expect(refused.d.requests).toHaveLength(0);
  expect((await run(["commands", "clear", "--dry-run"])).code).toBe(0);
  const done = await run(["commands", "clear", "--yes"]);
  expect(done.d.requests.at(-1)).toMatchObject({ method: "PUT", path: `/applications/${APP_ID}/commands`, body: [] });
});

test("commands export strips Discord's own fields; import writes them back with a bulk overwrite", async () => {
  const exp = await run(["commands", "export", "--json"]);
  expect(JSON.parse(exp.out).data).toEqual([{ name: "shop", description: "Show today's shop", type: 1 }]);
  const dir = await mkdtemp(join(tmpdir(), "stagedoor-"));
  const file = join(dir, "commands.json");
  await writeFile(file, JSON.stringify([{ id: "old", name: "shop", description: "x", type: 1 }, { name: "preview", description: "y", type: 1 }]));
  const imp = await run(["commands", "import", file, "--yes"]);
  expect(imp.code).toBe(0);
  expect(imp.d.requests.at(-1)?.body).toEqual([{ name: "shop", description: "x", type: 1 }, { name: "preview", description: "y", type: 1 }]);
  expect(imp.out).toContain("/shop, /preview");
});

test("commands delete finds the command by name; an unknown one is a usage error", async () => {
  const r = await run(["commands", "delete", "/shop", "--yes"]);
  expect(r.d.requests.at(-1)).toMatchObject({ method: "DELETE", path: `/applications/${APP_ID}/commands/c1` });
  expect((await run(["commands", "delete", "nope", "--yes"])).code).toBe(1);
});

test("emojis: list, upload with the size limit, delete by name", async () => {
  expect((await run(["emojis"])).out).toBe("<:vp:e1>");
  const dir = await mkdtemp(join(tmpdir(), "stagedoor-"));
  const png = join(dir, "vp.png");
  await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  const up = await run(["emojis", "upload", "vp2", png]);
  expect(up.d.requests.at(-1)?.body).toMatchObject({ name: "vp2", image: expect.stringMatching(/^data:image\/png;base64,/) });
  const big = join(dir, "big.png");
  await writeFile(big, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300 * 1024)]));
  const tooBig = await run(["emojis", "upload", "big", big]);
  expect(tooBig.code).toBe(2);
  expect(tooBig.err).toContain("limit is 256 KiB");
  const del = await run(["emojis", "delete", "vp", "--yes"]);
  expect(del.d.requests.at(-1)).toMatchObject({ method: "DELETE", path: `/applications/${APP_ID}/emojis/e1` });
});

test("invite builds the authorize link with permissions by name or number, or a user-install link", async () => {
  expect((await run(["invite", "--permissions", "ViewChannel,SendMessages,EmbedLinks", "--guild", "999"])).out).toBe(
    `https://discord.com/oauth2/authorize?client_id=${APP_ID}&scope=bot%20applications.commands&permissions=19456&guild_id=999`,
  );
  expect((await run(["invite", "--user-install"])).out).toBe(`https://discord.com/oauth2/authorize?client_id=${APP_ID}&integration_type=1&scope=applications.commands`);
  expect(parsePermissions("8")).toBe(8n);
  expect(parsePermissions("SendMessagesInThreads")).toBe(1n << 38n);
});

test("usage errors: unknown command or option, missing token (exit 1)", async () => {
  expect((await run(["frobnicate"])).code).toBe(1);
  const opt = await run(["app", "--colour", "red"]);
  expect(opt.code).toBe(1);
  expect(opt.err).toContain("--colour");
  const noToken = await run(["app"], fakeDiscord(), {});
  expect(noToken.code).toBe(1);
  expect(noToken.err).toContain("DISCORD_BOT_TOKEN");
});

test("the token can come from an env file; a rate limit is waited out and retried", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stagedoor-"));
  const env = join(dir, ".env");
  await writeFile(env, `# bot\nDISCORD_TOKEN="${TOKEN}"\n`);
  const r = await run(["bot", "--env-file", env], fakeDiscord({ failNext: { status: 429, body: { retry_after: 0, message: "slow down" } } }), {});
  expect(r.code).toBe(0);
  expect(r.d.requests).toHaveLength(2);
  expect(r.d.requests[1]?.auth).toBe(`Bot ${TOKEN}`);
});

test("describe lists every command with its options, for agents; help works per command", async () => {
  const d = JSON.parse((await run(["describe"])).out);
  expect(d.commands.map((c: any) => c.command)).toContain("intents on");
  expect(d.commands.find((c: any) => c.command === "commands clear")).toMatchObject({ mutating: true, destructive: true });
  expect(d.exitCodes[3]).toContain("--yes");
  expect((await run(["help", "app", "set"])).out).toContain("--tags <value>");
});

test("helpers: args, command lookup, flags, images, dotenv, nested errors", () => {
  expect(parseArgs(["app", "set", "--description=a b", "--json", "--tags", "x,y"], new Set(["json"]))).toEqual({ words: ["app", "set"], options: { description: "a b", json: true, tags: "x,y" } });
  expect(findCommand(["intents", "on", "presence"])?.args).toEqual(["presence"]);
  expect(findCommand(["intents"])?.command.path).toEqual(["intents"]);
  expect(intentStates(FLAGS.GATEWAY_MESSAGE_CONTENT!)).toMatchObject({ "message-content": "on (verified app)" });
  expect(withIntent(FLAGS.APPLICATION_COMMAND_BADGE! | FLAGS.GATEWAY_PRESENCE_LIMITED!, "members", true)).toBe(FLAGS.GATEWAY_PRESENCE_LIMITED! | FLAGS.GATEWAY_GUILD_MEMBERS_LIMITED!);
  expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  expect(sniffImage(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  expect(readDotenv("export A=1\nB='two'\n# C=3\n")).toEqual({ A: "1", B: "two" });
  expect(flattenErrors({ tags: { "0": { _errors: [{ message: "Too long" }] } } })).toEqual(["tags.0: Too long"]);
});
