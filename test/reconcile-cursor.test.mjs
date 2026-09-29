// Outside-root listing spans ticks: a tick that runs out of budget mid-way
// checkpoints outsideCursor, and the next tick resumes it, then finishes.

import assert from "node:assert/strict";
import { test } from "vitest";
import { setupEngine, jobsOfKind } from "./helpers/engine.mjs";
import { reconcile } from "../src/lib/reconcile.js";
import { WakeBudget } from "../src/lib/wake-budget.js";

const tinyBudget = () =>
  new WakeBudget({
    mode: "full",
    headerRemaining: null,
    headerResetAt: null,
    wakeCapReqs: 4,
    bootstrapReqs: 4,
  });

test("outside-root cursor resumes across ticks and every item is pulled", async () => {
  const { eng, mock } = await setupEngine();
  const outside = await mock.createCollection("Elsewhere", null);
  const links = [];
  for (let n = 0; n < 120; n++) {
    const link = `https://outside.example/${n}`;
    links.push(link);
    mock._seedRich(outside._id, { link, title: `o${n}` });
  }
  await eng.store.setConfig({
    raindropFolderAllowlist: { [outside._id]: { path: "Elsewhere" } },
  });

  let sawCheckpoint = false;
  let done = false;
  for (let tickNo = 0; tickNo < 40 && !done; tickNo++) {
    const result = await reconcile({ force: true, budget: tinyBudget() });
    if ((await eng.store.getReconcileState()).outsideCursor) sawCheckpoint = true;
    done = !!result?.done;
  }
  assert.ok(sawCheckpoint, "a tick checkpointed mid outside-root listing");
  assert.ok(done, "listing eventually finished");
  assert.equal((await eng.store.getReconcileState()).outsideCursor ?? null, null);

  const pulled = new Set((await jobsOfKind(eng, eng.constants.JOB.PULL_CREATE)).map((j) => j.link));
  for (const link of links) assert.ok(pulled.has(link), `pull-create queued for ${link}`);
});
