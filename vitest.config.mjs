// Vitest config. The extension ships raw ES modules with no build step, so
// tests run the same files Edge loads. Each test file gets its own process
// (forks + isolate): the harness mocks `chrome` on globalThis and several
// modules keep per-process caches (presence snapshot, collection index).

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.mjs"],
    environment: "node",
    pool: "forks",
    isolate: true,
    // Engine scenarios drain whole queues against the fake Raindrop.
    testTimeout: 30_000,
  },
});
