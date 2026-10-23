# Packaging and Chrome Web Store releases

[English](RELEASING.md) | [简体中文](zh-CN/RELEASING.md)

## Manual release workflow

Public changes go through focused branches and PRs, configured CI/review, and merge to `main`. The formal store package comes from GitHub Actions on merged `main`; local and PR CI ZIPs are previews. Several PRs may form one release.

Open **Actions → Build and publish Chrome Web Store extension → Run workflow**, and select `main`. The [workflow](../.github/workflows/release.yml) runs only on manual dispatch.

| `operation` | Effect |
| --- | --- |
| `build` (default) | Build, run offline/browser tests and public checks, and produce a ZIP without connecting to Google; or select an existing tested ZIP with `build_run_id` |
| `status` | Read the existing store item's status using a short-lived token; no build, upload, or submission |
| `upload` | Upload the selected ZIP as a draft, waiting for Google's acknowledgement; no review submission |
| `publish` | Upload the selected ZIP and submit for normal review; approval publishes under the item's existing visibility |

`build_run_id` is optional. Leave it blank to build and test once in this run. Set it to the original successful `main` release-workflow run ID to download its retained `boss-chat-recorder-<version>` artifact instead. Reuse skips the package job, dependency installation, and tests; it does not regenerate or modify the ZIP. PR CI artifacts, failed runs, and expired artifacts are not release sources. `status` ignores this input.

For a staged release:

1. Run `build` on `main`, optionally with `github_release=true`, and retain its run ID.
2. Run `upload` with that `build_run_id`, then edit and save any store listing changes.
3. Run `publish` with the same ID. It uploads the same tested ZIP before submitting, so it does not accidentally submit another draft.

A one-step update can still use `publish` with an empty ID: one build feeds the upload and submission. Store writes and GitHub Release creation run only on `main`; branch builds are previews.

`github_release` defaults to `false`. When enabled, successful build/store work creates GitHub Release `v<selected-version>` with the same ZIP, using the original build's commit for a new tag even when this workflow runs from a later commit. Existing tags retain their target. `status` ignores it; an existing release name fails rather than being overwritten. CI and `build` with `github_release=false` create neither a GitHub Release nor a store submission.

For initial setup, run `build` to inspect the package, then `status` after configuring Google identity. For updates, change the public source and version fields in `package.json` and `extension-tracker/manifest.json`, complete the PR, and merge before dispatch. Choose `upload` for an authorized draft update or `publish` for an authorized review submission. A new published version must increase the version fields; the workflow does not increment or commit them. A separate development build need not match the store version.

Upload/submission jobs share an extension-specific concurrency group; status queries do not occupy it. Actions `publish` uploads the selected tested ZIP, and a failed upload prevents submission of another draft.

Submission acknowledgement is not public availability. Review results, listing text, artwork, privacy disclosures, visibility, and account settings remain in the store dashboard; this workflow does not edit them or bypass review.

## Package contents and local preview

The ZIP contains only runtime files listed in `scripts/package-extension.mjs`, with `manifest.json` at its root. Source-only modules, tests, demos, store artwork, credentials, debug files, and personal data are excluded.

Actions ZIPs are retained for 14 days; after expiry, create a fresh tested build. Main-push/PR checks also produce `boss-chat-recorder-Linux-ci` and `boss-chat-recorder-Windows-ci` previews without requesting Google tokens. GitHub Release attachments remain with their release.

For a local preview, follow the build/check steps in [testing](TESTING.md), then run:

```sh
npm run package:extension -- --output /path/to/extension.zip
```

Without `--output`, the package goes to ignored `dist/boss-chat-recorder-<version>.zip`. Packaging uses Node.js 24 and needs no dependency installation.

## One-time Google identity setup

The target extension is `phaihpchfdihnclgjhpmpnhobdcogdhb`. Store operations use [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api) and a [publishing service account](https://developer.chrome.com/docs/webstore/service-accounts).

Authentication follows GitHub OIDC → Google Workload Identity Federation → publishing service account → short-lived OAuth token. No service-account private key, personal refresh token, or browser Cookie is stored in the repository, and the authentication action creates no packaging credential file. `status` requests `chromewebstore.readonly`; only `upload`/`publish` request `chromewebstore` write scope.

1. Enable `chromewebstore.googleapis.com`, `iam.googleapis.com`, `iamcredentials.googleapis.com`, and `sts.googleapis.com` in the owner's Google Cloud project.
2. Create a dedicated publishing service account without broad Owner/Editor roles.
3. Create a Workload Identity Pool/OIDC Provider with issuer `https://token.actions.githubusercontent.com`. Restrict trust to this repository and `refs/heads/main`, using GitHub's numeric repository and owner IDs.
4. Grant that GitHub identity `roles/iam.workloadIdentityUser` on the service account.
5. In the store dashboard, use **PUBLISHER → Settings → Service account → Add a service account** to associate its email. This is separate from **ACCOUNT → Profile**. The publisher supports one association; check any existing binding's purpose before replacing it.
6. Read the Publisher ID from **Publisher → Settings**, then set these repository **Settings → Secrets and variables → Actions → Variables**:

| Variable | Value |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<project-number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |
| `CWS_SERVICE_ACCOUNT` | Publishing service-account email |
| `CWS_PUBLISHER_ID` | Store Publisher ID |

These variables hold identifiers, not tokens or private keys. The account owner completes initial login, Google terms, and publisher association.

Configuration references: [deployment-pipeline identity federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines) and [google-github-actions/auth](https://github.com/google-github-actions/auth).

## Release-client CLI

The client reads `CWS_PUBLISHER_ID`, `CWS_EXTENSION_ID`, and `CWS_ACCESS_TOKEN` from the environment. It uses the token only for fixed official Google APIs and does not log it.

```sh
npm run store:status
npm run store:upload -- --zip /path/to/extension.zip
npm run store:publish
```

The CLI exposes separate status, upload, and submission steps. Use `status` for a connection check; `upload` and `publish` change the store. Asynchronous upload processing polls status without re-uploading; an error or timeout fails the operation and prevents the workflow's subsequent submission.
