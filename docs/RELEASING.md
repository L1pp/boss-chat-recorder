# GitHub packaging and Chrome Web Store releases

[English](RELEASING.md) | [简体中文](RELEASING_CN.md)

## Change and release workflow

Maintain public source through focused GitHub PRs. Commit on a branch, open a PR, let configured CI and automatic code/security reviews run when their trigger conditions apply, and address relevant findings before merging. After merge, manually run GitHub Actions on `main` to prepare the formal store package and, when requested, query the store, upload a draft, or submit for review. CI and AI review are checks and feedback, not a store update.

The final store package comes from merged `main` and GitHub Actions. Local ZIPs are development previews. A PR CI ZIP supports inspection before merge but is not the final store release package. Several focused PRs can accumulate into one later release.

Entry point: **Actions → Build and publish Chrome Web Store extension → Run workflow**. This workflow runs only when manually dispatched, not automatically on pushes or PRs. Choose `main`.

| `operation` | Effect |
| --- | --- |
| `build` (default) | Builds, runs offline/browser tests and public-source checks, and produces a downloadable extension ZIP. Does not connect to Google. |
| `status` | Uses a short-lived Google access token to read the existing store item's status. Does not build, upload, or submit. |
| `upload` | Builds a ZIP, uploads a new draft for the existing store item, and waits for Google's upload acknowledgement. Does not submit for review. |
| `publish` | Builds, uploads, then submits for normal review. Approval is followed by publication under the item's existing visibility settings. |

`github_release` is **off by default**. When enabled, a successful build and selected store operation create GitHub Release `v<manifest.version>` with the same ZIP attached. `status` ignores this option. An existing release with that name causes an error; the workflow does not overwrite it.

GitHub Actions is the automation runner. A GitHub Release is a versioned public download with release notes. Chrome Web Store submission is a separate operation. Running CI or `build` with `github_release=false` creates neither a GitHub Release nor a store submission.

## Package contents

The ZIP contains only runtime files explicitly listed in `scripts/package-extension.mjs`, with `manifest.json` at its root. Source-only modules, tests, synthetic demos, store artwork, credentials, local debug files, and personal-data directories are excluded. Workflow artifacts are retained for 14 days; GitHub Release attachments remain with the release.

Successful push/PR checks also generate `boss-chat-recorder-Linux-ci` and `boss-chat-recorder-Windows-ci` artifacts containing the extension ZIP for inspection before merge. CI does not request Google tokens or contact the store.

Local preview packaging uses Node.js 24 without dependency installation:

```sh
npm run build
npm test
npm run check
npm run package:extension -- --output /path/to/extension.zip
```

Without `--output`, the ZIP is written to ignored `dist/boss-chat-recorder-<version>.zip`. Run source checks first; the ZIP itself is not part of the public source file list.

## One-time Google authentication

Store updates use [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api) and a [publishing service account](https://developer.chrome.com/docs/webstore/service-accounts). The fixed extension ID is `phaihpchfdihnclgjhpmpnhobdcogdhb`.

Authentication is GitHub OIDC → Google Workload Identity Federation → publishing service account → short-lived OAuth access token. No service-account JSON private key, personal refresh token, or browser Cookie is stored in the repository. Google's authentication action generates a token only for store jobs and does not create a credential file for packaging.

`status` requests the official `chromewebstore.readonly` scope. Only `upload` and `publish` request the `chromewebstore` write scope.

Setup:

1. Enable `chromewebstore.googleapis.com`, `iam.googleapis.com`, `iamcredentials.googleapis.com`, and `sts.googleapis.com` in the owner's Google Cloud project.
2. Create a dedicated publishing service account without broad project Owner or Editor roles.
3. Create a GitHub Workload Identity Pool/OIDC Provider with issuer `https://token.actions.githubusercontent.com`. Restrict trust to this repository and `refs/heads/main`, using GitHub's numeric repository and owner IDs; do not trust arbitrary repositories.
4. Grant the corresponding GitHub identity `roles/iam.workloadIdentityUser` on that service account so it can request short-lived tokens.
5. In the Chrome Web Store dashboard, open **PUBLISHER → Settings**, scroll to **Service account**, enter its email, and choose **Add a service account**. This is not under **ACCOUNT → Profile**. Google currently supports one service-account association per publisher; confirm the purpose of any existing binding before changing it.
6. Read the Publisher ID from **Publisher → Settings**.
7. In GitHub **Settings → Secrets and variables → Actions → Variables**, configure the three identifiers below. They are resource identifiers, not private keys; do not put tokens in variables.

| GitHub variable | Value |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<project-number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |
| `CWS_SERVICE_ACCOUNT` | Dedicated publishing service-account email |
| `CWS_PUBLISHER_ID` | Publisher ID shown by the store dashboard |

References: [deployment-pipeline identity federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines) and [google-github-actions/auth](https://github.com/google-github-actions/auth). The account owner handles initial login, Google terms, and publisher association. This path does not require paid compute resources.

## Initial verification and updates

First run `build` and inspect the downloadable ZIP. After configuring Google identity, run `status` and confirm the target extension's published version and review state. These two operations do not change store content.

For a new version, update public source and the version fields in `package.json` and `extension-tracker/manifest.json`, complete PR checks and review, and merge to `main`. Then dispatch the release workflow. Use `upload` if the owner wants a draft before review, or `publish` when submission is authorized. `publish` rebuilds, uploads, and submits. Google does not accept duplicate version numbers; the workflow does not increment or commit them. A separate development/debug build need not match the store version.

If review submission is paused, choose only an operation within the owner's authorization: `build` is local-to-Actions packaging, `status` is read-only, and `upload` changes the store draft. Do not choose `publish` without submission authorization.

An API response indicating submission is not proof of public availability. The dashboard remains the source for review results, account issues, listing text, and privacy disclosures. This workflow does not change listing text, pictures, visibility, account settings, or request a review bypass.

Uploads and submissions share a GitHub concurrency group for this extension so two manual releases do not interleave different drafts. Status queries do not occupy that group. `publish` uploads the code from its own run rather than submitting a pre-existing draft. If Google rejects a duplicate version upload, the job stops without submitting some other draft.

## CLI

The release client reads `CWS_PUBLISHER_ID`, `CWS_EXTENSION_ID`, and `CWS_ACCESS_TOKEN` from environment variables. The token is used only for fixed official Google APIs and is not logged.

```sh
npm run store:status
npm run store:upload -- --zip /path/to/extension.zip
npm run store:publish
```

`upload` and `publish` are actual writes. Use only `status` for a connection check. During asynchronous upload processing, the client polls Google's status endpoint without re-uploading. An upload error or wait timeout fails the operation and prevents subsequent review submission.
