#!/usr/bin/env node
/**
 * Copy the main Raindrop library into the dedicated test account so live
 * tests can run against realistic data without touching the real library.
 *
 * SAFETY:
 * - Source (main account) is read only: GET /collections*, GET /raindrops/0.
 * - Destination must be the test account (see loadTestAccountId) and must be empty
 *   (no collections, no raindrops); otherwise nothing is written.
 * - Trash is not copied.
 *
 * Tokens:
 *   source: RAINDROP_SOURCE_TOKEN, else .tmp/raindrop_main_token
 *   dest:   RAINDROP_TOKEN, else .tmp/raindrop_token (same as the live tests)
 *
 * Usage:
 *   node scripts/seed-test-account.mjs [--dry-run]
 */

import fs from "node:fs";
import path from "node:path";
import { RAINDROP_API } from "../src/lib/constants.js";
import { REPO_ROOT, loadToken, loadTestAccountId } from "./lib/token.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const PER_PAGE = 50;
const BULK_MAX = 100;

function loadSourceToken() {
  if (process.env.RAINDROP_SOURCE_TOKEN) return process.env.RAINDROP_SOURCE_TOKEN.trim();
  const p = path.join(REPO_ROOT, ".tmp", "raindrop_main_token");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal client with 429 / low-quota backoff. */
function client(token) {
  return async function call(method, apiPath, body) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${RAINDROP_API}${apiPath}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const remaining = Number(res.headers.get("x-ratelimit-remaining"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const waitMs = reset ? Math.max(1000, reset * 1000 - Date.now() + 500) : 60_000;
      if (res.status === 429 && attempt < 5) {
        console.warn(`  429 on ${method} ${apiPath}; waiting ${Math.ceil(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.result === false) {
        throw new Error(
          `${method} ${apiPath} → ${res.status} ${JSON.stringify(data).slice(0, 300)}`
        );
      }
      if (Number.isFinite(remaining) && remaining <= 5) {
        console.warn(`  quota ${remaining}; waiting ${Math.ceil(waitMs / 1000)}s`);
        await sleep(waitMs);
      }
      return data;
    }
  };
}

async function listCollections(call) {
  const roots = (await call("GET", "/collections")).items;
  const children = (await call("GET", "/collections/childrens")).items;
  // The two listings overlap for some collections; key by id.
  return [...new Map([...roots, ...children].map((c) => [c._id, c])).values()];
}

async function listAllRaindrops(call) {
  const byId = new Map();
  for (let page = 0; ; page++) {
    const { items } = await call(
      "GET",
      `/raindrops/0?perpage=${PER_PAGE}&page=${page}&sort=created`
    );
    for (const it of items) byId.set(it._id, it);
    if (items.length < PER_PAGE) break;
    if (page % 20 === 0) console.log(`  listed ${byId.size}…`);
  }
  return [...byId.values()];
}

/** Parents before children. */
function topoOrder(cols) {
  const byId = new Map(cols.map((c) => [c._id, c]));
  const depth = (c) => {
    let d = 0;
    for (let p = c.parent?.$id; p && byId.has(p); p = byId.get(p).parent?.$id) d++;
    return d;
  };
  return [...cols].sort((a, b) => depth(a) - depth(b) || (a.sort ?? 0) - (b.sort ?? 0));
}

function raindropBody(it, collectionId) {
  const body = {
    link: it.link,
    title: it.title,
    excerpt: it.excerpt,
    note: it.note,
    tags: it.tags,
    type: it.type,
    cover: it.cover,
    media: it.media,
    important: it.important,
    created: it.created,
    lastUpdate: it.lastUpdate,
    collection: { $id: collectionId },
  };
  if (it.highlights?.length) {
    body.highlights = it.highlights.map(({ text, color, note }) => ({ text, color, note }));
  }
  return body;
}

async function main() {
  const srcToken = loadSourceToken();
  const dstToken = loadToken();
  if (!srcToken || !dstToken) {
    console.error("Need source (.tmp/raindrop_main_token) and dest (.tmp/raindrop_token) tokens.");
    process.exit(1);
  }
  const src = client(srcToken);
  const dst = client(dstToken);

  const srcUser = (await src("GET", "/user")).user;
  const dstUser = (await dst("GET", "/user")).user;
  console.log(
    `source: ${srcUser._id} (${srcUser.email})  →  dest: ${dstUser._id} (${dstUser.email})`
  );
  if (dstUser._id !== loadTestAccountId() || srcUser._id === dstUser._id) {
    throw new Error("Refusing: destination is not the configured test account.");
  }
  const dstStats = (await dst("GET", "/user/stats")).items;
  const dstCount = dstStats.find((s) => s._id === 0)?.count ?? 0;
  const dstCols = await listCollections(dst);
  if (dstCount > 0 || dstCols.length > 0) {
    throw new Error(
      `Refusing: test account not empty (${dstCount} raindrops, ${dstCols.length} collections).`
    );
  }

  const cols = topoOrder(await listCollections(src));
  console.log(`source collections: ${cols.length}`);
  const raindrops = await listAllRaindrops(src);
  console.log(`source raindrops (excluding trash): ${raindrops.length}`);
  if (DRY_RUN) return;

  // Collections, parents first. Unsorted (-1) exists in every account.
  const idMap = new Map([[-1, -1]]);
  for (const c of cols) {
    const parent = c.parent?.$id;
    if (parent && !idMap.has(parent)) {
      console.warn(`  skip collection ${c._id} "${c.title}": parent ${parent} not copied`);
      continue;
    }
    const body = {
      title: c.title,
      view: c.view,
      sort: c.sort,
      expanded: c.expanded,
      description: c.description,
      ...(parent ? { parent: { $id: idMap.get(parent) } } : {}),
    };
    const { item } = await dst("POST", "/collection", body);
    idMap.set(c._id, item._id);
  }
  console.log(`created collections: ${idMap.size - 1}`);

  // Raindrops in bulk.
  const skipped = [];
  const bodies = [];
  for (const it of raindrops) {
    const target = idMap.get(it.collection?.$id ?? it.collectionId);
    if (target === undefined) skipped.push(it);
    else bodies.push(raindropBody(it, target));
  }
  // Bulk create silently drops non-http(s) links (edge://…); single create keeps them.
  const isWeb = (b) => /^https?:/i.test(b.link);
  const bulk = bodies.filter(isWeb);
  let created = 0;
  for (let i = 0; i < bulk.length; i += BULK_MAX) {
    const { items } = await dst("POST", "/raindrops", { items: bulk.slice(i, i + BULK_MAX) });
    created += items.length;
    console.log(`  created ${created}/${bodies.length}`);
  }
  for (const body of bodies.filter((b) => !isWeb(b))) {
    await dst("POST", "/raindrop", body);
    created++;
  }
  console.log(`  created ${created}/${bodies.length}`);
  if (skipped.length) {
    console.warn(`skipped ${skipped.length} raindrops in uncopied collections:`);
    for (const s of skipped.slice(0, 20)) console.warn(`  ${s._id} ${s.link}`);
  }

  // Verify per-collection counts (by source id).
  await sleep(3000);
  const srcCounts = new Map();
  for (const it of raindrops) {
    const k = it.collection?.$id ?? it.collectionId;
    srcCounts.set(k, (srcCounts.get(k) ?? 0) + 1);
  }
  const dstAll = await listAllRaindrops(dst);
  const dstCounts = new Map();
  for (const it of dstAll) {
    const k = it.collection?.$id ?? it.collectionId;
    dstCounts.set(k, (dstCounts.get(k) ?? 0) + 1);
  }
  let mismatches = 0;
  for (const [srcId, n] of srcCounts) {
    const got = dstCounts.get(idMap.get(srcId)) ?? 0;
    if (got !== n) {
      mismatches++;
      console.warn(`  count mismatch: source collection ${srcId}: ${n} → ${got}`);
    }
  }
  console.log(
    `verify: source ${raindrops.length}, dest ${dstAll.length}, collection mismatches ${mismatches}`
  );
  if (mismatches || dstAll.length !== raindrops.length) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
