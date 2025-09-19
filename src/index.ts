#!/usr/bin/env node

/**
 * find-unused-fallback-keys.ts
 *
 * CLI script that:
 *   1) Reads a JSON file containing key:string -> value:string pairs (e.g., fallbackTexts.json)
 *   2) Recursively scans a folder of source files
 *   3) Reports which keys from the JSON are NOT used anywhere in the codebase
 *   4) (Optional) Removes those unused keys from the JSON file if --remove is passed
 *
 * Usage:
 *   ts-node find-unused-fallback-keys.ts <path/to/fallbackTexts.json> <path/to/folder> [--remove] [--ext ".ts,.tsx,.js,.jsx"] [--ignore "node_modules,dist,.git"] [--case-sensitive=false]
 *
 * Examples:
 *   ts-node find-unused-fallback-keys.ts ./fallbackTexts.json ./src
 *   ts-node find-unused-fallback-keys.ts ./fallbackTexts.json ./apps/web --remove --ext ".ts,.tsx,.js,.jsx,.md" --ignore "node_modules,dist,build,.next,.git" --case-sensitive=false
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

// -------------------- CLI ARGS --------------------
interface Options {
  jsonPath: string;
  rootDir: string;
  exts: string[]; // e.g. [".ts", ".tsx", ".js", ".jsx"]
  ignoreDirs: string[]; // dir names to ignore
  caseSensitive: boolean;
  maxFileBytes: number; // safety cap
  remove: boolean;
}

function parseArgs(argv: string[]): Options {
  if (argv.length < 4) {
    console.error(
      "Usage: ts-node find-unused-fallback-keys.ts <path/to/fallbackTexts.json> <path/to/folder> [--remove] [--ext \".ts,.tsx,.js,.jsx\"] [--ignore \"node_modules,dist,.git\"] [--case-sensitive=false]"
    );
    process.exit(1);
  }

  const jsonPath = path.resolve(argv[2]);
  const rootDir = path.resolve(argv[3]);

  const defaults = {
    exts: [".ts", ".tsx", ".js", ".jsx"],
    ignoreDirs: ["node_modules", ".git", "dist", "build", ".next", "out"],
    caseSensitive: true,
    maxFileBytes: 2 * 1024 * 1024, // 2MB
    remove: false,
  } satisfies Omit<Options, "jsonPath" | "rootDir">;

  let exts = defaults.exts;
  let ignoreDirs = defaults.ignoreDirs;
  let caseSensitive: boolean = defaults.caseSensitive;
  let maxFileBytes = defaults.maxFileBytes;
  let remove: boolean = defaults.remove;

  for (let i = 4; i < argv.length; i++) {
    const [flag, rawValue] = argv[i].split("=");
    const value = rawValue ?? argv[++i];
    switch (flag) {
      case "--ext":
        if (!value) break;
        exts = value.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--ignore":
        if (!value) break;
        ignoreDirs = value.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--case-sensitive":
        if (value === undefined) break;
        caseSensitive = value === "true" || value === "1";
        break;
      case "--max-bytes":
        if (value) maxFileBytes = Number(value) || maxFileBytes;
        break;
      case "--remove":
        remove = true;
        break;
      default:
        console.warn(`Unknown flag: ${flag}`);
    }
  }

  return { jsonPath, rootDir, exts, ignoreDirs, caseSensitive, maxFileBytes, remove };
}

// -------------------- FILE UTILS --------------------
async function* walk(dir: string, ignoreDirs: string[]): AsyncGenerator<string> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignoreDirs.includes(entry.name)) continue;
      // skip hidden directories like .git, .cache
      if (entry.name.startsWith(".")) {
        if (ignoreDirs.includes(entry.name)) continue;
      }
      yield* walk(full, ignoreDirs);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function shouldScanFile(filePath: string, exts: string[]): boolean {
  const ext = path.extname(filePath);
  return exts.length === 0 || exts.includes(ext);
}

// Escape string for safe use inside a RegExp
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build a set of search patterns for a key
function buildKeyPatterns(key: string, caseSensitive: boolean): RegExp[] {
  const flags = caseSensitive ? "g" : "gi";
  const k = escapeRegex(key);
  return [
    // 'key' or "key" or `key`
    new RegExp(`(['\"\`])${k}\\1`, flags),
    // .key (property access)
    new RegExp(`\\.${k}(?![A-Za-z0-9_\-])`, flags),
    // ["key"] or ['key']
    new RegExp(`\\[\\s*(['\"\`])${k}\\1\\s*\\]`, flags),
    // as an identifier/word boundary (best-effort)
    new RegExp(`(?<![A-Za-z0-9_\-])${k}(?![A-Za-z0-9_\-])`, flags),
  ];
}

// -------------------- MAIN LOGIC --------------------
async function main() {
  const opts = parseArgs(process.argv);

  // 1) Load JSON and extract keys
  let raw: string;
  try {
    raw = await fsp.readFile(opts.jsonPath, "utf8");
  } catch (err) {
    console.error(`Failed to read JSON: ${opts.jsonPath}`);
    console.error(err);
    process.exit(1);
  }

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    console.error(`File is not valid JSON: ${opts.jsonPath}`);
    console.error(err);
    process.exit(1);
  }

  // Ensure it's a map of key -> string
  const keys = Object.keys(obj).filter((k) => typeof (obj as any)[k] === "string");
  if (keys.length === 0) {
    console.warn("No string values found in the provided JSON. Nothing to do.");
    process.exit(0);
  }

  // Initialize tracking
  const foundMap = new Map<string, boolean>(keys.map((k) => [k, false]));
  const patterns = new Map<string, RegExp[]>(
    keys.map((k) => [k, buildKeyPatterns(k, opts.caseSensitive)])
  );

  // 2) Walk files & search
  let scannedFiles = 0;
  for await (const file of walk(opts.rootDir, opts.ignoreDirs)) {
    if (!shouldScanFile(file, opts.exts)) continue;
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(file);
      if (stat.size > opts.maxFileBytes) continue; // skip very large files
    } catch {
      continue; // ignore unreadable files
    }

    let content: string;
    try {
      content = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }

    scannedFiles++;

    // Quick pre-check: skip if file has none of the keys as substrings (case-insensitive if needed)
    const haystack = opts.caseSensitive ? content : content.toLowerCase();

    for (const [key, wasFound] of foundMap) {
      if (wasFound) continue; // no need to re-check
      const needle = opts.caseSensitive ? key : key.toLowerCase();
      if (!haystack.includes(needle)) continue; // substring fast-path

      const regs = patterns.get(key)!;
      for (const re of regs) {
        re.lastIndex = 0; // ensure from start
        if (re.test(content)) {
          foundMap.set(key, true);
          break;
        }
      }
    }
  }

  // 3) Collect unused keys
  const unused = Array.from(foundMap.entries())
    .filter(([, used]) => !used)
    .map(([k]) => k)
    .sort((a, b) => a.localeCompare(b));

  // 4) Output results
  console.log("\n—— Scan Summary ——");
  console.log(`Root dir:       ${opts.rootDir}`);
  console.log(`JSON file:      ${opts.jsonPath}`);
  console.log(`Extensions:     ${opts.exts.join(", ")}`);
  console.log(`Ignored dirs:   ${opts.ignoreDirs.join(", ")}`);
  console.log(`Case-sensitive: ${opts.caseSensitive}`);
  console.log(`Files scanned:  ${scannedFiles}`);

  if (unused.length === 0) {
    console.log("\n🎉 No unused keys found. Nice!");
  } else {
    console.log(`\nUnused keys (${unused.length}):`);
    for (const k of unused) console.log("-", k);

    if (opts.remove) {
      console.log("\n--remove flag detected. Removing unused keys from JSON...");
      for (const k of unused) {
        delete (obj as any)[k];
      }
      try {
        await fsp.writeFile(opts.jsonPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
        console.log(`Removed ${unused.length} keys and updated ${opts.jsonPath}`);
      } catch (err) {
        console.error("Failed to write updated JSON:", err);
        process.exit(1);
      }
    }

    // Optional: Exit with code 2 when unused keys exist (useful for CI)
    // process.exit(2);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});

