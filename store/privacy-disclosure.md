# Privacy-form guidance

[English](privacy-disclosure.md) | [简体中文](privacy-disclosure_CN.md)

This developer guidance records the 0.8.11 public-package disclosure baseline for the Chrome Web Store dashboard. It does not replace the [privacy policy](../extension-tracker/PRIVACY.md) or establish that a form was submitted. Localization work does not change the policy path or add a data-upload service.

## Single purpose

After a user manually starts it, save chats currently available on their signed-in BOSS chat page to per-account local archives, with incremental updates, export, and deletion.

## Permission reasons

| Permission | Suggested explanation |
| --- | --- |
| `activeTab` | Temporarily accesses the current chat tab after the user clicks the extension, providing page context for user-initiated archiving without persistent access to all websites. |
| `scripting` | Injects bundled read-only collection scripts into that tab, using the existing page session to read the account, conversation list, and history. Does not operate a composer, send messages, or submit applications. |
| `storage` | Stores per-account archives, incremental baselines, progress, and lightweight UI cache without chat bodies in the current browser profile, supporting persistence after the popup closes and later reads. |
| `unlimitedStorage` | Retained history, metadata, and record versions may exceed the default `storage.local` quota. This supports complete local retention of acquired records, not remote upload or broader website access. |

The public package declares neither `host_permissions` nor `optional_host_permissions`; it has no localhost debug bridge and does not request `tabs`, `cookies`, `downloads`, or system-notification permission. Downloads follow a user action in an extension page.

Remote code: **No**. Executable scripts and modules are bundled. Chat API responses are treated as data, without downloading or executing remote scripts.

## Data types and purposes

Local-only handling is still data processing that needs accurate disclosure; do not claim the extension processes no user data merely because it stays on the device. Match dashboard selections to actual behavior and the public policy. See [local-data disclosure guidance](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).

| Dashboard category | Corresponding content | Purpose |
| --- | --- | --- |
| Personally identifiable information | Account UID, conversation-party identifiers, and contact fields returned by BOSS; chats may contain names or phone numbers | Separate accounts and conversations in the user-initiated archive |
| Personal communications | Message bodies, direction, time, and API-provided image/attachment summaries | Local counts, saving, incremental deduplication, and user-initiated export |
| Website content | Conversations, messages, and available-history coverage for the chat page | Retain accessible communications and explain their available scope |

There is no payment, health-profile, or advertising-tracking feature. The extension does not read a browser-history inventory, ask for passwords/codes, or read/export browser Cookies. Messages may themselves contain other sensitive information; that content is retained as part of the selected chats without profiling, advertising, or separate analysis. If dashboard category names change, use their actual definitions rather than treating this table as the dashboard's authoritative taxonomy.

## Data handling statement

Data is used only for the disclosed local archive, incremental update, export, and deletion features. The developer has no chat-data receiving endpoint and operates no chat-upload, telemetry, advertising, or analytics service. User data is not sold or used for advertising, credit assessment, lending, or unrelated purposes, and the developer does not read chats through the extension. Sharing a manually exported file with a third party is the user's choice; the extension does not automatically share it.

Since 0.8.11, the public entry encrypts new account-archive, runtime, and conversation-record values with AES-256-GCM. A non-extractable CryptoKey is stored in the same browser profile's IndexedDB. Saves and reads are local. There is no cross-device sync, cloud recovery, or password unlock. Losing the key prevents decryption of the corresponding archive.

UIDs may appear in storage key names and lightweight UI caches. Counts, some progress summaries, and user-exported JSON/backups remain plaintext. Old plaintext can still be read; retained old roots and record versions are not scanned and rewritten, so this does not claim that every historical copy is encrypted.

Local records remain until per-account clearing, extension removal, browser-data deletion, or another storage-removal event. Users may export first and then clear the selected account's local records. Clearing does not delete website chats or downloaded files. Reinstallation or losing a profile may lose both records and key; export before cleanup when needed.

Local diagnostics retain necessary path, status, response type, stage, and count information without HTML bodies, URL query parameters, or Cookies. The public package excludes the development debug bridge.

## Limited Use statement

Use of user data is limited to the local archive, incremental update, export, and deletion described in the listing and UI, following the Chrome Web Store User Data Policy's Limited Use requirements. Data is not sold, used for advertising, passed to unrelated third parties, or made available for developer personnel to read. The extension does not transmit chats to a developer server or AI service.

The statement is included in the [privacy policy](../extension-tracker/PRIVACY.md). The developer must still verify that actual dashboard certifications match code behavior. See [Limited Use guidance](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).

## Before a future submission

- Use `https://github.com/L1pp/boss-chat-recorder/blob/main/extension-tracker/PRIVACY.md` for the privacy-policy URL, confirming public accessibility and accurate submitted-version content.
- Check data categories, single purpose, and all four permission reasons, then have the developer confirm the actual certifications. This document does not certify on their behalf.
- Confirm the support email and account information required by the dashboard.

See the official [privacy-form guidance](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) and [privacy-policy requirements](https://developer.chrome.com/docs/webstore/program-policies/privacy). Local handling, the interface, and published disclosures should remain consistent.
