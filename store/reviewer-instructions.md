# Reviewer notes

[English](reviewer-instructions.md) | [简体中文](reviewer-instructions_CN.md)

Baseline version: **0.8.11**. Name: **BOSS 沟通记录本地助手**. Minimum Chrome: **102**. The additional 0.8.12 UI notes below describe an unreleased candidate, not a submitted store update.

This unofficial personal archiving extension reads only chats currently available on the user's signed-in BOSS chat page after a manual start. It saves per-account records locally and exports JSON. It does not send messages, submit resumes, or bypass login or manual verification.

## Installation and operation

The store ZIP has `manifest.json` at its root. For unpacked testing, extract runtime files into a separate directory and choose **Load unpacked** in extension management. A separate browser profile avoids mixing test and everyday archives.

A fresh 0.8.11 installation shows an empty local state. Popup opening, local-state refresh, exports, and clearing use local records without additional BOSS requests. The displayed account is the selected local archive account, not a fresh website-login confirmation.

A normal live-platform workflow requires a BOSS account that the reviewer is authorized to use and a normal signed-in page:

1. Sign in on the website and open [the chat page](https://www.zhipin.com/web/geek/chat). Wait for its own conversation list to load.
2. Open the extension and start collection. In 0.8.11 this action is labeled “更新变化会话”. The extension confirms the starting account and requests list/history pages at the fixed minimum interval. The stop action is available.
3. After completion, export all records. This only downloads JSON; it does not connect to an AI service.
4. Start another incremental update. Conversations with unchanged native timestamps and completed history are skipped. Changed or incomplete conversations reread the currently available history.
5. If the website requires verification, the extension pauses and retains records. Complete verification manually on the website, then continue. The extension does not automatically probe the result.

The developer's everyday account credentials and real chats are not included. If reviewers cannot access the website, record that limitation and contact the developer for appropriate test conditions. Synthetic examples do not replace website login.

### Unreleased 0.8.12 interface

First use has a dedicated collection guide and chat-page link, rather than calling an empty archive an update. Existing records offer an incremental update, and interrupted runs offer continuation. The popup supports Chinese and English, initially uses Chinese for Chinese browser locales and English for all other or missing locales, and remembers an explicit local language choice. Saved message content is not translated. This section does not claim that the 0.8.11 artwork already shows the new interface.

## Synthetic acceptance and encryption

The 0.8.11 preparation used an isolated browser profile and two synthetic accounts without a real-account connection. Actual results, browser version, and completed scope are in [acceptance-0.8.11.json](acceptance-0.8.11.json). Planned steps must not be described as completed results.

Acceptance checked ciphertext archive values, a non-extractable key, reading after worker restart, and reading after completely closing and reopening the same browser profile. Synthetic records were not reseeded after restart, so persistence failures could be detected.

Store screenshots show synthetic data in the actual extension and are marked “合成演示数据”. The repository also contains `examples/index.html` and synthetic JSON for offline account/export demonstrations; that page is not a chat browser built into the extension. `npm test` and `npm run check` use offline data and do not request BOSS.

## Storage and permissions

The public runtime package uses only `activeTab`, `scripting`, `storage`, and `unlimitedStorage`. It has no persistent website permission, localhost debug bridge, or remote code. Injected scripts are bundled with the extension, and requests use the website's existing session. The extension does not read or export Cookies.

New archive writes use local AES-256-GCM. A non-extractable key is automatically stored in the same profile's IndexedDB, without password steps. UID key names, lightweight UI summaries, and user-downloaded JSON are outside the encrypted-body scope. Existing plaintext remains readable without whole-library migration. This protection does not defend against control of the browser profile or operating system and provides no cross-device recovery.

See [verification](../docs/VERIFICATION.md) for real-platform scope. Synthetic acceptance does not add real-account tests or establish two-real-account switching.

## Developer follow-up

Privacy policy: `https://github.com/L1pp/boss-chat-recorder/blob/main/extension-tracker/PRIVACY.md`. Confirm the developer's support email and any dashboard-required identity or test information before a future submission. This document contains no passwords, verification codes, login Cookies, pairing tokens, or real chats.
