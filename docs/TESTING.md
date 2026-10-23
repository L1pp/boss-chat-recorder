# Testing and evidence boundaries

[English](TESTING.md) | [简体中文](zh-CN/TESTING.md)

Node tests cover data and control logic; isolated Chromium tests exercise native extension APIs, storage, and browser lifecycle. Both use repository synthetic data without BOSS login, personal profiles, real chats, or store access.

## Build and Node regression

Use Node.js 24 or later. This layer needs no third-party dependency installation:

```sh
npm run build
npm test
npm run check
npm run test:coverage
```

| Command | Purpose |
| --- | --- |
| `build` | Generate the committed extension bundles from source |
| `test` | Run offline regression with replacement Chrome APIs, DOM, IndexedDB, and fetch |
| `check` | Compare bundles without rewriting them; check public files, licenses, versions, synthetic examples, and selected sensitive patterns |
| `test:coverage` | Print V8 coverage and write `coverage/lcov.info` |

Node regression covers incremental selection, deduplication, pagination and pauses, UID partitions and late writes, export scope, commit/recovery behavior, popup state, and synthetic release-client HTTP responses.

Coverage describes only files actually executed by the Node run in `extension-tracker/` and `scripts/`. Unloaded files may be absent; VM/data-URL execution may not map to source. Chromium is excluded. There is no coverage-percentage pass threshold. Coverage locates missing tests, while source checks detect only the sensitive patterns they implement.

Generated `node_modules/`, reports, `coverage/`, and `dist/` are ignored. Runtime ZIPs use the explicit file list in `scripts/package-extension.mjs`.

## Offline demo and fixtures

Open [examples/index.html](../examples/index.html) directly in a browser. No extension, server, or platform login is needed, and the page makes no network requests.

Switch between two fictional accounts and all-record, latest-update, and no-change exports. The accounts reuse a recruiter ID and message ID with different contents; fixtures include media summaries, incomplete history, and unknown sending times. The Chinese/English switch changes this page's interface only; messages retain their original Chinese, and the choice is not persisted.

Regenerate the page and [JSON fixtures](../examples/demo-data/) with:

```sh
npm run demo
```

The [generator](../scripts/generate-demo.mjs) uses the production export module. The page demonstrates archive/export semantics; it is not a live-site screenshot or an extension chat browser.

## Chromium regression

Install the development tools and Chromium, then build and run:

```sh
npm ci --ignore-scripts
npm run test:browser:install
npm run build
npm run test:browser
```

On Linux, install missing system libraries with `npm run test:browser:install -- --with-deps`. The wrappers use the project cache at `node_modules/.cache/boss-browser/`, without clearing shared Playwright caches. Profiles are new system-temporary directories. Playwright is a development dependency and is excluded from the extension ZIP.

The suite loads the extension from the public package list and seeds two synthetic accounts through production storage modules. It checks:

- Native encrypted `chrome.storage.local` values, a non-extractable IndexedDB CryptoKey, and popup cache display.
- Empty/existing archive guidance and actions, with synthetic screenshots.
- Browser-language selection, including `zh-TW` and unsupported-language fallback, immediate switching, persistence after rapid choices and cold restart, and unchanged Chinese message exports. Node tests cover in-flight actions, delayed preference reads, recovery, and translated accessibility/confirmation text.
- Account-specific export and clearing when recruiter/message IDs overlap.
- Worker stop/wake and a full Chromium restart with the same temporary profile, without reseeding.

Export and clearing use a real extension page with production modules; display checks use `popup.html`. The headless harness does not automate a successful toolbar action-popup-to-worker round trip. Node tests cover those message handlers; earlier one-off native acceptance is recorded in [verification](VERIFICATION.md).

External network is blocked and collection is not started. Cleanup removes only verified temporary paths created by that run. On failure, screenshots and traces remain in `test-results/`; the HTML report is in `playwright-report/`. Open it with `npx playwright show-report`. There are no automatic retries, pixel-comparison checks, or fixed-second performance thresholds.

## CI and acceptance limits

Pushes and PRs run Node 24 tests, coverage, public checks, and ZIP packaging on Ubuntu and Windows, plus native Chromium regression on Ubuntu. Coverage/browser diagnostics are retained for 7 days; runtime ZIPs for 14 days. CI needs no Google or website credentials.

The manual release build also runs Chromium regression. Store behavior depends on the selected operation; see [releasing](RELEASING.md).

These checks do not establish:

- Switching between two real accounts, current BOSS API/login compatibility, or resolution of platform restrictions.
- Support for every operating system, Edge, or the minimum Chrome version.
- Recovery of deleted history, a platform-approved request rate, full-account history coverage, or store approval.

References: [Node coverage](https://nodejs.org/docs/latest-v24.x/api/test.html#collecting-code-coverage), [Playwright extension testing](https://playwright.dev/docs/chrome-extensions), and the [Parallel AI test workflow](https://github.com/ParkerCai/parallel-ai-extension/blob/main/.github/workflows/test.yml) that informed the fixture/test-layer organization.
