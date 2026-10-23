# Testing and evidence boundaries

[English](TESTING.md) | [简体中文](TESTING_CN.md)

Tests have two layers: Node offline regression for data and control logic, and isolated Chromium for native extension APIs, encrypted storage, and browser lifecycle. Both use synthetic data. They do not log in to BOSS, read a personal browser profile or real chats, or connect to the store.

## Node offline regression

Use Node.js 24 or later. No third-party dependency installation is required for this layer:

```sh
npm test
npm run check
```

Tests cover conversation selection, message deduplication, pagination and pauses, account partitions, rejection of late writes, export scope, commit and recovery behavior, popup state, and synthetic HTTP responses for the release client. They use replacement Chrome APIs, DOM, IndexedDB, or fetch implementations. They do not replace native-browser or live-platform acceptance.

`check` checks committed bundles against generated source, public file scope, licenses and versions, synthetic examples, and a limited set of sensitive patterns. It does not connect to external sites and cannot establish that every type of personal information has been detected. `node_modules/`, reports, coverage, and `dist/` are ignored generated directories. Extension ZIPs use an explicit list of public runtime files.

## Coverage

```sh
npm run test:coverage
```

Node's native V8 coverage produces a console summary and `coverage/lcov.info`. It describes `extension-tracker/` and `scripts/` files actually executed by that Node run. Unloaded files may not appear, and code executed through a VM or data URL may not map back to source files. Chromium tests are not part of this report. Use it to find untested logic, not as a project correctness percentage or platform compatibility rate. No percentage threshold gates a pass.

## Chromium synthetic regression

Install the test tools and Chromium once:

```sh
npm ci --ignore-scripts
npm run test:browser:install
npm run build
npm run test:browser
```

On Linux, missing browser system libraries can be installed with `npm run test:browser:install -- --with-deps`. The install/test wrappers share this project's `node_modules/.cache/boss-browser/`; they do not clear a shared Playwright cache. Browser profiles are new directories in the system temporary directory. Playwright is a development dependency and is absent from the store ZIP.

Tests load the extension using the public package list and seed two repository synthetic accounts through production storage modules. They verify:

- Protected archive values in native `chrome.storage.local` are ciphertext; the native IndexedDB AES-GCM CryptoKey is non-extractable; the popup displays local cache data.
- The actual browser display of first-collection guidance, primary actions, and archive controls with empty and existing synthetic caches, including synthetic screenshots.
- Real browser-language selection (Chinese, English, and an unsupported language falling back to English), immediate popup switching, locally remembered preference across a cold restart, and unchanged Chinese message exports. Node regressions additionally cover in-flight actions, recovery after errors, and late preference reads.
- A `zh-TW` browser selects the Chinese UI and metadata. Rapid language choices are persisted before popup closure even when the first native storage acknowledgement is artificially delayed; the native writes themselves still commit. Node tests also assert translated accessibility attributes, the refresh tooltip, and the clear-confirmation text without deleting records.
- Exports and clearing remain account-specific when two synthetic accounts reuse recruiter and message IDs.
- A real worker stop and wake, followed by completely closing Chromium and reopening the same temporary profile, preserves readable/exportable records without reseeding.

Export and clearing calls come from a real extension page using production modules; cache display uses `popup.html`. The current headless harness does not expose an automatable toolbar action-popup view, so a successful action-popup-to-worker message round trip is not covered by this current automated browser suite. Node tests cover those message handlers. Earlier one-off native acceptance is recorded separately in [verification](VERIFICATION.md).

Browser tests block external network access and do not start collection. Cleanup removes only temporary directories created by that run after checking their paths; no personal Chrome or Edge profile is used.

On failure, synthetic screenshots and traces are retained. The HTML report is in `playwright-report/` and attachments in `test-results/`; use `npx playwright show-report` to open it. Tests do not automatically retry, compare screenshots pixel by pixel, or impose a fixed-second performance threshold.

## GitHub Actions

Pushes and PRs run:

- Node 24 offline tests, coverage, public-source checks, and ZIP packaging on Ubuntu and Windows.
- Chromium synthetic regression with the extension actually loaded on Ubuntu.
- Coverage and browser diagnostics retained for 7 days, and public runtime ZIP artifacts retained for 14 days. CI needs no Google identity, release token, or real website account.

The manual release workflow's build stage also runs browser regression. Upload and review submission run only when the respective operation is explicitly selected and tests pass. `status` only queries the store; it does not run browser tests, upload, or submit. See [releasing](RELEASING.md).

## Remaining manual boundaries

- Synthetic Chromium isolation does not establish successful switching between two real accounts.
- Offline pagination and incremental tests do not establish current BOSS API, login, or platform-restriction compatibility.
- Passing on the current Chromium does not establish support across every operating system, Edge, or the minimum Chrome version.
- Passing tests do not recover deleted website history, establish a platform-approved collection rate, or constitute store approval.

References: [Node test coverage](https://nodejs.org/docs/latest-v24.x/api/test.html#collecting-code-coverage) and [Playwright extension testing](https://playwright.dev/docs/chrome-extensions). The separation of test layers and local fixtures also drew on [Parallel AI's test workflow](https://github.com/ParkerCai/parallel-ai-extension/blob/main/.github/workflows/test.yml).
