# Architecture and account boundaries

[English](ARCHITECTURE.md) | [简体中文](ARCHITECTURE_CN.md)

## Local encryption introduced in 0.8.11

The account store accepts an AES-GCM adapter compatible with `storage.local`. The public startup entry enables it without changing the collector, request interval, UID partitions, commit order, or storage Port. It encrypts account roots, runtime records, and conversation-record values with a fresh random IV for each write, using the storage key and key identifier as GCM additional authenticated data. A batch is committed only after all encryption succeeds; this adds no content hashes or website requests.

The browser generates a non-extractable AES-256 CryptoKey. An IndexedDB readwrite transaction chooses and persists the single key, and the provider does not return a new key before the transaction commits. Concurrent providers reuse the committed key. `storage.local` uses `TRUSTED_CONTEXTS`; page scripts continue to use the existing runtime channel. Missing keys, damaged ciphertext, or failure to set the access level cause a local error, without replacing the key, clearing data, or falling back to plaintext writes.

Existing plaintext has read compatibility only; retained records are not migrated in bulk. UID key names, lightweight UI caches, and downloaded JSON are outside the encrypted-body scope. The key and data share one device and browser profile, so this is not isolation from a local administrator or malicious software controlling that profile.

## Collection path

The kernel retains prototype 0.7.2's contact-list reading, selection by native update time, history cursor pagination, and batch saves. After the user clicks the extension, `activeTab` permits bundled scripts on the authorized chat page. If the task is already running, the extension returns local progress. A genuinely new start confirms the account once, chooses its UID baseline, and registers a local task token. Collection runs asynchronously in the page; the popup does not own the task lifetime.

The same-origin read-only endpoints are:

| Purpose | Path | Scope |
| --- | --- | --- |
| Current account | `/wapi/zpuser/wap/getUserInfo.json` | `zpData.userId` in a successful response |
| Conversation list | `/wapi/zprelation/friend/geekFilterByLabel` | Contacts returned by the page's label 0 list request |
| Message history | `/wapi/zpchat/geek/historyMsg` | Currently available history pages for the selected contact |

Requests use the normal browser session. Code does not directly read Cookies, framework-internal storage, or browser credentials. A new start or resume confirms the account with one fresh GET; pagination, saving, progress, and local exports do not repeat that lookup. The account request uses `cache: no-store`; list and history requests use the browser's default cache policy. The adapter derives from the original project's static API research, without copying site bundle source.

All three endpoints share the background's fixed 10-second minimum interval. Requests wait locally for a slot; stopping cancels pending waits. Network timeout starts at the actual request stage. This reduces request density but does not guarantee the site will permit internal API access.

List parameters are discovered from the current page's resource request records, limited to the same origin, exact path, and label 0. There is no hard-coded personal `encryptSystemId`. History pages contain up to 20 messages and use native string message IDs and the `maxMsgId` cursor to avoid large-integer precision loss.

## Account boundaries

The account UID, recruiter UID, and message ID belong to different levels. Recruiter and message IDs can overlap across a user's accounts, so recruiter-only deduplication does not separate those accounts.

1. Each account UID has its own state, runtime, and completed-history baseline.
2. A manual start confirms the website account. Local display and export name a specific UID and do not describe the last viewed local account as the current website login.
3. A page task fixes its starting UID and token; every batch carries both.
4. The background verifies the actual sender tab, fixed UID, and live token. History messages also retain native participant checks. There is no website account lookup for each page or save. Results from an earlier task cannot be assigned to a newly confirmed account.
5. Clearing an account revokes its tokens so that asynchronous results cannot restore cleared data.
6. Legacy `bossReadonlyTracker.v2` has no reliable owning account. It is not automatically claimed, mixed into regular exports, or overwritten.

UIDs are user data. Partitioning is a correctness measure, not encryption or access control against the local user. Local storage and downloaded JSON still need appropriate care.

The popup renders counts and progress from a separate lightweight local view, without waiting for the website or loading the full chat archive. Cache updates exclude chat bodies; exports still read the selected account partition. The local collection-history flag distinguishes a genuinely new account from a completed zero-record run; tab progress and stop targets remain separate.

## Incremental collection, commits, and exports

Since 0.8.10, save communication uses the internal `bossReadonlyTracker.storage.v1` Port. Each connection carries one existing `BULK_PROGRESS` or `BULK_SNAPSHOTS` request. The background reports existing account-store begin/end activity and sends success only after the durable commit. The client uses a 15-second *inactivity* timeout rather than treating the total time of several advancing storage steps as a lost connection. There is no added website request or periodic probe. Disconnecting does not revoke an accepted write; the client does not automatically resend, and STOP still drains data already read.

Since 0.8.9, bodies use conversation records under `bossReadonlyTracker.conversations.v1:<UID>:`. Before collection first uses this layout, the account's serialized store queue organizes legacy bodies and commits an index; the original root is retained. Later snapshots read and write only the affected conversations. Exports and new-task preparation reconstruct complete state when needed. Contacts, raw samples, messages, and list rows are organized by identity, while global observations, unknown fields, and unassigned messages are preserved.

Body records use fresh random version IDs. The store registers the account-specific version list, writes new records, commits a single index, then publishes runtime and acknowledges success. Existing records are not overwritten in place. Updated statistics derive from the committed index and this change, rather than accumulating on a possibly stale runtime view. Clearing a UID removes its old root partition, published and unpublished record versions, and runtime bindings without reading other accounts or diagnostic credentials. Old versions remain until clearing; collection does not add a background cleanup job.

Since 0.8.8, high-frequency runtime is stored in `bossReadonlyTracker.accountRuntime.v1`, separately from the old `bossReadonlyTracker.accountPartitions.v1` body root. Runtime holds UID partitions, bindings, progress, baselines, and committed summaries, rather than complete chat state. Native contact metadata in a baseline may include conversation previews. Popup opening, progress polling, and ordinary progress saves do not reread bodies. One-time bootstrap reads the original local partition; old body-embedded runtime and tokens are not later recovery sources.

All account-store operations share a serial queue. A body batch merges its transaction copy and persists it before publishing runtime and acknowledging success. Multiple writes are not assumed to be one atomic transaction. A failed publication can be retried while messages remain deduplicated by native IDs. Even the first failed publication retains already persisted bodies without reviving an old binding. Exports and task preparation read bodies as needed and overlay current runtime.

A conversation is skipped only for the same account and native contact, with previously completed history and unchanged native `updateTime`. Otherwise the collector reads currently available history again. Saves update messages by ID; observations lacking an ID remain observations and cannot be claimed as deduplicated messages.

`hasMore=false` establishes only the endpoint's current history boundary for that conversation. The contact list does not establish all-time account coverage. State retains interruptions, failures, and coverage limits. The earliest available message is not presented as the first-ever message, and a historical message saved for the first time is not described as new communication that day.

HTML responses, unsuccessful API results, and single-request timeouts stop the run while retaining saved pages and progress. A recognized verification page records `SITE_VERIFICATION_REQUIRED` and shows a verification badge. It is a pause reason in ordinary task progress, not a separate verification gate or trial mode.

After completing verification manually on the website, the user uses the normal start/resume flow. `RESUME_AFTER_VERIFICATION` remains a compatibility alias only. There is no extra confirmation, verification probing, or automatic retry. Normal new progress replaces the earlier pause; another verification response pauses again. Existing UID and token boundaries still apply.

Latest-update exports select conversations actually read and saved in that run and include their full saved context. All-record exports traverse only the selected account. Exporting does not call a model or generate recruitment judgments.

## Interface languages

The popup supports Simplified Chinese and English. Chinese browser locales initially select Chinese and all other or missing locales select English; an explicit switch is remembered locally and updates interface text without changing chat facts, account partitions, or collection behavior. Developer documentation defaults to English and retains linked Chinese versions. Localization is not a request to translate or upload stored messages.

Browser-managed extension names and descriptions use Chrome's extension-localization mechanism. The popup's manual switch does not promise to change those browser fields at the same time.

## Public-source scope

The public copy includes API collection, account storage, the fact model, JSON exports, and synthetic tests. Earlier DOM recording, CDP collection, SQLite development archives, and prototype control bridges are not imported. The temporary local debug bridge and localhost optional permissions are absent; the internal save Port and actual storage-activity acknowledgements remain.
