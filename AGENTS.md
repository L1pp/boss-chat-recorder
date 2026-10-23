# Repository guidance

Use Chinese for maintainer-facing explanations. This is the public source repository of a Manifest V3 extension. Runtime code lives in `extension-tracker/`; generated content bundles come from `scripts/build-extension.mjs`.

Use only repository synthetic fixtures and new temporary browser profiles for tests. Do not log in to BOSS, send messages, submit applications, upload real records, or access a personal browser profile. Do not trigger store upload or publish operations unless the human explicitly requests them.

## Change and release workflow

Make public source changes through a GitHub branch and formal PR. Let configured CI and automatic AI reviews run when their trigger conditions apply, address relevant findings, and merge the PR before preparing a store package. The final package comes from GitHub Actions run on merged `main`; local ZIPs and PR CI artifacts are for preview and checks only. After merge, use the manual release workflow for `build`, `status`, `upload`, or `publish` as appropriate. `publish` uploads and submits the package for review.

If Codex reports that an environment is needed, complete the repository-specific environment association or setup described by the [official environment guide](https://learn.chatgpt.com/docs/environments/cloud-environment) and [environment settings](https://chatgpt.com/codex/settings/environments). An enabled review toggle alone does not establish that an environment is ready; do not assume every account or repository has the same environment requirement.

Local commands: `npm test`, `npm run test:coverage`, `npm run check`. Chromium regression additionally needs `npm ci --ignore-scripts`, `npm run test:browser:install`, and `npm run test:browser`. Keep new public source files in the existing release file list; runtime ZIP contents are explicitly listed by the packager.

## Code Review Rules

### Account boundaries

Check that the same recruiter or message ID in different UIDs stays separate. Clearing one account must preserve the others and prevent late writes from recreating cleared data. Check the native participant and task binding contract rather than proposing extra website identity requests.

### Durable local data

Mark data saved only after its durable commit. Failed encryption or interrupted writes must preserve prior data and must not fall back to writing new plaintext. Reading retained legacy plaintext is intentional compatibility behavior; do not demand automatic whole-library migration or deletion.

### Tests and publishing

CI uses synthetic data without website or user credentials. Extension packages contain only public runtime files. Store `status` is read-only; upload and review submission require explicitly selected manual operations. Report concrete triggers and consequences, distinguish future suggestions from current defects, and do not introduce hash, fingerprint, freeze, or extra approval gates.
