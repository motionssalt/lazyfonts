// index.js — LazyFonts Telegram bot, Cloudflare Worker entry point.
//
// Responsibilities:
//   • Receive Telegram webhook POSTs from Cloudflare's edge.
//   • Route commands: /start, /help, /done, /cancel.
//   • Handle uploaded .zip documents: download from Telegram, extract fonts,
//     accumulate them into a per-chat "session" stored in Workers KV.
//   • On /done (or the "Finish & Download" inline button), merge every font
//     collected across the whole session into a single ZIP, dedupe filenames
//     globally, pick a smart output name, and send it back via sendDocument.
//
// Design notes:
//   • Sessions live in KV under key `session:<chat_id>`. Value is a JSON
//     document with base64-encoded font bytes. Base64 is used because KV
//     values are strings; the ~33% size overhead is factored into the
//     session-size ceiling below.
//   • Why KV and not D1: sessions are tiny, ephemeral, per-chat key/value
//     state. KV is simpler, has no schema, and matches this workload.
//   • Every handler that does non-trivial work is wrapped in try/catch so
//     one user's bad input can never 500 the Worker for anyone else.
//   • Telegram itself imposes a 20MB inbound limit for files bots can
//     download via getFile — we check `file_size` before attempting the
//     download. Outbound (sendDocument) tops out around 50MB for bots by
//     default; a merged font ZIP is very unlikely to hit that.

import JSZip from "jszip";
import {
  extractFontsFromZip,
  dedupeFilenames,
  buildOutputZip,
  pickOutputName,
} from "./extractor.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Telegram's hard cap on files bots can download via getFile.
const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

// Ceiling on total *extracted font bytes* we'll keep in a single session.
// Rationale: KV values max out at 25 MB. After base64 encoding (+~33%) and
// JSON overhead we want to stay comfortably under that, and we still need
// room to re-zip and hold everything in Worker memory (128 MB limit).
// 20 MB of raw font bytes → ~27 MB base64 → tight but workable; we cap at
// 18 MB raw to leave headroom.
const SESSION_MAX_BYTES = 18 * 1024 * 1024; // 18 MB accumulated raw fonts

// Session TTL — KV auto-expires stale sessions so we don't leak state
// forever if a user starts a session and never sends /done or /cancel.
const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24 hours

const TG_API = (token, method) =>
  `https://api.telegram.org/bot${token}/${method}`;
const TG_FILE = (token, path) =>
  `https://api.telegram.org/file/bot${token}/${path}`;

// -----------------------------------------------------------------------------
// Channel-follow gate — @motionsalt subscription check
// -----------------------------------------------------------------------------
//
// Every incoming update is routed through checkMembership() first; only
// users whose status in @motionsalt is `member`, `administrator`, or
// `creator` are allowed through to the normal handlers. Anything else
// (including `left`, `kicked`, or ANY error response from Telegram) is
// treated as "not a member" — fail closed, never fail open.
//
// IMPORTANT: getChatMember requires the bot to be an *admin* in the
// target chat. This bot has already been made an admin of @motionsalt.
// If it is ever removed as admin (or demoted), this call will silently
// start returning errors and the gate will lock EVERYONE out — the bot
// must remain an admin of @motionsalt for this feature to work.
//
// Verified users are cached in LAZYFONTS_KV under `membership:<user_id>`
// with a 1-hour TTL, so repeat messages from an already-verified user
// don't hammer the Telegram API but the check still re-validates
// periodically in case the user leaves the channel later.

const CHANNEL_URL = "https://t.me/motionsalt";
const CHANNEL_USERNAME = "@motionsalt";
const MEMBERSHIP_CACHE_TTL = 60 * 60; // 1 hour

async function isChannelMember(env, userId) {
  try {
    const url =
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChatMember` +
      `?chat_id=${encodeURIComponent(CHANNEL_USERNAME)}&user_id=${userId}`;
    const res = await fetch(url);
    if (!res.ok) return false;
    const json = await res.json();
    if (!json.ok || !json.result) return false;
    const status = json.result.status;
    return (
      status === "member" ||
      status === "administrator" ||
      status === "creator"
    );
  } catch {
    return false;
  }
}

async function checkMembership(env, userId) {
  if (!userId) return false;
  const key = `membership:${userId}`;
  // Cache is best-effort — if KV read fails for any reason, do a live check
  // rather than crashing the gate.
  try {
    const cached = await env.LAZYFONTS_KV.get(key);
    if (cached === "verified") return true;
  } catch {
    /* treat as cache miss */
  }
  const ok = await isChannelMember(env, userId);
  if (ok) {
    try {
      await env.LAZYFONTS_KV.put(key, "verified", {
        expirationTtl: MEMBERSHIP_CACHE_TTL,
      });
    } catch {
      /* cache write failure is non-fatal */
    }
  }
  return ok;
}

async function sendGateMessage(env, chatId) {
  return sendMessage(
    env,
    chatId,
    "🔒 *Join @motionsalt first* to use this bot.\n\nOnce you've joined, tap the button below to continue.",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📢 Join @motionsalt", url: CHANNEL_URL }],
          [
            {
              text: "✅ I've Joined — Check Again",
              callback_data: "check_membership",
            },
          ],
        ],
      },
    }
  );
}

function extractUserId(update) {
  if (update.callback_query?.from?.id) return update.callback_query.from.id;
  if (update.message?.from?.id) return update.message.from.id;
  if (update.edited_message?.from?.id) return update.edited_message.from.id;
  return null;
}

function extractChatId(update) {
  if (update.callback_query?.message?.chat?.id)
    return update.callback_query.message.chat.id;
  if (update.message?.chat?.id) return update.message.chat.id;
  if (update.edited_message?.chat?.id) return update.edited_message.chat.id;
  return null;
}

// -----------------------------------------------------------------------------
// Base64 helpers — KV stores strings, font bytes are binary.
// -----------------------------------------------------------------------------

function u8ToBase64(bytes) {
  // Chunked to avoid "Maximum call stack size exceeded" on large arrays.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk)
    );
  }
  return btoa(binary);
}

function base64ToU8(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// -----------------------------------------------------------------------------
// Session storage (Workers KV)
// -----------------------------------------------------------------------------
//
// Session shape:
// {
//   fonts: [{ name: string, data: base64 string }],
//   totalBytes: number,           // running total of raw font bytes
//   sourceNames: string[],        // original ZIP filenames (for fallback naming)
//   updatedAt: number             // epoch ms
// }

const sessionKey = (chatId) => `session:${chatId}`;

async function loadSession(env, chatId) {
  const raw = await env.LAZYFONTS_KV.get(sessionKey(chatId));
  if (!raw) return { fonts: [], totalBytes: 0, sourceNames: [], updatedAt: 0 };
  try {
    return JSON.parse(raw);
  } catch {
    // Corrupted KV entry — start fresh rather than throwing.
    return { fonts: [], totalBytes: 0, sourceNames: [], updatedAt: 0 };
  }
}

async function saveSession(env, chatId, session) {
  session.updatedAt = Date.now();
  await env.LAZYFONTS_KV.put(
    sessionKey(chatId),
    JSON.stringify(session),
    { expirationTtl: SESSION_TTL_SECONDS }
  );
}

async function clearSession(env, chatId) {
  await env.LAZYFONTS_KV.delete(sessionKey(chatId));
}

// -----------------------------------------------------------------------------
// Telegram API helpers
// -----------------------------------------------------------------------------

async function tgCall(env, method, payload) {
  const res = await fetch(TG_API(env.TELEGRAM_BOT_TOKEN, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`Telegram ${method} failed: ${res.status} ${text}`);
  }
  return res;
}

async function sendMessage(env, chatId, text, extra = {}) {
  return tgCall(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    ...extra,
  });
}

// Inline keyboard attached to per-file status replies so users can finish
// with a tap instead of typing /done.
const FINISH_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "✅ Finish & Download", callback_data: "done" },
      { text: "❌ Cancel", callback_data: "cancel" },
    ],
  ],
};

async function answerCallback(env, callbackId, text) {
  return tgCall(env, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text: text || "",
  });
}

async function sendDocument(env, chatId, filename, bytes, caption) {
  // multipart/form-data upload — the Workers runtime supports FormData + Blob.
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append(
    "document",
    new Blob([bytes], { type: "application/zip" }),
    filename
  );
  const res = await fetch(
    TG_API(env.TELEGRAM_BOT_TOKEN, "sendDocument"),
    { method: "POST", body: form }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`sendDocument failed: ${res.status} ${text}`);
  }
  return res;
}

async function getFilePath(env, fileId) {
  const res = await fetch(TG_API(env.TELEGRAM_BOT_TOKEN, "getFile"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!res.ok) throw new Error(`getFile HTTP ${res.status}`);
  const json = await res.json();
  if (!json.ok || !json.result || !json.result.file_path) {
    // Telegram omits file_path for files it refuses to serve (usually >20MB).
    throw new Error("Telegram refused to provide a download path for this file (likely over the 20MB bot limit).");
  }
  return json.result.file_path;
}

async function downloadFile(env, filePath) {
  const res = await fetch(TG_FILE(env.TELEGRAM_BOT_TOKEN, filePath));
  if (!res.ok) throw new Error(`File download HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// -----------------------------------------------------------------------------
// Message text templates
// -----------------------------------------------------------------------------

const HELP_TEXT = `👋 *LazyFonts* extracts font files from ZIP archives — including fonts buried inside nested ZIPs — and gives you back one clean, flat ZIP.

*How to use:*
1. Send me one or more \`.zip\` files.
2. I'll scan each one (recursively, up to 10 levels deep) and collect every \`.ttf\`, \`.otf\`, \`.woff\`, \`.woff2\`, \`.eot\`, and \`.svg\` font inside.
3. When you're done, send /done (or tap *Finish & Download*) and I'll send back a single merged ZIP with a smart filename.
4. Send /cancel to throw away the current session.

*Limits (Telegram's, not mine):*
• Each ZIP must be *under 20 MB* — Telegram won't let bots download anything larger.
• Total extracted fonts per session are capped at *~18 MB* so the merged output stays deliverable.
• You can send as many ZIPs as you like within those limits and I'll merge everything at the end.

Send a ZIP whenever you're ready. 📦`;

// -----------------------------------------------------------------------------
// Core flows
// -----------------------------------------------------------------------------

async function handleStart(env, chatId) {
  await sendMessage(env, chatId, HELP_TEXT);
}

async function handleCancel(env, chatId) {
  await clearSession(env, chatId);
  await sendMessage(
    env,
    chatId,
    "🗑️ Session cleared. Send a new ZIP whenever you're ready."
  );
}

async function handleDone(env, chatId) {
  const session = await loadSession(env, chatId);
  if (!session.fonts.length) {
    await sendMessage(
      env,
      chatId,
      "🤔 You haven't sent me any ZIPs yet — nothing to package. Send a `.zip` file to get started."
    );
    return;
  }

  await sendMessage(
    env,
    chatId,
    `⏳ Packaging *${session.fonts.length}* font${session.fonts.length === 1 ? "" : "s"}…`
  );

  try {
    // Decode all font bytes back from base64.
    const fonts = session.fonts.map((f) => ({
      name: f.name,
      data: base64ToU8(f.data),
    }));

    // Global dedup — same rule as the original app but applied across every
    // file in the whole session, not per-file.
    dedupeFilenames(fonts);

    // Fallback name for pickOutputName: if the family heuristic fails and
    // the user only sent one source ZIP, use its name; otherwise leave it
    // blank so we fall through to the timestamp default.
    const fallback =
      session.sourceNames.length === 1 ? session.sourceNames[0] : "";

    const outputName = pickOutputName(fonts, fallback);
    const zipBytes = await buildOutputZip(fonts);

    await sendDocument(
      env,
      chatId,
      outputName,
      zipBytes,
      `✅ ${fonts.length} font${fonts.length === 1 ? "" : "s"} from ${session.sourceNames.length} ZIP${session.sourceNames.length === 1 ? "" : "s"}.`
    );

    await clearSession(env, chatId);
  } catch (err) {
    console.error("Packaging failed:", err);
    await sendMessage(
      env,
      chatId,
      `❌ Something went wrong while packaging your fonts: \`${err.message}\`\n\nYour session is still intact — try /done again, or /cancel to start over.`
    );
  }
}

/**
 * Handle a single incoming document (ZIP). Downloads, extracts, appends to
 * the KV session. Returns nothing — errors are reported inline to the user.
 */
async function handleZipDocument(env, chatId, doc) {
  const filename = doc.file_name || "upload.zip";

  // Reject non-ZIPs cheaply — accept either the mime hint or the extension.
  const looksLikeZip =
    filename.toLowerCase().endsWith(".zip") ||
    doc.mime_type === "application/zip" ||
    doc.mime_type === "application/x-zip-compressed";
  if (!looksLikeZip) {
    await sendMessage(
      env,
      chatId,
      `⚠️ \`${filename}\` isn't a ZIP file. I only accept \`.zip\` archives — please send one of those.`
    );
    return;
  }

  // Per-file 20MB Telegram cap — check BEFORE attempting getFile so we can
  // give a clean, specific error instead of a cryptic HTTP failure.
  if (doc.file_size && doc.file_size > TELEGRAM_MAX_DOWNLOAD_BYTES) {
    await sendMessage(
      env,
      chatId,
      `⚠️ \`${filename}\` is *${(doc.file_size / (1024 * 1024)).toFixed(1)} MB* — over Telegram's 20 MB bot-download limit. Skipped.\n\nSend a smaller ZIP, or split it up and try again. This is a Telegram platform restriction, not a LazyFonts limit.`
    );
    return;
  }

  let fileBytes;
  try {
    const path = await getFilePath(env, doc.file_id);
    fileBytes = await downloadFile(env, path);
  } catch (err) {
    await sendMessage(
      env,
      chatId,
      `⚠️ Couldn't download \`${filename}\`: ${err.message}`
    );
    return;
  }

  // Extract.
  let extracted;
  try {
    extracted = await extractFontsFromZip(fileBytes);
  } catch (err) {
    await sendMessage(
      env,
      chatId,
      `❌ \`${filename}\` couldn't be opened — it may be corrupted or not a real ZIP. (${err.message})\n\nOther ZIPs in this session are still safe. Send another one, or /done to finish.`
    );
    return;
  }

  if (extracted.warnings.length) {
    // Server-side only — don't spam the user.
    console.warn(`Warnings for ${filename}:`, extracted.warnings);
  }

  if (!extracted.fonts.length) {
    await sendMessage(
      env,
      chatId,
      `ℹ️ No fonts found in \`${filename}\` (scanned recursively). Session unchanged.`,
      { reply_markup: FINISH_KEYBOARD }
    );
    return;
  }

  // Load current session, check size ceiling, append if it fits.
  const session = await loadSession(env, chatId);
  const incomingBytes = extracted.fonts.reduce(
    (sum, f) => sum + f.data.byteLength,
    0
  );

  if (session.totalBytes + incomingBytes > SESSION_MAX_BYTES) {
    const currentMb = (session.totalBytes / (1024 * 1024)).toFixed(1);
    const incomingMb = (incomingBytes / (1024 * 1024)).toFixed(1);
    const capMb = (SESSION_MAX_BYTES / (1024 * 1024)).toFixed(0);
    await sendMessage(
      env,
      chatId,
      `⚠️ Session is full. Currently holding *${currentMb} MB* of fonts; \`${filename}\` would add *${incomingMb} MB* and blow past the *${capMb} MB* per-session limit.\n\nSend /done now to download what you have, or /cancel to start fresh. This limit exists so the final merged ZIP stays deliverable through Telegram.`,
      { reply_markup: FINISH_KEYBOARD }
    );
    return;
  }

  // Append. We base64-encode here (KV values are strings).
  for (const f of extracted.fonts) {
    session.fonts.push({ name: f.name, data: u8ToBase64(f.data) });
  }
  session.totalBytes += incomingBytes;
  session.sourceNames.push(filename);
  await saveSession(env, chatId, session);

  const totalMb = (session.totalBytes / (1024 * 1024)).toFixed(2);
  await sendMessage(
    env,
    chatId,
    `✅ *${filename}* → *${extracted.fonts.length}* font${extracted.fonts.length === 1 ? "" : "s"} added.\n\n📦 Session total: *${session.fonts.length}* font${session.fonts.length === 1 ? "" : "s"} (${totalMb} MB) across *${session.sourceNames.length}* ZIP${session.sourceNames.length === 1 ? "" : "s"}.\n\nSend more ZIPs, or tap *Finish & Download* / send /done when ready.`,
    { reply_markup: FINISH_KEYBOARD }
  );
}

// -----------------------------------------------------------------------------
// Update router
// -----------------------------------------------------------------------------

//
// dispatchUpdate() is the ORIGINAL router — command dispatch, callback
// dispatch, document handling — unchanged. The channel-follow gate below
// (routeUpdate) wraps it in one place instead of being duplicated inside
// every individual handler.
//
async function dispatchUpdate(env, update) {
  // Callback queries (inline button taps).
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message?.chat?.id;
    if (!chatId) return;
    await answerCallback(env, cb.id, "");
    if (cb.data === "done") return handleDone(env, chatId);
    if (cb.data === "cancel") return handleCancel(env, chatId);
    return;
  }

  const msg = update.message || update.edited_message;
  if (!msg) return;
  const chatId = msg.chat.id;

  // Command routing.
  if (msg.text) {
    const text = msg.text.trim();
    // Handle "/start@BotName" style suffixes too.
    const cmd = text.split(/\s+/)[0].split("@")[0].toLowerCase();
    if (cmd === "/start" || cmd === "/help") return handleStart(env, chatId);
    if (cmd === "/done") return handleDone(env, chatId);
    if (cmd === "/cancel") return handleCancel(env, chatId);

    // Plain text that isn't a command → nudge them toward the flow.
    await sendMessage(
      env,
      chatId,
      "📎 Send me a `.zip` file to extract fonts from, or /help for instructions."
    );
    return;
  }

  // Document uploads.
  if (msg.document) {
    await handleZipDocument(env, chatId, msg.document);
    return;
  }

  // Anything else (photos, stickers, etc.) — ignore politely.
  await sendMessage(
    env,
    chatId,
    "🤖 I only understand ZIP file uploads and commands (/start, /done, /cancel). Send /help for details."
  );
}

// -----------------------------------------------------------------------------
// Gated router — channel-follow check runs BEFORE dispatchUpdate.
// -----------------------------------------------------------------------------
//
// This is the new top-level entry the fetch handler calls. It:
//   1. Extracts the acting user_id / chat_id from any update shape.
//   2. Special-cases the `check_membership` callback so tapping
//      "I've Joined" always re-runs the check and either shows /start
//      (on success) or re-shows the gate (on failure).
//   3. For everything else, verifies membership (KV-cached, 1h TTL) and
//      either forwards to dispatchUpdate() or replies with the gate.
//
async function routeUpdate(env, update) {
  const userId = extractUserId(update);
  const chatId = extractChatId(update);
  if (!userId || !chatId) return; // no acting user — drop silently

  // "I've Joined — Check Again" callback — always re-run the check,
  // never fall through to dispatchUpdate() for this one.
  if (update.callback_query?.data === "check_membership") {
    await answerCallback(env, update.callback_query.id, "");
    const nowMember = await checkMembership(env, userId);
    if (nowMember) {
      // Show the normal welcome screen.
      return handleStart(env, chatId);
    }
    return sendGateMessage(env, chatId);
  }

  const isMember = await checkMembership(env, userId);
  if (!isMember) {
    // Clear the Telegram spinner on callback taps even though we're
    // blocking the underlying action.
    if (update.callback_query?.id) {
      await answerCallback(
        env,
        update.callback_query.id,
        "🔒 Join @motionsalt first"
      );
    }
    return sendGateMessage(env, chatId);
  }

  // Gate cleared — hand off to the ORIGINAL router.
  return dispatchUpdate(env, update);
}

// -----------------------------------------------------------------------------
// Worker entrypoint
// -----------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    // Sanity: the Telegram webhook is always POST.
    if (request.method !== "POST") {
      return new Response("LazyFonts webhook is live. POST-only.", {
        status: 200,
      });
    }

    // Optional shared-secret check. If TELEGRAM_WEBHOOK_SECRET is configured
    // in the Worker's env, Telegram sends it in this header on every request.
    // See: https://core.telegram.org/bots/api#setwebhook
    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const got = request.headers.get(
        "x-telegram-bot-api-secret-token"
      );
      if (got !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }

    // Route work in the background so we return 200 to Telegram fast —
    // Telegram retries webhooks that don't respond within a few seconds,
    // and heavy ZIP work can take longer than that.
    ctx.waitUntil(
      routeUpdate(env, update).catch((err) => {
        // Absolute last-resort catch — one user's bad payload must not
        // 500 the Worker for anyone else.
        console.error("Unhandled error in routeUpdate:", err);
      })
    );

    return new Response("ok", { status: 200 });
  },
};
