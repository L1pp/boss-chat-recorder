# Provenance and license scope

[English](PROVENANCE.md) | [简体中文](zh-CN/PROVENANCE.md)

This public repository was assembled from an explicit file list in the local prototype and uses the [MIT License](../LICENSE). The original project, personal browser storage, and real records stayed outside this copy.

## Included implementation

The collection baseline is prototype **0.7.2's default API path**: same-origin GET, `historyMsg` cursor pagination, native message-ID deduplication, conversation selection by `updateTime`, batch saving, the message-fact model, and AI-oriented JSON exports.

| Prototype basis | Public-project additions and adaptations |
| --- | --- |
| Contact lists and history pagination | Read list parameters from the current page; remove hard-coded personal account parameters |
| Conversation updates and saving | UID-scoped state, baselines, and task tokens; retain native message IDs |
| Asynchronous collection, stop, and progress | Confirm the account once at startup; validate subsequent senders and tokens locally |
| Same-origin fetch | Share a fixed 10-second interval; pause on errors and retain acquired data |

The project's storage, UI, exports, synthetic demo, and tests are also included under MIT. Storage additions include per-conversation versions and account indexes, internal Port commit acknowledgements, and browser-native WebCrypto AES-GCM/IndexedDB key storage. They add no third-party runtime dependency.

The extension icon design used built-in image-generation assistance. Its transparent artwork master is preserved in [`assets/icon.png`](assets/icon.png), and the four runtime sizes are resized from it.

## Excluded material

Other collection implementations and generated resources from the original project are not build or runtime dependencies. The public copy excludes the development-only diagnostic bridge, personal browser data, real exports, real account UIDs, and diagnostic logs. It does not copy BOSS site scripts, page captures, API responses, or real account parameters. Demo records are hand-authored and explicitly synthetic.

Using API paths, response fields, or Chrome APIs does not imply platform authorization. Future third-party code or resources must retain applicable copyright and license notices. Version history and recorded results are maintained in [CHANGELOG.md](CHANGELOG.md) and [VERIFICATION.md](VERIFICATION.md).
