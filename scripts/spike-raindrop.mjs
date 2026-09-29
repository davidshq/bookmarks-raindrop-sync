#!/usr/bin/env node
// Raindrop.io API spike for folder mirroring + bidirectional sync.
//
// Original checks (folder mirroring):
//   1.1  token auth (GET /user)
//   1.2  nested collections to depth 3 via parent.$id
//   1.3  child lookup by parent + title; duplicate titles
//   1.4  raindrop creation; rate-limit headers
//
// Bidirectional checks:
//   2.1  list raindrops by collection with nested=true + pagination
//   2.2  DELETE /raindrop/{id} moves to Trash (not permanent)
//   2.3  PUT /raindrop/{id} with only title/link — rich fields preserved
//
// Usage:
//   node scripts/spike-raindrop.mjs [--cleanup]          (RAINDROP_TOKEN or .tmp/raindrop_token)
//   node scripts/spike-raindrop.mjs <token> [--cleanup]
//
// --cleanup deletes everything the spike created when it finishes.

import { RAINDROP_API } from "../src/lib/constants.js";
import { assertTestAccount, loadToken } from "./lib/token.mjs";

const API = RAINDROP_API;

const args = process.argv.slice(2);
const cleanup = args.includes("--cleanup");
const token = args.find((a) => !a.startsWith("--")) || loadToken();

if (!token) {
  console.error(
    "No token. Set RAINDROP_TOKEN, add .tmp/raindrop_token, or pass it as the first argument."
  );
  process.exit(1);
}

let lastRateHeaders = {};

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  lastRateHeaders = {
    limit: res.headers.get("X-RateLimit-Limit"),
    remaining: res.headers.get("X-RateLimit-Remaining"),
    reset: res.headers.get("X-RateLimit-Reset"),
    retryAfter: res.headers.get("Retry-After"),
  };
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return json;
}

const created = { collections: [], raindrops: [] };

async function createCollection(title, parentId) {
  const body = { title };
  if (parentId != null) body.parent = { $id: parentId };
  const { item } = await call("POST", "/collection", body);
  created.collections.push(item._id);
  return item;
}

async function main() {
  console.log("== 1.1 Token check (GET /user) ==");
  const { user } = await call("GET", "/user");
  console.log(`  OK: ${user.fullName || user.email || user._id}`);
  await assertTestAccount(token);

  console.log("\n== 1.2 Nested collections to depth 3 ==");
  const root = await createCollection("ERS Spike Root");
  console.log(`  root: "${root.title}" (_id ${root._id})`);
  const child = await createCollection("Child", root._id);
  console.log(`  child: "${child.title}" parent=${child.parent?.$id}`);
  const grand = await createCollection("Grandchild", child._id);
  console.log(`  grandchild: "${grand.title}" parent=${grand.parent?.$id}`);
  console.log(
    grand.parent?.$id === child._id
      ? "  ✔ depth-3 nesting via parent.$id confirmed"
      : "  ✗ grandchild parent did not match — nesting may be limited"
  );

  console.log("\n== 1.3 Child lookup by parent + title; duplicate titles ==");
  const childrens = await call("GET", "/collections/childrens");
  const underChild = (childrens.items || []).filter((c) => c.parent?.$id === child._id);
  console.log(`  /collections/childrens returned ${childrens.items?.length ?? 0} nested total`);
  console.log(`  found ${underChild.length} under "Child" by parent.$id match`);
  const dup = await createCollection("Grandchild", child._id);
  console.log(
    dup._id !== grand._id
      ? `  ⚠ duplicate title allowed under same parent (got new _id ${dup._id}) — ensure-if-missing MUST match existing by title, not blindly create`
      : "  ✔ duplicate title was de-duplicated by Raindrop"
  );

  console.log("\n== 1.4 Raindrop creation + rate-limit headers ==");
  const { item: drop } = await call("POST", "/raindrop", {
    link: "https://example.com/ers-spike",
    title: "ERS Spike Bookmark",
    collection: { $id: grand._id },
    pleaseParse: {},
    tags: ["ers-spike-tag"],
    note: "spike-rich-note",
  });
  created.raindrops.push(drop._id);
  console.log(`  created raindrop _id ${drop._id} in collection ${drop.collection?.$id}`);
  console.log(`  rate-limit headers: ${JSON.stringify(lastRateHeaders)}`);

  console.log("\n== 2.1 List raindrops (nested + pagination) ==");
  const listed = await call("GET", `/raindrops/${root._id}?nested=true&perpage=50&page=0`);
  const items = listed.items || [];
  const found = items.some((i) => i._id === drop._id);
  console.log(`  GET /raindrops/${root._id}?nested=true → ${items.length} item(s)`);
  console.log(
    found
      ? "  ✔ nested listing includes grandchild raindrop"
      : "  ✗ nested listing did not include the spike raindrop"
  );
  console.log(`  count field: ${listed.count ?? "(none)"}`);

  console.log("\n== 2.3 Partial PUT preserves rich fields ==");
  await call("PUT", `/raindrop/${drop._id}`, {
    title: "ERS Spike Bookmark (renamed)",
    link: "https://example.com/ers-spike-renamed",
  });
  const { item: afterPut } = await call("GET", `/raindrop/${drop._id}`);
  const tagsOk = Array.isArray(afterPut.tags) && afterPut.tags.includes("ers-spike-tag");
  const noteOk = afterPut.note === "spike-rich-note";
  console.log(`  tags after title/link PUT: ${JSON.stringify(afterPut.tags)}`);
  console.log(`  note after title/link PUT: ${JSON.stringify(afterPut.note)}`);
  console.log(
    tagsOk && noteOk
      ? "  ✔ partial PUT preserved tags and note"
      : "  ✗ rich fields changed — do NOT send empty tags/notes; prefer omit updates in engine if unsafe"
  );

  console.log("\n== 2.2 DELETE moves to Trash ==");
  await call("DELETE", `/raindrop/${drop._id}`);
  created.raindrops = created.raindrops.filter((id) => id !== drop._id);
  const trash = await call("GET", "/raindrops/-99?perpage=50&page=0");
  const inTrash = (trash.items || []).some((i) => i._id === drop._id);
  console.log(
    inTrash
      ? "  ✔ DELETE /raindrop/{id} moved item to Trash (-99), not permanent"
      : "  ⚠ not found in Trash page 0 — may have paged out; treat DELETE as soft-delete per docs"
  );
  // Permanent cleanup from trash for --cleanup hygiene
  if (inTrash) {
    await call("DELETE", `/raindrop/${drop._id}`).catch(() => {});
  }

  console.log("\nSpike complete. Findings to fold into the client:");
  console.log(
    "  - parent.$id nesting depth:",
    grand.parent?.$id === child._id ? "OK to 3" : "LIMITED"
  );
  console.log(
    "  - duplicate titles per parent:",
    dup._id !== grand._id ? "ALLOWED (match-before-create)" : "de-duplicated"
  );
  console.log("  - nested list:", found ? "OK with nested=true" : "FAILED");
  console.log("  - partial PUT rich-field safe:", tagsOk && noteOk ? "YES" : "NO");
  console.log("  - DELETE semantics:", inTrash ? "soft (Trash)" : "check manually");
  console.log("  - rate-limit signal:", JSON.stringify(lastRateHeaders));

  if (cleanup) {
    console.log("\n== Cleanup ==");
    for (const id of created.raindrops) {
      await call("DELETE", `/raindrop/${id}`).catch(() => {});
      await call("DELETE", `/raindrop/${id}`).catch(() => {}); // second pass: permanent if in trash
    }
    for (const id of [...created.collections].reverse()) {
      await call("DELETE", `/collection/${id}`).catch(() => {});
    }
    console.log("  removed spike collections and raindrops.");
  } else {
    console.log('\n(Use --cleanup to remove the "ERS Spike Root" collection tree.)');
  }
}

main().catch((err) => {
  console.error("\nSpike failed:", err.message);
  process.exit(1);
});
