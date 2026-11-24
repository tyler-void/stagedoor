# stagedoor

The Discord Developer Portal from the terminal. The portal is the front of house; this is the side entrance, for developers and for AI agents that would rather not click through a web page to flip an intent, change an icon or clear stale slash commands.

It works with your application's **bot token**, through Discord's documented API, so it can do what that token is allowed to do:

| | |
| --- | --- |
| `stagedoor app` · `app set` | Show the app; change its description, tags, icon, cover image, interactions endpoint and install URLs |
| `stagedoor intents` · `intents on/off` | The privileged intents (presence, members, message-content), like the switches on the portal's Bot page |
| `stagedoor bot` · `bot set` | The bot user: username, avatar, banner |
| `stagedoor commands` · `export` · `import` · `delete` · `clear` | Slash commands, global or per server (`--guild`) |
| `stagedoor emojis` · `upload` · `rename` · `delete` | The app's own emojis (up to 2,000) |
| `stagedoor guilds` | The servers the bot is in |
| `stagedoor invite` | The link that adds the bot to a server, or installs it for a user |

It **can't** create an application or rename one: Discord has no API for either, and creating apps needs your own login, which only the portal may use. The intent switches only exist for apps in under 100 servers; bigger apps need Discord's verification.

## Use

```sh
bun install
export DISCORD_BOT_TOKEN=...          # Developer Portal -> your app -> Bot -> Reset Token
bun src/cli.ts app
bun src/cli.ts intents on presence
bun src/cli.ts app set --description "Posts your daily shop" --tags valorant,shop --icon icon.png
bun src/cli.ts commands --guild 123456789012345678
bun src/cli.ts invite --permissions ViewChannel,SendMessages,EmbedLinks
```

The token can also come from a `.env` file (`--env-file .env`, reading `DISCORD_BOT_TOKEN` or `DISCORD_TOKEN`) or a file of its own (`--token-file path`). It's never printed, and `--verbose` shows each request's method and path, not its headers.

Every change can be previewed: `--dry-run` prints the request instead of sending it. Commands that delete or overwrite (`commands import`, `delete`, `clear`, `emojis delete`) refuse to run without `--yes`.

## For AI agents

- `stagedoor describe` prints every command with its arguments, options, and whether it changes or deletes anything, as JSON.
- `--json` makes every answer `{"ok": true, "data": ...}`, or `{"ok": false, "error": {"message", "status", "code", "details"}}` with Discord's own error code and field errors.
- Exit codes: `0` done, `1` usage error, `2` Discord refused or failed, `3` destructive and needs `--yes`.
- Run a change with `--dry-run` first, show the person the request, then run it for real.

## Development

`bun test` runs the CLI end to end against a fake Discord; `bun run typecheck`. No runtime dependencies.

## License

[MIT](./LICENSE)
