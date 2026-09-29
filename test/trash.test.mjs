// Check Trash sweep (review finding 11): a Trash larger than one click's page
// cap completes across clicks; safe-to-empty needs a sweep nothing slipped past.

import assert from "node:assert/strict";
import { test } from "vitest";
import { setupEngine, jobsOfKind } from "./helpers/engine.mjs";

/** More Trash than one click reads (80 pages × 50), one paired item last. */
async function bigTrash(eng, mock, root, extra = 120) {
  for (let i = 0; i < 80 * 50 + extra; i++) {
    const it = mock._seedRich(root._id, { link: `https://t.example/${i}`, title: `t${i}` });
    await mock.deleteRaindrop(it._id);
  }
  const paired = mock._seedRich(root._id, { link: "https://t.example/paired", title: "paired" });
  await eng.store.recordSynced("bm-paired", String(paired._id), {
    url: "https://t.example/paired",
  });
  await mock.deleteRaindrop(paired._id);
  return String(paired._id);
}

const click = (eng) =>
  eng.reconcileFinish.runTrashHygienePeek({ client: new eng.raindropMod.RaindropClient("mock") });

test("Check Trash resumes where the last click stopped and completes", async () => {
  const { eng, mock, root } = await setupEngine();
  const rid = await bigTrash(eng, mock, root);

  assert.equal((await click(eng)).scanComplete, false, "first click hits the page cap");
  const second = await click(eng);
  assert.equal(second.scanComplete, true, "second click reaches the end");
  assert.ok(
    (await jobsOfKind(eng, "delete-edge")).some((j) => String(j.raindropId) === rid),
    "paired item past the first click's cap is enrolled"
  );
  assert.equal((await eng.store.getReconcileState()).trashSweep ?? null, null, "sweep cleared");
});

test("items leaving Trash mid-sweep restart it (pages shifted)", async () => {
  const { eng, mock, root } = await setupEngine();
  await bigTrash(eng, mock, root);
  await click(eng);
  // The user restores 60 items: later items slide onto pages already read.
  for (const id of [...mock._trash.keys()].slice(0, 60)) mock._trash.delete(id);

  assert.equal((await click(eng)).scanComplete, false, "restarted, not complete");
  let done = false;
  for (let i = 0; i < 3 && !done; i++) done = (await click(eng)).scanComplete;
  assert.ok(done, "a clean sweep completes");
});
