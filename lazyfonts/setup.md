# LazyFonts — Setup Guide

This guide walks you through deploying LazyFonts end-to-end, assuming:

- You're on a **rooted Android phone using Termux** (or any other environment where you *can't* run the Wrangler CLI locally).
- You have a **Cloudflare account** (free tier is fine).
- You have a **GitHub account** (or another Git host Cloudflare supports).
- You have **`curl`** available (Termux has it by default; `pkg install curl` if not).

No Wrangler CLI is required at any point. Everything happens through the Cloudflare dashboard, GitHub, and one `curl` call at the end.

---

## Step 1 — Create the Telegram bot

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Give it a display name (e.g. `LazyFonts`) and a username ending in `bot` (e.g. `LazyFontsBot`, or `MyLazyFontsBot` if that's taken).
4. BotFather replies with an **HTTP API token** that looks like `1234567890:AAH...`. **Copy it and keep it secret** — anyone with this token controls your bot.

Optional polish (all via BotFather):

- `/setdescription` — set the "What can this bot do?" text.
- `/setuserpic` — give it an avatar.
- `/setcommands` — paste this so Telegram shows a nice command menu:

  ```
  start - Show the welcome & usage message
  help - Show the welcome & usage message
  done - Merge collected fonts and send the ZIP
  cancel - Discard the current session
  ```

---

## Step 2 — Push this project to GitHub

From Termux (or wherever you have this project):

```bash
cd lazyfonts
git init
git add .
git commit -m "Initial LazyFonts commit"

# Create an empty repo at https://github.com/new (do NOT initialize it with a README)
# then:
git remote add origin https://github.com/YOUR_USERNAME/lazyfonts.git
git branch -M main
git push -u origin main
```

If you'd rather use GitLab or Bitbucket, that's fine — Cloudflare supports all of them.

---

## Step 3 — Create a KV namespace

LazyFonts stores per-chat session state (accumulated font bytes between messages) in Cloudflare Workers KV.

1. Cloudflare dashboard → **Workers & Pages** → **KV** (left sidebar).
2. Click **Create a namespace**.
3. Name it `lazyfonts-sessions` (any name works, but this one matches the docs).
4. Click **Add**.

You don't need to copy the ID right now — you'll bind it to the Worker in Step 5 through the dashboard UI.

---

## Step 4 — Create the Worker from your Git repo

1. Cloudflare dashboard → **Workers & Pages** → **Create application** → **Pages / Workers** tab → **Create Worker** via **"Connect to Git"** (the exact button label shifts occasionally; look for "Import a repository" or "Connect to Git").
2. Authorize Cloudflare to access your GitHub account if it hasn't been done already.
3. Pick the `lazyfonts` repo.
4. On the build config screen:
   - **Project name:** `lazyfonts` (this becomes part of your Worker's URL: `lazyfonts.<your-subdomain>.workers.dev`).
   - **Production branch:** `main`.
   - **Build command:** *(leave blank — no build step needed, JSZip resolves at deploy time)*.
   - **Deploy command:** *leave the default* (`npx wrangler deploy` — Cloudflare runs this **in its own build environment**, not on your phone. This is why you don't need Wrangler CLI locally).
   - **Root directory:** *leave blank* (project is at repo root).
5. Click **Save and Deploy**.

The first deploy will run. It may fail on the very first attempt because the KV binding hasn't been added yet — that's fine, we'll fix it in the next step and redeploy.

---

## Step 5 — Bind the KV namespace and set secrets

1. Once the Worker exists, open it: **Workers & Pages** → click `lazyfonts`.
2. Go to **Settings** → **Variables and Bindings** (formerly "Settings → Variables").

### 5a. KV binding

- Scroll to **KV Namespace Bindings** → **Add binding**.
- **Variable name:** `LAZYFONTS_KV` (case-sensitive — the code looks for exactly this).
- **KV namespace:** pick `lazyfonts-sessions` from the dropdown.
- Click **Save and deploy** (or **Deploy**).

### 5b. Bot token secret

- Scroll to **Secrets** (or **Environment Variables** and toggle "Encrypt") → **Add**.
- **Variable name:** `TELEGRAM_BOT_TOKEN`.
- **Value:** paste the token from BotFather (Step 1).
- Save.

### 5c. (Optional but recommended) Webhook secret

- Same section, **Add** another secret.
- **Variable name:** `TELEGRAM_WEBHOOK_SECRET`.
- **Value:** any random string, e.g. output of `openssl rand -hex 32` in Termux, or just mash your keyboard for 32+ characters.
- Save. Keep this value — you'll need it in Step 6.

Trigger a redeploy (**Deployments** tab → **Retry deployment** on the latest one, or push any commit to `main`). After it finishes, your Worker's URL is visible on the Worker's overview page — it'll look like:

```
https://lazyfonts.<your-subdomain>.workers.dev
```

Copy that URL. Confirm the Worker is alive with:

```bash
curl https://lazyfonts.<your-subdomain>.workers.dev
# → LazyFonts webhook is live. POST-only.
```

---

## Step 6 — Register the webhook with Telegram

This is the only step that requires a terminal, and it's a single `curl` call. From Termux:

```bash
BOT_TOKEN="paste-your-bot-token-here"
WORKER_URL="https://lazyfonts.<your-subdomain>.workers.dev"

# If you set TELEGRAM_WEBHOOK_SECRET in step 5c, include it here.
# If you skipped 5c, remove the secret_token line entirely.
WEBHOOK_SECRET="paste-your-webhook-secret-here"

curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${WORKER_URL}\",
    \"secret_token\": \"${WEBHOOK_SECRET}\",
    \"allowed_updates\": [\"message\", \"edited_message\", \"callback_query\"]
  }"
```

Expected response:

```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

Sanity-check it stuck:

```bash
curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

You want to see your Worker's URL in the `url` field and `"pending_update_count": 0`.

---

## Step 7 — Test it

1. Open your bot in Telegram (search its username, or use the direct link BotFather gave you).
2. Send `/start` → you should get the welcome message.
3. Send any small `.zip` file with at least one font inside → status reply with font count and inline buttons.
4. Tap **✅ Finish & Download** → you should receive the merged ZIP within a few seconds.

If nothing happens:

- Check **Workers & Pages → lazyfonts → Logs** (the "Real-time logs" tab). Any errors will show up there in plain text.
- Confirm the KV binding variable name is exactly `LAZYFONTS_KV`.
- Confirm the secret name is exactly `TELEGRAM_BOT_TOKEN`.
- Re-run `getWebhookInfo` — if `last_error_message` is populated, the message text tells you what Telegram sees.

---

## Updating the bot later

Because the Worker is Git-integrated, any push to `main` triggers a redeploy automatically. Edit `src/index.js` or `src/extractor.js` locally, commit, push, done — Cloudflare rebuilds in about 30 seconds.

To roll back: **Workers & Pages → lazyfonts → Deployments** → pick an older deploy → **Rollback**.

---

## Removing the bot

1. `curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook"` — unhook Telegram.
2. Cloudflare dashboard → delete the Worker and the KV namespace.
3. BotFather → `/deletebot` → pick your bot.

---

## Troubleshooting

**"Not a valid ZIP: …"** — the ZIP is corrupted or password-protected. LazyFonts can't handle encrypted ZIPs (JSZip doesn't support them).

**"Telegram refused to provide a download path…"** — the file is over Telegram's 20 MB bot-download limit. Nothing LazyFonts can do — this is a platform rule.

**"Session is full…"** — you've accumulated ~18 MB of fonts across the session. Send `/done` to get what you have, then start a new session.

**The bot doesn't reply at all** — 90% of the time this is the webhook not being registered, or `TELEGRAM_BOT_TOKEN` being wrong/missing. Run `getWebhookInfo` and check the Worker's real-time logs.

**Logs show "TypeError: … not a function"** — usually means the `nodejs_compat` flag isn't set. Confirm `wrangler.toml` still has `compatibility_flags = ["nodejs_compat"]`, or add it via dashboard: **Settings → Variables and Bindings → Compatibility Flags → Add** → `nodejs_compat`.
