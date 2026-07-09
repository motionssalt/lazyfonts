# LazyFonts 🦥🔤

A Telegram bot that pulls font files out of ZIP archives so you don't have to.

Send it one or more `.zip` files, it recursively scans each one (including ZIPs nested inside ZIPs, up to 10 levels deep), pulls out every `.ttf`, `.otf`, `.woff`, `.woff2`, `.eot`, and `.svg` it finds, and sends you back a single clean flat ZIP with all folder nesting stripped out. It also picks a smart output filename by detecting the common font family across everything it grabbed (e.g. `Roboto-Fonts.zip`).

This is a Cloudflare Worker port of the [Font Extractor Pro](https://github.com/) web tool — same extraction algorithm, same naming heuristics, same dedup logic, just wrapped in a bot instead of a web page.

## Features

- **Recursive scan** of ZIPs nested inside ZIPs, up to 10 levels deep.
- **Six font formats supported:** `.ttf`, `.otf`, `.woff`, `.woff2`, `.eot`, `.svg`.
- **Flat repackaging** — no folder nesting in the output ZIP.
- **Smart output naming** — detects font family across all collected files and picks names like `Roboto-Fonts.zip`. Falls back to the source ZIP name, then a timestamp.
- **Filename dedup** — collisions get `-1`, `-2` … suffixes, applied globally across the whole session.
- **Multi-ZIP sessions** — send as many ZIPs as you like in one go, LazyFonts merges them all into one output.
- **Inline "Finish & Download" button** on every status reply, so you never have to type `/done`.
- **Runs entirely on Cloudflare's edge** — one Worker, one KV namespace, no other infrastructure.

## Commands

| Command | What it does |
|---|---|
| `/start` / `/help` | Show the welcome & usage message |
| *(send a `.zip`)* | Extract fonts and add them to the current session |
| `/done` | Merge everything collected so far and send the result back |
| `/cancel` | Discard the current session |

Every per-file status reply also carries **✅ Finish & Download** and **❌ Cancel** inline buttons.

## Limits (and why they exist)

- **Each ZIP must be under 20 MB.** This is Telegram's hard limit for files bots can download — LazyFonts can't work around it. Files over 20 MB are skipped with a message, but the rest of your session keeps going.
- **~18 MB total extracted fonts per session.** This is LazyFonts' own limit, chosen so the accumulated session fits in Cloudflare Workers KV (25 MB per value ceiling) even after base64 encoding overhead. Once you hit it, LazyFonts tells you to `/done` and start fresh.
- **10 levels of nested-ZIP depth**, matching the original web tool. Anything deeper is silently ignored.
- The output ZIP itself has no such limit — Telegram lets bots *send* documents up to 2 GB.

## File layout

```
lazyfonts/
├── src/
│   ├── index.js        # Worker entry: webhook, commands, KV sessions, TG API
│   └── extractor.js    # Pure ZIP extraction / dedup / naming logic
├── wrangler.toml       # Worker config (Git-integrated deploy reads this)
├── package.json        # Just jszip as a dependency
├── .gitignore
├── README.md           # This file
└── setup.md            # Step-by-step deployment guide
```

The extractor is split into its own module because it's the interesting part — everything font-related lives in one testable, dependency-light file.

## Why Workers KV instead of D1?

Sessions are ephemeral per-chat key/value state: read-modify-write on every incoming ZIP, then deleted on `/done` or after 24h TTL. That's exactly what KV is for. D1 would just add schema, migrations, and SQL for zero benefit — no queries across sessions, no relations, no analytics needs.

## Deploying

See **[setup.md](./setup.md)** for the full step-by-step guide (Termux-friendly, no Wrangler CLI required — everything goes through the Cloudflare dashboard).

The one-line version:
1. Create the bot with [@BotFather](https://t.me/BotFather), copy the token.
2. Push this repo to GitHub.
3. Cloudflare dashboard → Workers & Pages → Create → Connect to Git → pick this repo.
4. In the Worker's settings, create a KV binding named `LAZYFONTS_KV` and a secret `TELEGRAM_BOT_TOKEN`.
5. Register the webhook with a single `curl` call (see setup.md).

## Testing

Once deployed:

1. Open your bot in Telegram, send `/start` — you should see the welcome message.
2. Send any small `.zip` containing at least one font file. You should get a status reply naming how many fonts were found, with the inline buttons attached.
3. Send another ZIP (optional) — status reply should now show the accumulated running total.
4. Tap **Finish & Download** (or send `/done`) — you should receive the merged ZIP within a few seconds. Filename should reflect the detected family, e.g. `Roboto-Fonts.zip`.
5. Try a `.txt` file — bot should politely reject it.
6. Try a ZIP over 20 MB (or a fake `.zip` that's oversized) — bot should skip it with a clear message and keep the session intact.
7. Try a corrupted ZIP — same story: clean error, session intact.

## Security notes

- The Worker supports an optional `TELEGRAM_WEBHOOK_SECRET` env var. If set, requests without a matching `X-Telegram-Bot-Api-Secret-Token` header are rejected with 403 — this prevents anyone who guesses your Worker's URL from injecting fake updates.
- Font bytes live in KV only until `/done` or the 24-hour TTL expires; nothing is written to durable storage beyond that.
- No user IDs, chat contents, or file contents are logged beyond routine Cloudflare access logs.

## License

MIT.
