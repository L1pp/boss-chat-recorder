# Architecture and account boundaries

[English](ARCHITECTURE.md) | [简体中文](zh-CN/ARCHITECTURE.md)

## Collection path

```text
popup → service worker → bundled collector on the authorized chat page
                       → account UID → contact list → paginated history
                       → UID-scoped local archive → JSON export
```

After a user click, `activeTab` permits bundled scripts on the current chat page. A new start or resume confirms the account once, selects its UID baseline, and registers a task token. An already-running task returns local progress. Collection runs asynchronously in the page and continues after the popup closes.

| Purpose | Same-origin read-only endpoint | Scope |
| --- | --- | --- |
| Account | `/wapi/zpuser/wap/getUserInfo.json` | `zpData.userId` from a successful response |
| Conversation list | `/wapi/zprelation/friend/geekFilterByLabel` | Contacts in the page's label 0 list request |
| History | `/wapi/zpchat/geek/historyMsg` | Currently available pages for the selected contact |

Requests use the normal browser session without directly reading Cookies, framework storage, or credentials. The account GET uses `cache: no-store`; list and history use the browser's default cache policy. Pagination, saves, progress, and exports do not repeat the account lookup.

List parameters come from the page's resource request records, restricted to the same origin, exact path, and label 0; no personal `encryptSystemId` is hard-coded. History pages contain up to 20 messages. Native message IDs and the `maxMsgId` cursor stay strings to avoid large-integer precision loss.

All three endpoints share a fixed minimum interval of 10 seconds. Requests wait locally for a slot; stopping cancels pending waits, and network timeout starts when the request begins. This project setting does not establish a platform-approved rate.

## Account and task boundaries

Account UID, recruiter UID, and message ID are distinct identities; recruiter and message IDs can overlap across accounts.

- Each account has separate state, runtime, and completed-history baselines. Local display and export name the selected archive UID rather than claiming it is the current website login.
- Each page task fixes its starting UID and token. Every batch carries both; the background checks the actual sender tab, fixed UID, and live token, while history messages retain native participant checks.
- An earlier task cannot write into a newly confirmed account. Clearing an account revokes its tokens and removes its data so late results cannot recreate it.
- Unpartitioned legacy `bossReadonlyTracker.v2` has no reliable owner. It remains unclaimed, outside regular exports, and is not overwritten.

The popup reads a lightweight local view rather than the full archive. Its cache excludes chat bodies; native baseline metadata may still contain conversation previews. A collection-history flag distinguishes a new account from a completed zero-record run. Tab progress and stop targets stay separate. UID partitioning provides data correctness, not access control against the local user.

## Incremental collection and JSON semantics

A conversation is skipped only when the account and native contact match, its available history was previously completed, and native `updateTime` is unchanged. Other conversations are read again. Messages are updated by native ID; records without IDs remain observations.

`hasMore=false` establishes the endpoint's current history boundary for that conversation. The contact list does not prove all-time account coverage. Interruptions, failures, and coverage limits remain in state.

HTML responses, unsuccessful API results, and request timeouts stop the run while retaining saved pages and progress. A recognized verification page records `SITE_VERIFICATION_REQUIRED` and shows a badge. After manual website verification, the ordinary start/resume flow continues; `RESUME_AFTER_VERIFICATION` is a compatibility alias. There is no verification probe or automatic retry.

JSON exports preserve these distinctions:

- Latest-update export selects conversations actually read and saved in that run, with their full saved context. A completed no-change run exports no conversations. If no update record exists, the export explicitly identifies its fallback to all saved conversations.
- All-record export traverses only the selected account. Exporting performs no model call or recruitment classification.
- Message direction follows native participants. Explicit sending times and original labels are retained; unknown absolute time stays unknown. Observation time is not substituted for sending time.
- Newly saved data may be old history. The earliest available message is not necessarily the first-ever message.
- Media fields are API summaries, without automatic download, OCR, transcription, or inference about unread attachment contents.

See the [synthetic examples](../examples/index.html) for these export scopes.

## Durable local storage

| Storage key | Role |
| --- | --- |
| `bossReadonlyTracker.accountRuntime.v1` | UID partitions, task bindings, progress, baselines, committed summaries |
| `bossReadonlyTracker.conversations.v1:<UID>:` | Versioned conversation bodies |
| `bossReadonlyTracker.accountPartitions.v1` | Retained legacy body root |

All account-store operations share a serial queue. On first use of conversation records, the queue organizes legacy bodies and commits an index before switching layouts; the original root is retained. Runtime bootstrap reads the old local partition once. Old body-embedded runtime and tokens are not later recovery sources.

Each body batch merges a transaction copy and follows this order:

1. Register the account's fresh random record-version IDs.
2. Write new conversation records without overwriting old versions.
3. Commit one index.
4. Publish runtime and acknowledge success.

Separate storage writes are not one atomic transaction. Statistics derive from the committed index and current change. If runtime publication fails, persisted bodies remain available and retry remains deduplicated by message ID, without reviving old bindings. Exports and task preparation reconstruct bodies as needed and overlay current runtime; popup reads and ordinary progress saves do not reread bodies. Identity-grouped records retain global observations, unknown fields, and unassigned messages.

Clearing a UID removes its root partition, published and unpublished record versions, and runtime bindings without reading other accounts. Old versions otherwise remain until clearing; collection has no background cleanup job.

The internal `bossReadonlyTracker.storage.v1` Port carries one `BULK_PROGRESS` or `BULK_SNAPSHOTS` request per connection. The background reports storage begin/end activity and confirms success only after durable commit. The client uses a 15-second inactivity timeout. Disconnecting does not revoke an accepted write or trigger an automatic resend; STOP drains data already read. This communication adds no website requests or periodic probes.

## Local encryption

The public startup entry injects an AES-GCM adapter compatible with `storage.local`. Account roots, runtime records, and conversation-record values use a fresh random IV per write, with the storage key and key identifier as authenticated additional data. A batch reaches storage only after all encryption succeeds.

The browser creates a non-extractable AES-256 CryptoKey. An IndexedDB readwrite transaction selects and persists one key before returning it; concurrent providers reuse the committed key. `storage.local` uses `TRUSTED_CONTEXTS`, with page scripts using the existing runtime channel. A missing key, damaged ciphertext, or access-level failure stops locally without replacing the key, clearing data, or falling back to plaintext writes.

Retained plaintext is readable for compatibility and is not migrated in bulk. UID key names, lightweight caches, and downloaded JSON are outside encrypted-body scope. The key and data share a browser profile; this does not isolate them from an administrator or software controlling that profile.

## Languages and public scope

Chinese browser locales initially select Simplified Chinese; other or missing locales select English. A manual popup choice is remembered locally. It changes interface text while preserving message language and collection behavior. Browser-managed names and descriptions use Chrome's localization mechanism independently.

The public source contains API collection, account storage, the fact model, JSON exports, and synthetic tests. Earlier DOM/CDP collectors, SQLite archives, prototype control bridges, the temporary local debug bridge, and localhost optional permissions are excluded. Implementation history belongs in the [changelog](CHANGELOG.md); historical acceptance and its limits are in [verification](VERIFICATION.md).
