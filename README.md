# BOSS Chat Recorder · BOSS 沟通记录

[English](README.md) | [简体中文](README_CN.md)

[![Automated tests](https://github.com/L1pp/boss-chat-recorder/actions/workflows/ci.yml/badge.svg)](https://github.com/L1pp/boss-chat-recorder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A local-first Chrome / Edge extension for saving the conversations and message history currently available to a user on their signed-in BOSS chat page. It keeps separate local account archives, updates changed conversations, and exports message facts as JSON for analysis with a service chosen by the user.

BOSS primarily serves Chinese-speaking users. Developer documentation uses English by default, with Chinese entry points; the extension supports Simplified Chinese and English. On first use, Chinese browser locales select Chinese; all other or missing locales select English. Users can switch languages in the popup. The choice is remembered locally. Website messages and exported chat content retain their original language.

The popup switch changes popup text. Browser-managed extension names and descriptions follow Chrome's localization choice independently.

The last published store version documented here is **0.8.11**: [Chrome Web Store](https://chromewebstore.google.com/detail/phaihpchfdihnclgjhpmpnhobdcogdhb). Source **0.8.12 is unreleased** and includes first-collection guidance and bilingual interface work. A merged PR or a successful CI build does not publish a store update.

## Try the synthetic demo

Open [examples/index.html](examples/index.html) directly in a browser. No extension installation, recruitment-platform login, or server is needed. Switch between two fictional accounts and inspect all-record, latest-update, and no-change exports. Its interface has Chinese and English options while the fictional chat content stays in its original Chinese. The demo choice applies within that page, without promising persistence. The preview makes no network requests.

The accounts deliberately reuse a recruiter ID and a message ID while keeping different contents. The fixtures also include media summaries, incomplete history, and unknown sending times. See the [generator](scripts/generate-demo.mjs) and [JSON fixtures](examples/demo-data/). This page demonstrates archive and export semantics; it is not a screenshot of a live website or an extra chat browser built into the extension.

## What it does

- **History pagination:** follows native message cursors until `hasMore=false`, with stalled-cursor and page-limit handling.
- **Conversation-level updates:** skips a conversation only when its native update time is unchanged and its previously available history was completed. New, changed, and incomplete conversations are read again.
- **Account separation:** confirms the signed-in UID once when a collection run actually starts. Messages, contacts, baselines, and progress stay in that UID's local partition. Later saves use local task bindings and native participant IDs.
- **Local persistence:** uses `chrome.storage.local`. Collection continues after the popup closes; refreshing or closing the chat page interrupts it, and a later update can resume unfinished work.
- **Fact exports:** preserves message IDs, direction, native sending times or original labels, media summaries, and coverage limits. A latest-update export includes the full saved context of the conversations collected in that run; a no-change export does not repeat the full archive.
- **Per-account clearing:** deletes the selected local account partition and revokes its tasks so that late results cannot restore cleared records.
- **Pause on errors or verification:** HTML responses, unsuccessful API responses, and timeouts stop the run and retain saved pages. A recognized verification page shows a badge; the user completes verification on the website, then resumes through the normal collection flow. There is no automatic verification probing or retry.
- **Minimal website requests:** opening the popup, reading progress, exporting, and backing up use local data. Account, list, and history requests share a fixed minimum interval of 10 seconds; pending waits can be stopped.
- **Chinese and English UI:** the popup supports initial browser-language selection (Chinese for Chinese locales, English otherwise) and a local language switch. Translation changes interface text, not saved chat facts.

The extension does not upload records to an AI service. Users choose whether and where to share an exported file.

## Storage and privacy

New archive writes in the public entry point use local AES-GCM encryption. The browser automatically persists a non-extractable key; there is no password or unlock step. Storage access is restricted to trusted extension contexts. Existing plaintext remains readable and is not automatically migrated across the entire archive. Storage key names, lightweight UI summaries, and downloaded JSON are outside the encrypted-body scope.

The key and data live in the same browser profile. This protects stored values without providing isolation from software or an administrator controlling that device. Export before deleting browser data if you need to keep your records.

This public repository contains source, tests, and hand-authored synthetic data. It excludes real chat exports, personal job-search documents, credentials, and the temporary development debug bridge. The later historical single-account export held 378 conversations and 3,697 messages in total, including 3 conversations and 63 messages added since the preceding 375-conversation / 3,634-message export, without losing or duplicating earlier messages. These are historical observations, not a guarantee of current site compatibility. Two-real-account switching remains deferred; synthetic isolation tests are retained.

Read the [privacy policy](extension-tracker/PRIVACY.md) and [verification scope](docs/VERIFICATION.md).

## Architecture

The collector retains the default API implementation of prototype **0.7.2**: same-origin GET requests, history cursors, conversation selection, and batch saves. Local account partitions, request pacing, and exception pauses surround that kernel. It does not depend on the site's private Axios client.

```text
popup -> service worker -> bundled collector on the current chat page
                         -> one account UID confirmation at startup
                         -> contact list / paginated history
                         -> UID-separated local storage
                         -> selected-account JSON export
```

| Component | Implementation |
| --- | --- |
| Extension | Manifest V3; native HTML, CSS, and JavaScript |
| Collection | Same-origin GET with the browser's existing session; no direct Cookie access |
| Background | Service worker, trusted-sender checks, serialized storage, task tokens |
| Storage | `chrome.storage.local`; no local server needed for archiving |
| Build and tests | Node.js built-ins and `node:test`; no third-party runtime dependencies |

See [architecture and account boundaries](docs/ARCHITECTURE.md).

## Build and test

Use Node.js 24 or later. Building the extension and running Node tests do not require installing third-party dependencies.

```sh
npm run build
npm run demo
npm test
npm run check
```

`build` generates the extension bundles in this repository; `build:check` compares generated output without changing files. `demo` regenerates synthetic fixtures. Node tests use simulated network and Chrome APIs and do not access BOSS, personal browser profiles, or the original project's data.

GitHub Actions runs Ubuntu / Windows offline checks and isolated Chromium regression on pushes and PRs. Coverage and failure diagnostics are artifacts, without a coverage-percentage merge threshold.

For native browser storage and restart tests:

```sh
npm ci --ignore-scripts
npm run test:browser:install
npm run test:browser
```

These tests load the real extension into new temporary profiles with synthetic data and block external network access. See [testing and evidence boundaries](docs/TESTING.md), [contributing](CONTRIBUTING.md), [security reporting](SECURITY.md), and the [changelog](CHANGELOG.md). Chinese contributions and issue reports are welcome; see [参与贡献](CONTRIBUTING_CN.md) and [安全报告](SECURITY_CN.md).

Configured AI reviews provide additional feedback when their trigger conditions apply. They do not automatically approve, merge, or publish; see [AI review](docs/AI_REVIEW.md).

## Load the extension locally

1. Build the extension.
2. Open `chrome://extensions` or `edge://extensions` and enable Developer mode.
3. Choose **Load unpacked** and select this repository's `extension-tracker/` directory.
4. Sign in normally on a BOSS account you are authorized to use, then open the [BOSS chat page / BOSS 沟通页](https://www.zhipin.com/web/geek/chat).
5. Open the extension and start the first collection. Later runs update changed conversations; a paused run offers a resume action.

If you still use an older prototype, load this copy separately. Do not overwrite it or copy its storage. Unpartitioned legacy records are not automatically claimed or imported. Separate extension installations and browser profiles have separate data.

The account shown in the popup is the selected **local archive account**, not a fresh check of the website login. A new collection stops if the account cannot be identified, the site returns an error, or native message participants do not match. List parameters are discovered from same-origin list requests already made by the page, without hard-coded personal account parameters. If none are available yet, refresh the chat page and wait for its normal list to load.

If website verification is required, complete it manually on the BOSS page, then use the popup's resume action. If verification is still required, the run pauses again. You do not need to uninstall the extension, clear saved records, or rebuild the baseline. Reloading the same unpacked installation preserves its local storage.

## Release workflow

Public changes go through focused PRs, configured CI and review, and merge to `main`. The manual [release workflow](docs/RELEASING.md) can then build the formal package. Its default `build` operation does not contact the store; `status` is read-only, `upload` writes a draft, and `publish` uploads and submits for review. GitHub Release creation is a separate optional choice, off by default. Several focused PRs may be combined into one later release.

## Limits

- Completed available history means the conversations returned by the current list request and each conversation's available history endpoint. It does not recover deleted or unavailable records or establish full-account coverage.
- Message direction uses native participant IDs. Unknown time remains unknown; collection time is not substituted for sending time.
- Attachments retain only fields and summaries returned by the API. There is no automatic media download, OCR, transcription, or attachment-content analysis.
- The extension depends on internal website APIs. Earlier real use encountered verification, user-reported logout on web and mobile, and local save timeouts. Later successful collection does not establish that platform restrictions have been solved.
- The 10-second interval is a conservative project setting, not a platform-approved safe rate. Internal API use and repeated pagination may still be restricted. The extension does not disguise the browser or bypass verification, login, or access limits.
- This is an unofficial project, without BOSS authorization or endorsement. Use it only within applicable authorization and platform rules.

## Repository layout

```text
extension-tracker/       Loadable extension, storage, fact model, and exports
scripts/                Collector sources, build, demo, and release helpers
tests/                  Offline and synthetic browser tests
examples/               Synthetic JSON and standalone offline preview
docs/                   Architecture, development, provenance, and verification
store/                  Listing drafts, synthetic artwork, and reviewer guidance
```

## License and provenance

[MIT License](LICENSE). The API collection implementation was organized from local prototype 0.7.2; see [code provenance](docs/PROVENANCE.md). No real site responses or personal account parameters are included.
