// ESLint flat config for the Edge ↔ Raindrop MV3 extension.
//
// Three environments share one repo:
//   - background / lib: chrome.* APIs, no DOM
//   - options / popup: DOM + chrome.*
//   - scripts, test: Node (tests assign globalThis.chrome for mocks)

import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

const chromeApi = {
  chrome: "readonly",
};

export default [
  {
    ignores: ["node_modules/**", ".tmp/**", "openspec/**"],
  },

  js.configs.recommended,
  eslintConfigPrettier,

  {
    files: ["src/lib/**/*.js", "src/background/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.serviceworker,
        ...globals.webextensions,
        ...chromeApi,
      },
    },
    rules: {
      // Spec forbids import() on ServiceWorkerGlobalScope; Node tests hide that.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message:
            "Dynamic import() is disallowed in MV3 service workers (ServiceWorkerGlobalScope).",
        },
      ],
    },
  },

  {
    files: ["src/options/**/*.js", "src/popup/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...chromeApi,
      },
    },
  },

  {
    files: ["scripts/**/*.{js,mjs}", "test/**/*.mjs", "eslint.config.js", "vitest.config.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
        // Verify scripts mock the extension API on globalThis.
        chrome: "writable",
      },
    },
  },

  // Puppeteer page.evaluate / evaluateOnNewDocument callbacks run in the page;
  // ESLint still parses them as this file's scope.
  {
    files: ["scripts/smoke-bulk-options.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        chrome: "readonly",
        // options.js may expose this; referenced only inside page.evaluate.
        refreshStatus: "readonly",
      },
    },
  },

  {
    files: ["**/*.{js,mjs}"],
    rules: {
      eqeqeq: ["error", "smart"],
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-console": "off",
      "prefer-const": "error",
    },
  },
];
