# Provenance and license scope

[English](PROVENANCE.md) | [简体中文](PROVENANCE_CN.md)

This is the public copy without a local debug bridge. Historical bridge references describe development troubleshooting, not functionality shipped in this copy.

The repository was organized from an explicit list of files in the local prototype and uses the MIT License. The original project, personal browser storage, and real records stayed in their original locations; they were not automatically imported or copied here.

## Collection basis

The baseline is prototype **0.7.2's default API path**, rather than earlier DOM/CDP implementations. It retains same-origin GET, `historyMsg` cursor pagination, deduplication by native message ID, conversation selection by `updateTime`, batch saving, the message-fact model, and AI-oriented JSON exports.

| Prototype basis | Necessary changes retained in the public copy |
| --- | --- |
| Contact lists and history pagination | Discover list parameters from the current page; remove hard-coded personal account parameters |
| Conversation updates and saving | Separate state and baselines by the owning UID; retain native message IDs |
| Asynchronous page collection, stop, and progress | Confirm the account once at startup; handle later sender and token checks locally |
| Same-origin fetch | Share a fixed 10-second interval and pause on errors while retaining acquired data |

The public copy contains that API implementation plus this project's storage, UI, export, and test code. Other collection implementations and generated resources from the original project are not build or runtime dependencies. Any future third-party code or resources must have their applicable copyright and license notices reviewed and preserved.

## Project changes

- **0.8.5:** removed a separate verification trial gate, obsolete remote-recheck compatibility, and per-conversation total deadlines. It retained the same start, stop, and progress flow, single-request timeout, and local-save timeout, without adding request-count caps, confirmation steps, hashes, or fingerprints.
- **0.8.6:** separated core-save acknowledgements from badge and popup-cache refresh. A temporary Node loopback bridge at `127.0.0.1:17374` supported local diagnosis only after a user connection and permission grant. It could not start collection remotely. Its config and logs stayed in a private directory outside this public copy. The bridge and optional localhost permissions remain absent from the public package.
- **0.8.7:** removed repeated local binding/partition reads and redundant deep copies while retaining atomic binding validation, the schema, and the 10-second request interval. Its 152 offline tests passed, but early successful batches did not establish a complete real run; later results are recorded under 0.8.10.
- **0.8.8:** separated high-frequency runtime from chat bodies and retained independent slow-operation summaries. The original body model and local data remained. Its 161 offline tests passed; early real observations covered runtime reads and acknowledgements only, before a later body-save timeout.
- **0.8.9:** introduced per-conversation version records and an account index while retaining old local bodies. The API and 0.7.2 kernel were unchanged. Splitting, reconstruction, and storage code are project additions under MIT.
- **0.8.10:** introduced the internal storage Port and waiting based on actual local storage activity, without external runtime dependencies or additional website probes. On 2026-10-17, a real Chrome run resumed retained records to completion, followed by a separate no-change incremental run and export comparison. Only summaries and evidence limits are public; real exports, UIDs, and diagnostic logs are excluded. See [verification](VERIFICATION.md).
- **0.8.11:** added a WebCrypto AES-GCM account-store adapter, an IndexedDB local key, and trusted-context storage access for the public entry point. These use browser-native capabilities, add no third-party runtime dependency, and retain MIT and the 0.7.2 collection kernel.
- **0.8.12 (unreleased):** adds first-collection guidance and bilingual UI/documentation while keeping collection, account boundaries, and saved message facts unchanged.

The UI, lightweight local cache, synthetic demo, and offline tests are independent of real user data. API paths, response fields, and Chrome API use do not imply platform authorization. This repository does not copy BOSS site scripts, page captures, API responses, or real account parameters. Demo records are hand-authored by the generator and explicitly marked synthetic.
