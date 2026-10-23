# Usage

[English](USAGE.md) | [简体中文](zh-CN/USAGE.md) · [Documentation](README.md)

This guide describes the repository source. Store builds can have an earlier interface; release history belongs in the [changelog](CHANGELOG.md).

## Install

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/phaihpchfdihnclgjhpmpnhobdcogdhb).

To load source, follow the [build instructions](TESTING.md), open `chrome://extensions` or `edge://extensions`, enable Developer mode, and choose **Load unpacked → extension-tracker/**. Reload the existing installation when updating it. Separate installations and browser profiles have separate archives; they do not import each other's records automatically.

## Collect and update

1. Sign in normally to an account you are authorized to use and open the [BOSS chat page / 沟通页](https://www.zhipin.com/web/geek/chat).
2. Open the extension. Use **Start first collection** for a new archive, **Update changed conversations** for later runs, or **Resume collection** after interruption.
3. Keep the chat page open. The popup may close while collection continues; refreshing or closing the chat page interrupts it. Previously saved records are retained.

The displayed account identifies a local archive, not a fresh website-login check. Starting a collection uses the website's current account; exports and backups use the selected local archive. If the normal conversation list has not loaded, let it load before starting.

## Export and clear

| Action | Result |
| --- | --- |
| Export all records | All currently saved conversations for that account |
| Export this update | Full saved context for conversations actually refreshed in that run; empty when nothing changed |
| Back up this account | The account archive and its local update records |
| Clear local records | Removes that account's local records, without deleting chats on BOSS |

Exports are plain-text JSON. Downloading a file does not send it to an AI service; sharing it is your choice. A newly saved message can be older history, not necessarily a message sent today. Unknown sending times remain unknown. Media entries contain only available summaries and fields, without downloading or interpreting attachments.

## Language

Chinese browser languages select Simplified Chinese; other or unknown languages select English. Choose **中文 / English** in the popup to override that choice locally. Saved chats and exports retain their original content. Chrome chooses its extension name and description independently of the popup preference.

## Pauses and local storage

For manual verification, complete it on the BOSS page and then use the resume action. The extension does not solve or repeatedly probe verification. Other site or local-save errors stop the run and retain committed records; inspect the displayed error before retrying. Do not clear records or reinstall as a troubleshooting step.

New archive values are encrypted locally; the browser profile holds the key. Retained legacy plaintext is read compatibly, and lightweight UI metadata is outside the encrypted-body scope. Keep the profile and exported backups if you need the records. See the [privacy policy](../extension-tracker/PRIVACY.md) and [security contact](../.github/SECURITY.md).

Only history currently returned by the website can be collected. Available-history completion does not establish all-time account coverage; see [verification limits](VERIFICATION.md).
