# Verification and reproducibility

[English](VERIFICATION.md) | [简体中文](zh-CN/VERIFICATION.md)

Recorded results belong to the versions and dates below. **0.8.12 is an unreleased source candidate**; its first-collection and bilingual UI work uses synthetic fixtures and isolated profiles, without a new real-account acceptance run or store submission. Current checks and reproduction commands are in [TESTING.md](TESTING.md).

Only one real account was available. Offline account/store/worker tests and two-account synthetic browser tests do not establish two-real-account switching. Real exports, real account UIDs, and diagnostic logs are excluded from this repository. Historical bridge observations came from a separate development copy; the public extension contains no debug bridge.

## Real collection: 0.8.10, 2026-10-17

Real Chrome resumed an interrupted run from retained records and completed it. This was not an uninterrupted empty-library collection. A later independent run had a new run ID and `mode=incremental`.

| Evidence | Recorded result |
| --- | --- |
| Completed collection | 375/375 returned conversations; 3,634 messages with IDs; 0 failures |
| Final state | `completed`, `active=false`, `finalizing=false`, completion time present, no error |
| Independent increment | About 6 seconds; scanned/skipped 375/375; selected, refreshed, newly saved messages, and failures all 0 |
| Latest-update export | `mode=incremental`, `scope.noChanges=true`, empty conversations |
| All-record export after increment | 375 conversations / 3,634 messages, matching the baseline |
| Identity/fact comparison | By account/conversation/message ID: 0 added, lost, or duplicate; 0 changes to direction, content, time, media, or other message facts |

Each returned conversation reached the endpoint's available history end. Both all-record exports had no duplicate conversations or messages missing IDs and retained `fullAccountCoverageVerified=false`. Available history does not establish all-time, full-account coverage. The independent increment contained no new or changed conversations.

## Later export comparison: 2026-10-18

After an archive update, diagnostic state and the all-record export both held **378 conversations / 3,697 messages with IDs**. The comparison found **3 new conversations and 63 new messages across 14 archived conversations**, including one platform job-assistant conversation. No prior conversation or message was lost, identity combinations were unique, and one existing message's time field changed.

This establishes natural additions and changes in the later export. Its final run metadata says scanned 377, skipped 377, newly saved 0: the 63 additions cannot all be attributed to that last run, and 378 saved conversations are not the same denominator as 377 returned list entries.

## Native encryption and restart: 0.8.11, 2026-10-18

The public entry encrypts new archive, runtime, and conversation-record values with AES-GCM and persists a non-extractable key in the profile's IndexedDB. Old plaintext remains readable without whole-library migration; the separate development entry retained its original storage behavior.

| Isolated Chromium 151.0.7922.34, network disabled | Recorded result |
| --- | --- |
| Repository synthetic accounts | 2 conversations / 4 messages and 2 conversations / 3 messages |
| Native storage | All 10 known protected values had ciphertext envelopes; IndexedDB CryptoKey was non-extractable |
| One-off native action popup | Normal read/export messages returned matching counts without account mixing |
| Worker stop/wake | Observed `runningStatus=stopped`; wake retained the key, ciphertext, and read/export counts |
| Full browser restart | Same persistent test profile, no reseeding; key, ciphertext, and counts unchanged |

See [acceptance-0.8.11.json](../store/acceptance-0.8.11.json). This used native extension APIs, without a personal browser profile or real BOSS account. It did not verify retained-real-archive migration, two real accounts, or other browser versions such as Chrome 102. This one-off popup acceptance is distinct from the automated headless suite's scope.

Store screenshots use synthetic data in the actual public extension, with explanatory framing composed in the test browser. After artwork was added, the same tests and builds passed; public/development file checks covered 86/96 allowed files. PNG dimensions were checked, including 16/32/48/128-pixel manifest icons.

## Historical offline checkpoints

All test totals below passed with 0 failures. Counts describe different source snapshots, not one fixed suite. The 0.8.0–0.8.5 records are dated 2026-10-17 on Windows (Node.js 24.19.0 where recorded).

| Snapshot | Tests passed | Allowed-file check | Main scope |
| --- | --- | --- | --- |
| 0.8.0 | 55 | 50 | Mock APIs; VM integration of generated bundles and worker; deterministic demo/build. Recorded independent review found no remaining blockers after the reported race fixes. |
| 0.8.1 | 91 | 54 | HTML/HTTP/API pause, stop/save handshake, recovery, and retained checkpoints. No complete live baseline at that point; per-operation identity reads were later replaced. |
| 0.8.3 | 105 | 55 | Persisted verification pause, badge, manual continuation, repeated verification, and recovery. Changed live branch was still pending. |
| 0.8.4 | 118 | 58 | Shared 10-second interval and local popup cache. Three simulated starts made three identity requests; local operations made none. No live retest. |
| 0.8.5 | 113 | — | Prototype 0.7.2 API kernel; removed separate trial/verification gates, obsolete rechecks, and total conversation deadlines. No real-account test in that change. |
| 0.8.6 | 146 | 67 | Core-save acknowledgement separated from badge/cache refresh; development-only diagnosis. |
| 0.8.7 | 152 | 67 | Fewer binding/partition reads and copies; atomic binding and schema retained; failed commits preserve prior messages. |
| 0.8.8 | 161 | 67 | Runtime/body separation with synthetic 17 MiB bodies; restart and failed-publication retries. |
| 0.8.9 | 171 | 71 | Per-conversation versions and account index with synthetic 22 MiB bodies; failed commits, UID 1/10 clearing, retries, and unknown data. |
| 0.8.10 | 182 | 75 | Port activity/inactivity, disconnect/cancel, sender/binding checks, stop/drain, and generated-bundle integration. |
| Public copy without diagnostics / development copy | 158 / 192 | — | Public startup, bundle/worker integration, increment/export, and synthetic isolation. |
| 0.8.11 public / development | 175 / 209 | 86 / 96 | 17 added cases: WebCrypto round trips, large text, IV/AAD, preservation on failure, key concurrency/commit, restart, clearing, and access scope. |

The diagnostic-free public copy was generated from an explicit source list without overwriting the active extension or real data. It removed pairing, temporary diagnostic messages, the bridge, and localhost optional permission while retaining the same kernel, UID partitions, pacing, and save-activity acknowledgements. Its startup differences were tested offline; the real collection above used the same-kernel development copy.

## Local-save diagnosis and fixes

These observations explain storage changes, not why the website requested verification or logged the user out.

| Version | Recorded observation and outcome |
| --- | --- |
| 0.8.6 | First progress ACK 8.91 s; later ACK 19.845 s exceeded a 15 s wait. Stop reported `interrupted/BULK_CHECKPOINT_FAILED`, discovered 370/completed 0; existing records and message counts were unchanged. The paired development bridge supported status/logs/storage/stop, without chat bodies or remote start. |
| 0.8.7 | Early progress ACKs about 3.2–5.7 s and first snapshot about 4.0 s; three batches advanced, but later saves still timed out. These were partial-run observations. |
| 0.8.8 | Previous progress operations moved about 17.1 MiB of bodies; a post-interruption ACK took 28.378 s, with the original trigger missing from the rolling trace. After runtime separation: runtime about 1.43 MiB, status read 133 ms, progress ACKs about 0.35–0.45 s, first body ACK 5.751 s, and 125 unchanged conversations skipped. Later body saves still timed out. |
| 0.8.9 | Earlier whole-body read/write took 21.676/5.440 s, ACK 28.029 s, then final retry 13.089 s. Versioned conversation records replaced whole-body saves while retaining the old root. Initial real preparation took 10.404 s and first snapshot ACK 4.149 s (record write 309 ms, index 40 ms); a later ACK still exceeded the total wait. |
| 0.8.10 | A successful 0.8.9 save took 16.839 s: runtime read ~3.0 s, body write ~3.5 s, index ~4.3 s, runtime publication ~5.3 s. The fixed 15 s total wait had already expired. An internal Port changed the budget to 15 s of actual storage inactivity; real completion and an independent increment followed. |

Only the final durable result confirms a save. Activity events add no storage polling, website requests, or timer keep-alives. Disconnecting does not cancel accepted Chrome writes and does not automatically resend. Old and unpublished versions occupy space until account clearing; splitting did not immediately shrink storage.

Earlier live evidence included an HTTP 200 `text/html` response ending at `/web/passport/zp/verify.html` during a 0.8.1 retest. Later history requests stopped and saved records remained. A subsequent interruption used non-success JSON, and the user reported web/mobile logout. These establish observed restrictions, not their cause or a safe request rate. The 10-second interval is not platform approval.

## Reproduction and remaining limits

Use [TESTING.md](TESTING.md) for current commands and browser coverage. Offline fixtures use mocked APIs, in-memory Chrome storage, and temporary directories; they do not access recruitment accounts or the original project's `data/`. They cover pagination/native IDs, increment/retry selection, UID/task boundaries, late writes, exports, verification pauses, and deterministic demos. Synthetic demo directories alone are not account-isolation evidence.

- Two-real-account switching remains deferred.
- The 0.8.10 completion did not exercise live verification-pause/manual-resume; offline tests do not establish current site behavior.
- Future API compatibility, verification triggers, and an approved safe rate remain unknown.
- Large-archive capacity, prolonged interruptions, browser/OS versions, and lifecycle combinations are not exhaustively covered.
- Tests, source publication, store submission, and store approval are separate events.
