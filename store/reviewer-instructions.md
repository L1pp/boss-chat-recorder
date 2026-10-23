# Reviewer notes

[English](reviewer-instructions.md) | [简体中文](zh-CN/reviewer-instructions.md)

**BOSS 沟通记录本地助手** is an unofficial local archiving extension. Minimum Chrome: **102**. See the [materials index](README.md) for version and artwork status.

Collection starts manually on the user's signed-in BOSS chat page. Records are saved per account and exported as JSON. The extension does not send messages, submit resumes, or bypass login or manual verification.

## Installation and operation

For unpacked testing, extract the runtime ZIP into a separate directory and choose **Load unpacked** in extension management. manifest.json must be at the directory root. Use a separate browser profile to keep test archives apart from everyday records.

Opening the popup, refreshing local state, exporting, and clearing use local records without additional BOSS requests. The displayed account is the selected archive account, not a fresh confirmation of the website login. Interface language follows the browser initially and can be changed locally; saved message content is not translated.

Live-platform testing requires a BOSS account the reviewer is authorized to use:

1. Sign in normally and open [the chat page](https://www.zhipin.com/web/geek/chat). Wait for its conversation list to load.
2. Open the extension and start collection or update the existing archive. Requests use a fixed minimum interval; the user can stop the run.
3. After completion, export all records. This downloads JSON without connecting to an AI service.
4. Start another update. Conversations with unchanged timestamps and completed history are skipped; changed or incomplete conversations reread currently available history.
5. If verification appears, the extension pauses and retains records. Complete verification on the website, then continue manually. The extension does not probe for completion.

Everyday account credentials and real chats are not supplied. If website access is unavailable, contact the developer for appropriate test conditions and record that limitation.

## Evidence and data handling

Recorded synthetic results are in [acceptance-0.8.11.json](acceptance-0.8.11.json). Offline reproduction and current browser-test scope are in [testing](../docs/TESTING.md). Synthetic checks do not establish live website compatibility or two-real-account switching; see [verification](../docs/VERIFICATION.md).

The public package uses activeTab, scripting, storage, and unlimitedStorage. Scripts are bundled; there is no persistent website permission, remote code, or localhost debug bridge. Requests use the existing website session without reading or exporting Cookies.

New protected values use local AES-256-GCM with a non-extractable key stored automatically in the same profile's IndexedDB. No password is needed. UID key names, lightweight summaries, exported JSON, and retained legacy plaintext are outside the encrypted-body scope. This provides no cross-device recovery or protection against control of the browser profile or operating system.

See the [privacy policy](../extension-tracker/PRIVACY.md) and [form guidance](privacy-disclosure.md) for details. Account-owner submission items and the stable policy URL are in the [materials index](README.md).
