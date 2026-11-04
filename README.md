# SendIt for Chrome and Firefox

A browser extension client for [Via](https://github.com/eitchtee/Via), the self-hosted way to send links, text and files
between your devices.

- **Receive**: links open in a new tab, text is copied to the clipboard, and files are saved to
  the browser's downloads folder (or wherever you choose, if you turn on *Ask where to save each
  file*). Every item shows a notification and is kept in a local history.
- **Send**: the toolbar button sends the current page, one or more files, or some text to any
  of your devices and contacts.

## Install (development)

```sh
npm run build        # writes dist/chrome and dist/firefox (no dependencies needed)
```

- **Chrome / Edge**: `chrome://extensions` → *Developer mode* → *Load unpacked* → pick
  `dist/chrome` (or `src/`, which is the Chrome build).
- **Firefox** (140+): `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → pick
  `dist/firefox/manifest.json`.

On first install the setup page opens. Enter your server's address, allow the extension to
talk to it, sign in, and give this browser a name. The password is only used to register the
device: the extension keeps the device token, never the password or a session.

## Releasing

Publish a GitHub release tagged with the version (`v1.2.0`; 1 to 4 numbers, no `-beta`
suffixes). [`.github/workflows/release.yml`](.github/workflows/release.yml) builds both
extensions with that version and attaches them to the release:

| Asset | What it is |
|---|---|
| `sendit-chrome-<version>.zip` | Chrome / Edge package |
| `sendit-chromium-<version>.crx` | Signed package for Chromium browsers that allow installs from outside the Chrome Web Store |
| `sendit-chromium-<version>-crx.zip` | The same `.crx`, zipped: Chromium browsers delete `.crx` downloads. Unzip it, then drag the `.crx` onto the browser's extensions page |
| `updates.xml` | Update manifest for the `.crx` |
| `sendit-firefox-<version>.xpi` | Firefox add-on, signed by Mozilla, installs by opening it in Firefox |
| `updates.json` | Firefox update manifest |

**Auto-updates**

- **Firefox**: release builds point `update_url` at
  `releases/latest/download/updates.json`, so installed copies check the latest release about
  once a day and update themselves. This needs the repository secrets `AMO_JWT_ISSUER` and
  `AMO_JWT_SECRET` (an API key from addons.mozilla.org → Developer Hub → *Manage API Keys*).
  The add-on is signed as *unlisted*: it doesn't appear on AMO, and Mozilla signs it
  automatically. Without the key, the release gets an unsigned zip that only loads as a
  temporary add-on, and there are no updates.
- **Other Chromium browsers**: the `.crx` carries an `update_url` pointing at
  `releases/latest/download/updates.xml`, so browsers that accept it keep it up to date. Google
  Chrome on Windows and macOS won't install it (use the zip or the Web Store there). Other
  browsers vary: Opera and Vivaldi, for example, install a `.crx` dragged onto their extensions
  page. The package is signed with the `CRX_PRIVATE_KEY` secret, a PEM key made once with
  `node scripts/crx.mjs keygen key.pem`. That key *is* the extension's identity: keep a backup,
  and never replace it, or installed copies stop updating.
- **Chrome**: Chrome only auto-updates extensions from the Chrome Web Store. On Windows and
  macOS it refuses to install packages from anywhere else unless an enterprise policy allows
  it. Create the Web Store listing once by hand, then add the secrets `CWS_EXTENSION_ID`,
  `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET` and `CWS_REFRESH_TOKEN` (see
  [chrome-webstore-upload's guide](https://github.com/fregante/chrome-webstore-upload-keys)).
  Each release is then uploaded and submitted for review, and Chrome updates installed copies
  once it's approved. Without these secrets, the zip is only for *Load unpacked*, which never
  updates.

Mozilla signs each version only once, so fix a broken release by tagging a new version. To
rebuild an existing release's assets with the current workflow, run *Actions → Release → Run
workflow* with its tag: it keeps the signed `.xpi` and replaces the rest.

## How it works

The extension follows Via's [client guide](https://github.com/eitchtee/Via/blob/main/docs/clients.md):

- It registers as a device of type `browser` and stores only its device token.
- The background keeps `GET /v1/inbox/events` open with `fetch()` (`EventSource` can't send the
  token) and syncs the inbox on `ready` and `push`. It reconnects with backoff. A 1-minute alarm
  restarts it and syncs whenever the browser suspends the background.
- Items are acked only once handled. Files are acked when the download finishes and its size
  matches. A cancelled save dialog also acks. A failed download is retried twice, then waits for
  *Retry* in the history.
- Handling is idempotent on the item id, recalled items cancel their download, and a revoked
  device signs out with a notification.
- Only `https` links from your own devices open automatically. Links from contacts or over plain
  `http` wait for a click on the notification or in the history. Text from contacts isn't
  copied automatically.
- File names are sanitized before saving, and everything is displayed as text, never HTML.

Renaming this browser uses `PATCH /v1/devices/me` with the device token. On older servers
without it, the settings page asks for the password and uses a short-lived session. Removing
the browser always needs the password, since only the account can delete devices.

### Browser differences

| | Chrome | Firefox |
|---|---|---|
| Background | service worker (kept alive while the stream is open) | event page |
| Clipboard | offscreen document | background page |
| Send file | in the popup | in a small window, because Firefox closes popups when the file picker opens |

## Permissions

| Permission | Why |
|---|---|
| host access to your server (asked at setup) | talk to the Via API; nothing else |
| `activeTab` | read the current tab's address and title when you send it |
| `downloads` | save received files |
| `clipboardWrite` (+ `offscreen` on Chrome) | copy received text |
| `notifications` | tell you when something arrives |
| `alarms` | reconnect when the browser suspends the extension |
| `storage` | settings, device token and history, all local |

## Known limits

- Downloads go straight to disk through the browser, so the file's SHA-256 isn't checked; its
  size is.
- Uploads run in the popup: keep it open until the upload finishes.

## Project layout

```
src/
  manifest.json        Chrome manifest; scripts/build.mjs derives the Firefox one
  background.js        stream, sync, handling, notifications
  lib/                 API client, storage, icons, browser namespace
  popup/               toolbar window: Send and History tabs
  options/             onboarding and settings
  offscreen/           Chrome-only clipboard helper
  icons/               copied from Via/branding (app-icon-small-16/32/48, app-icon-128); don't edit
```

The icons come from [Via's branding folder](https://github.com/eitchtee/Via/tree/main/branding).

## License

AGPL-3.0, like Via.
