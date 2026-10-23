# Verification and reproducibility

[English](VERIFICATION.md) | [完整中文记录](VERIFICATION_CN.md)

This page summarizes recorded acceptance evidence and its limits. The [Chinese record](VERIFICATION_CN.md) retains the full chronological development notes. Test counts and platform observations below belong to their stated versions and dates; they are not a claim that every later version or website state was tested in the same way.

This public copy has no local debug bridge. References to one describe historical troubleshooting in a separate development copy. Real exports, account UIDs, and diagnostic logs are not public artifacts.

## Current scope

The last store version documented in this repository is 0.8.11; 0.8.12 is an unreleased source candidate. Current development checks are described in [TESTING.md](TESTING.md). First-collection and bilingual UI changes use synthetic fixtures and isolated profiles; they do not imply a new real-account acceptance run or a store submission.

Two-real-account switching remains deferred because only one real account was available. Dedicated offline account/store/worker tests and synthetic native-browser isolation are retained. Synthetic account separation and a successful single-account run must not be described as multi-real-account acceptance.

## 0.8.11 native encryption and restart acceptance

The public entry encrypts new account-archive, runtime, and conversation-record values with AES-GCM. It automatically persists a non-extractable key in the same browser profile's IndexedDB. Existing plaintext is read compatibly rather than migrated throughout retained real storage. The separate development entry kept its original storage behavior. Minimum Chrome 102 supports trusted-context storage access.

The public candidate passed **175 offline tests**, and the development source passed **209**, with zero failures. Seventeen added cases covered real WebCrypto round trips, large text, random IVs, AAD mismatch, preserving old values on failure, key concurrency and transaction commit, restart reads, account clearing, and storage access scope. After store artwork was added, the same regressions and build checks still passed: 86 public allowed files and 96 development allowed files. PNGs were copied as binary and checked for their pixel dimensions; manifest icons include 16, 32, 48, and 128 pixels.

On **2026-10-18**, isolated Chromium **151.0.7922.34** loaded the public extension with network disabled. Two repository synthetic accounts held 2 conversations/4 messages and 2 conversations/3 messages. All 10 known protected values had ciphertext envelopes; the native IndexedDB CryptoKey was non-extractable. A one-off native action-popup acceptance used normal messages to read and export matching counts without mixing account contents.

Native CDP stopped the worker and observed `runningStatus=stopped`, then woke it for reads. Chromium was then fully closed and restarted with the same test profile, without reseeding. Both stages retained the same key and ciphertext and produced unchanged read/export counts. This was native API acceptance, not an IndexedDB substitute. See [acceptance-0.8.11.json](../store/acceptance-0.8.11.json).

No personal browser profile or real BOSS account was accessed during this encryption acceptance. It did not migrate a retained real archive, test two real accounts, or cover Chrome 102 and all other browser versions. Store screenshots show synthetic data in the actual public extension, with explanatory framing laid out in the isolated test browser. This historical one-off action-popup check is distinct from the current automated headless suite's limitations.

## Public copy without diagnostics

The development-only `prepare:public` command generated a separate directory from an explicit source list without overwriting the active extension or real data. That command and generator are not public-copy prerequisites. The public copy removes the bridge, pairing UI, temporary diagnostic messages, and localhost optional permission while retaining the same kernel, UID partitions, request interval, and save-activity acknowledgements.

At that stage, the public copy passed **158 offline tests** and the development copy with diagnostics passed **192**, all with zero failures. Public-startup differences were tested offline; real platform acceptance described below used the same-kernel development copy, rather than a new real collection solely for the public entry.

## 0.8.10 real collection and independent incremental run

On **2026-10-17**, real Chrome reloaded 0.8.10, continued the interrupted run from retained records, and completed it. This was not an uninterrupted empty-library collection. A later independent run had a new run ID and `mode=incremental`, distinguishing it from continuation.

| Evidence | Recorded result |
| --- | --- |
| Completed collection | All 375/375 returned conversations; 3,634 messages with IDs; 0 failures |
| Final state | `completed`, `active=false`, `finalizing=false`, completion time present, no error |
| Independent incremental | About 6 seconds; scanned 375, skipped 375, selected/refreshed/new messages 0, failures 0 |
| Latest-update export | `mode=incremental`, `scope.noChanges=true`, empty conversations |
| All-record export after increment | 375 conversations and 3,634 messages, matching the baseline |
| Message-set comparison | By account/conversation/message ID: 0 added, lost, or duplicate; 0 changes to direction, content, time, media, or other message facts |

All returned conversations reached the endpoint's available history end. Both all-record exports had no duplicate conversations or messages missing IDs. They retained `fullAccountCoverageVerified=false`: currently available history is not full-account, all-time history. The exports and logs stayed outside the public directory.

The independent run contained no new or changed conversations. Its success does not guarantee that future requests will avoid verification or other site restrictions.

## Later natural changes: export comparison on 2026-10-18

After the user updated the archive, local diagnostic state and a new all-record export both contained **378 conversations and 3,697 messages with IDs**. Compared with the previous all-record export, there were **3 new conversations and 63 new messages across 14 archived conversations**, including one platform job-assistant conversation. No prior conversation or message was lost. Account/conversation/message identity combinations were unique, and one existing message's time field changed.

This establishes that natural additions and changed conversations reached the later export. The final run metadata attached to that export says scanned 377, skipped 377, and newly saved 0, so the 63 additions cannot all be attributed to that last run. The cumulative 378 saved conversations also differ from its 377 returned list entries. Coverage remains limited to records the website supplied.

## Local-save failures and fixes

The following observations explain the storage changes. They do not establish why the website previously requested verification or logged the user out.

| Version | Observed failure or change | Offline result and real boundary |
| --- | --- | --- |
| 0.8.6 | A progress acknowledgement returned after 19.845 seconds against a 15-second total wait; stop reported `interrupted/BULK_CHECKPOINT_FAILED`, discovered 370/completed 0. Existing records and message counts were unchanged. | 146 tests, 0 failures; 67-file check. First acknowledgement 8.91 seconds. A paired development bridge exposed only status/logs/storage/stop, with no chat bodies or remote start. |
| 0.8.7 | Removed repeated binding/partition reads and deep copies; retained atomic validation and existing schema. Early batches advanced but later timed out. | 152 tests, 0 failures; 67-file check. Early progress acknowledgements about 3.2–5.7 seconds and first snapshot about 4.0 seconds were partial observations only. |
| 0.8.8 | Each progress operation previously moved about 17.1 MiB of bodies. A final post-interruption acknowledgement took 28.378 seconds; the original trigger was no longer in the rolling trace. Runtime was separated from bodies. | 161 tests, 0 failures; 67-file check. Synthetic 17 MiB coverage. Later real runtime about 1.43 MiB; status read 133 ms; progress about 0.35–0.45 seconds and first body ACK 5.751 seconds. Later body saves still timed out. |
| 0.8.9 | Whole-body read 21.676 seconds plus write 5.440 seconds produced a 28.029-second acknowledgement. Per-conversation immutable versions and a single account index replaced whole-body saves while retaining the old root. | 171 tests, 0 failures; 71-file check. Synthetic 22 MiB coverage, failed index commits, UID 1/10 clearing, retry counts, unknown data. Initial real preparation 10.404 seconds and first snapshot ACK 4.149 seconds; a later ACK still exceeded the total budget. |
| 0.8.10 | A successful 16.839-second save had advancing runtime read (~3.0 s), body write (~3.5 s), index (~4.3 s), and runtime publication (~5.3 s), but the fixed total wait had already timed out. Internal Port activity changed this to 15 seconds of inactivity. | 182 tests, 0 failures; 75-file check. Activity, silence, disconnection, cancellation, sender, Port binding, stop/drain, and generated-bundle integration covered. Real completion and independent increment are recorded above. |

Only a final durable result acknowledges saved data. Activity notifications do not add storage polling, website requests, or timer keep-alives. Disconnecting does not cancel already accepted Chrome writes; the client does not automatically resend. Retained old versions and unpublished versions use space until per-account clearing; the split is not a claim that storage immediately shrank.

## Earlier development snapshots

| Version | Recorded checks | Scope and limits at that point |
| --- | --- | --- |
| 0.8.0 | 55 tests, 0 failures; 50 allowed files; build and deterministic demo/bundle comparison | Simulated APIs and a VM running real generated bundles and worker modules; no real browser acceptance. |
| 0.8.1 | 91 tests, 0 failures; 54-file check | Real account/list/partial history access found continued scanning after HTML and unclear interruption UI. Added pause/recovery tests. Fresh identity requests per operation were historical behavior, replaced later. No full real baseline yet. |
| 0.8.3 | 105 tests, 0 failures; 55-file check | A real response was HTTP 200 `text/html` ending at `/web/passport/zp/verify.html`. Subsequent history stopped and records remained. This established verification, not its cause or a safe rate. Added persisted pause, badge, manual continuation, and recovery tests. |
| 0.8.4 | 118 tests, 0 failures; 58-file check | After another interruption and user-reported web/mobile logout, removed repeated account requests, shared the 10-second interval, and added local popup cache. Simulated three starts made three identity requests; local operations made none. No live retest or rate guarantee. |
| 0.8.5 | 113 tests, 0 failures | Returned to prototype 0.7.2's API kernel; kept UID/token bindings, pacing, pauses, and timeouts, while removing separate verification gates, trial state, obsolete rechecks, and total conversation deadlines. No real-account test in that change. |

The full Chinese chronology retains additional diagnostic details and the contemporaneous statements of what was still pending. Later evidence above supersedes earlier “not yet completed” notes for the same acceptance stage; it does not erase those historical failures.

## Reproduce offline checks

```sh
npm run build
npm run demo
npm test
npm run check
```

Node.js 24 or later is sufficient for this layer without third-party dependencies. `build:check` compares output from the same generator without writing. Public-source checks include allowed files, symlinks, known credential patterns, and excluded collection artifacts. Diagnostics report paths/categories rather than matched secrets. A clean scan does not establish that all possible personal information was detected.

Offline fixtures establish pagination, native ID handling, deduplication, paused/failed/retry selection, account/task boundaries, late-write rejection, exports, unknown times, media summaries, and deterministic demos. Isolated Chromium separately covers native storage and lifecycle. Neither layer connects to a real recruitment account or reads the original project's `data/` directory.

## Unverified boundaries

- Two-real-account switching remains deferred; no synthetic test is described as a substitute.
- The 0.8.10 completion phase did not observe the live verification-pause/manual-resume branch. Earlier verification evidence and offline tests do not establish its current site behavior.
- Internal API changes, verification triggers, and an approved safe request rate remain unknown.
- All large-archive sizes, prolonged network interruptions, browser versions, operating systems, and lifecycle combinations have not been exhausted.
- Automated CI is not store approval, a distribution license, or proof of continued website compatibility.

Earlier browser tooling denied a local `file://` preview and that attempt did not bypass the restriction. Later isolated synthetic browser/UI work is recorded separately; the earlier blocked attempt must not be presented as a completed visual check. Store approval and source publication are also separate events from the historical tests above.
