// extractor.js — Pure ZIP extraction logic, ported from the original
// Font Extractor Pro web app. No Telegram / Worker / KV concerns here.
//
// Public surface:
//   extractFontsFromZip(zipBytes)   → { fonts: [{name, data(Uint8Array)}], warnings: [] }
//   detectFontFamily(filenames)     → "Roboto" | null   (heuristic, unchanged from original)
//   dedupeFilenames(fonts)          → mutates each font's name so all names are unique
//   buildOutputZip(fonts)           → Promise<Uint8Array>   (a flat, no-folder ZIP)
//   pickOutputName(fonts, fallback) → "Roboto-Fonts.zip"  etc.

import JSZip from "jszip";

// File extensions we treat as fonts — same set as the original web tool.
const FONT_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2", ".eot", ".svg"];

// Cap on how deep we'll recurse into nested ZIPs. Matches the original tool.
// Anything deeper is silently ignored (with a warning surfaced to the caller).
const MAX_DEPTH = 10;

function isFontFilename(name) {
  const lower = name.toLowerCase();
  return FONT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isZipFilename(name) {
  return name.toLowerCase().endsWith(".zip");
}

// Strip any folder path — we repackage everything flat.
function basename(path) {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/**
 * Recursively walk a ZIP (loaded via JSZip) and collect every font file found,
 * including fonts inside nested ZIPs up to MAX_DEPTH levels deep.
 *
 * Returns { fonts, warnings }.
 * fonts: Array<{ name: string, data: Uint8Array }>
 * warnings: string[]  (things the caller might want to log; not user-facing)
 */
async function walkZip(zip, depth, warnings) {
  const fonts = [];

  // JSZip's forEach is sync-callback but we need async reads → collect entries first.
  const entries = [];
  zip.forEach((relativePath, entry) => {
    if (!entry.dir) entries.push({ relativePath, entry });
  });

  for (const { relativePath, entry } of entries) {
    const name = basename(relativePath);

    if (isFontFilename(name)) {
      try {
        const data = await entry.async("uint8array");
        fonts.push({ name, data });
      } catch (err) {
        warnings.push(`Failed to read font "${relativePath}": ${err.message}`);
      }
      continue;
    }

    if (isZipFilename(name)) {
      if (depth >= MAX_DEPTH) {
        warnings.push(
          `Nested ZIP "${relativePath}" exceeds max depth ${MAX_DEPTH} — skipped.`
        );
        continue;
      }
      try {
        const nestedBytes = await entry.async("uint8array");
        const nestedZip = await JSZip.loadAsync(nestedBytes);
        const nestedFonts = await walkZip(nestedZip, depth + 1, warnings);
        fonts.push(...nestedFonts);
      } catch (err) {
        warnings.push(
          `Failed to open nested ZIP "${relativePath}": ${err.message}`
        );
      }
      continue;
    }

    // Anything else (non-font, non-ZIP) is silently skipped — same as original.
  }

  return fonts;
}

/**
 * Top-level extractor. Given the raw bytes of a ZIP file, return every font
 * discovered inside (recursively). Filenames are NOT yet deduped — that
 * happens globally across the whole session, not per-file.
 */
export async function extractFontsFromZip(zipBytes) {
  const warnings = [];
  let zip;
  try {
    zip = await JSZip.loadAsync(zipBytes);
  } catch (err) {
    // Re-throw so caller can distinguish "bad ZIP" from "empty ZIP".
    throw new Error(`Not a valid ZIP: ${err.message}`);
  }
  const fonts = await walkZip(zip, 0, warnings);
  return { fonts, warnings };
}

/**
 * Font-family detection heuristic — ported verbatim from the original web app.
 * Strategy: strip the extension and common weight/style/version tokens from
 * every filename, then look for the longest common leading substring shared
 * by *all* filenames. If we get something meaningful (>= 3 chars), that's the
 * family; otherwise return null.
 *
 * DO NOT "improve" these regexes — the algorithm is intentionally identical
 * to the original tool so behavior matches exactly.
 */
export function detectFontFamily(filenames) {
  if (!filenames || filenames.length === 0) return null;

  const patterns = [
    /-?(Regular|Bold|Italic|Light|Medium|SemiBold|ExtraBold|Black|Thin|Heavy)/gi,
    /-?(Oblique|Condensed|Extended|Narrow)/gi,
    /\.(ttf|otf|woff|woff2|eot|svg)$/i,
    /[-_]?(v\d+)/gi,
    /[-_]?(\d+)/g,
  ];

  const cleaned = filenames.map((name) => {
    let n = name;
    for (const p of patterns) n = n.replace(p, "");
    // Strip trailing separators left behind by the regex substitutions.
    return n.replace(/[-_\s]+$/g, "").trim();
  });

  // Longest common prefix across all cleaned names.
  if (cleaned.length === 1) {
    const only = cleaned[0];
    return only.length >= 3 ? only : null;
  }

  let prefix = cleaned[0];
  for (let i = 1; i < cleaned.length; i++) {
    let j = 0;
    while (
      j < prefix.length &&
      j < cleaned[i].length &&
      prefix[j].toLowerCase() === cleaned[i][j].toLowerCase()
    ) {
      j++;
    }
    prefix = prefix.slice(0, j);
    if (!prefix) break;
  }

  // Trim any dangling separator.
  prefix = prefix.replace(/[-_\s]+$/g, "").trim();
  return prefix.length >= 3 ? prefix : null;
}

/**
 * Given a list of font objects, mutate their .name fields so all names are
 * unique. Collisions get "-1", "-2", ... suffixes inserted before the extension.
 * Same behavior as the original tool, but applied globally across the whole
 * session (not per-ZIP) so cross-file collisions are handled too.
 */
export function dedupeFilenames(fonts) {
  const used = new Set();
  for (const f of fonts) {
    if (!used.has(f.name)) {
      used.add(f.name);
      continue;
    }
    // Split into base + extension.
    const dot = f.name.lastIndexOf(".");
    const base = dot > 0 ? f.name.slice(0, dot) : f.name;
    const ext = dot > 0 ? f.name.slice(dot) : "";
    let i = 1;
    let candidate;
    do {
      candidate = `${base}-${i}${ext}`;
      i++;
    } while (used.has(candidate));
    f.name = candidate;
    used.add(candidate);
  }
  return fonts;
}

/**
 * Build the final flat output ZIP (no folder nesting) from the deduped font
 * list. Returns a Uint8Array ready to hand to Telegram's sendDocument.
 */
export async function buildOutputZip(fonts) {
  const zip = new JSZip();
  for (const f of fonts) {
    zip.file(f.name, f.data);
  }
  return await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

/**
 * Pick a smart output filename. Priority:
 *   1. Detected family name across all fonts → "Roboto-Fonts.zip"
 *   2. Caller-supplied fallback (typically the original ZIP name minus .zip)
 *   3. "Combined-Fonts-<timestamp>.zip"
 */
export function pickOutputName(fonts, fallback) {
  const names = fonts.map((f) => f.name);
  const family = detectFontFamily(names);
  if (family) return `${family}-Fonts.zip`;
  if (fallback && fallback.trim()) {
    const cleanFallback = fallback.replace(/\.zip$/i, "").trim();
    if (cleanFallback) return `${cleanFallback}-Fonts.zip`;
  }
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/T/, "_")
    .replace(/Z$/, "");
  return `Combined-Fonts-${ts}.zip`;
}
