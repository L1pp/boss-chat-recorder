# Privacy-form guidance

[English](privacy-disclosure.md) | [简体中文](zh-CN/privacy-disclosure.md)

Use this guide for the Chrome Web Store dashboard. Material and version status are in the [index](README.md); the published disclosure is the [privacy policy](../extension-tracker/PRIVACY.md).

## Single purpose

After a manual start, save chats available on the user's signed-in BOSS chat page to per-account local archives, with incremental updates, export, and deletion.

## Permissions and remote code

| Permission | Suggested explanation |
| --- | --- |
| activeTab | Temporarily accesses the current chat tab after the user clicks the extension, providing context for user-initiated archiving. |
| scripting | Injects bundled read-only scripts to read the account, conversation list, and history through the existing page session; does not send messages or submit applications. |
| storage | Saves per-account archives, incremental baselines, progress, and a lightweight UI cache without chat bodies in the current browser profile. |
| unlimitedStorage | Retained history, metadata, and record versions may exceed the default storage.local quota. This permission supports local retention, not upload or broader website access. |

The public package declares no persistent host permissions, contains no localhost debug bridge, and requests no tabs, cookies, downloads, or system-notification permission. Downloads follow a user action.

Remote code: **No**. Executable scripts and modules are bundled; website API responses are handled as data.

## Data types

Local-only processing still requires disclosure. Use the dashboard's actual category definitions and match selections to the package and policy. See Google's [user-data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).

| Category | Content and purpose |
| --- | --- |
| Personally identifiable information | Account UID, conversation-party identifiers, and returned contact fields; separate local accounts and conversations. Chats may also contain names or phone numbers. |
| Personal communications | Message bodies, direction, time, and API-provided image/attachment summaries; save, deduplicate, count, and export records. |
| Website content | Conversations, messages, and available-history coverage; retain accessible records and describe their scope. |

The extension does not ask for passwords or codes, read/export browser Cookies, or read a browser-history inventory. Sensitive information written in chats remains part of those chats; it is not separately profiled or analyzed.

## Storage and retention

New archive, runtime, and conversation values use local AES-256-GCM with a non-extractable CryptoKey in the same profile's IndexedDB. There is no password unlock, cross-device sync, or cloud recovery. Losing the key prevents decryption.

UID key names, lightweight caches, counts, some progress summaries, and user-exported JSON/backups may remain plaintext. Legacy plaintext stays readable; retained old copies are not rewritten, so not every historical copy is encrypted.

Records remain until account clearing, extension removal, browser-data deletion, or another storage-removal event. Clearing does not delete website chats or downloaded files. Export before removing a profile or its storage when records are needed.

Local diagnostics retain necessary paths, status, response type, stage, and counts without HTML bodies, URL query parameters, or Cookies.

## Limited Use statement

Data serves only the local archive, incremental update, export, and deletion described in the listing and UI, following Chrome Web Store Limited Use requirements. The developer has no chat-data receiving endpoint, telemetry, advertising, or analytics service. Data is not sold, used for advertising, passed to unrelated third parties, or made available for developer personnel to read. The extension does not transmit chats to a developer server or AI service. Sharing a manually exported file is the user's choice.

Before submission, confirm that dashboard certifications match the package and policy. The stable policy URL and account-owner items are in the [index](README.md). References: [privacy form](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [privacy-policy requirements](https://developer.chrome.com/docs/webstore/program-policies/privacy).
