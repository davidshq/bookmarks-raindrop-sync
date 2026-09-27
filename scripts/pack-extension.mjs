#!/usr/bin/env node
// Zip src/ into dist/bookmarks-raindrop-sync-<version>.zip for sideload / store upload.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");
const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));
const version = manifest.version || "0.0.0";
const out = path.join(dist, `bookmarks-raindrop-sync-${version}.zip`);

fs.mkdirSync(dist, { recursive: true });
if (fs.existsSync(out)) fs.unlinkSync(out);

const result = spawnSync("zip", ["-r", "-q", out, "."], { cwd: src, encoding: "utf8" });
if (result.status !== 0) {
  console.error(result.stderr || result.stdout || "zip failed");
  process.exit(result.status || 1);
}
console.log(`Packed ${out}`);
