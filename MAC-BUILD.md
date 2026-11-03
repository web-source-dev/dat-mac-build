# Dat Desk for macOS

A separate copy of `../datdesk`, changed only where macOS needs it. The Windows app is untouched.

## What is different from the Windows app

| Part | Windows (`datdesk`) | Mac (`datdesk-mac`) |
|---|---|---|
| Screenshots / terminal-editor watch | yes | removed (no Screen Recording permission needed) |
| Device key | TPM / Windows key store via PowerShell | P-256 key encrypted with the macOS Keychain (`main/deviceKey.js`), sent as storage `software` |
| Updates | electron-updater installs automatically | `main/updateManager.js` checks the feed and opens the new `.dmg` in the browser (an unsigned Mac app cannot self-install) |
| Update / version channel | `datdesk` | `datdesk-mac`, so the Windows "latest version required" gate never blocks Mac users |
| Build | `npm run build:win` on Windows | GitHub Actions on a Mac (`.github/workflows/build-mac.yml`) |
| Output | NSIS `.exe` | `DatDesk-<version>-arm64.dmg` (M1/M2/M3…) and `-x64.dmg` (Intel), plus `.zip` |

Everything else (login, DAT, proxies, extensions, TrackingEye presence, security) is the same code.
When you change the Windows app, copy the same change here by hand (except the files above).

## Build it (no Mac needed)

1. Make a **private** GitHub repo and push this `datdesk-mac` folder to it (`.env` is git-ignored).
2. Repo → Settings → Secrets and variables → Actions → New secret `MAC_ENV_FILE` = the whole content of `.env`.
3. Repo → Actions → **Build Dat Desk for macOS** → Run workflow (about 10 minutes).
4. Download the `dat-desk-mac` artifact from the finished run.

## Install on a Mac (first time)

The app is ad-hoc signed, not signed with an Apple Developer ID, so macOS warns once:

1. Open the `.dmg` and drag **Dat Desk** to **Applications**.
2. Open it. If macOS says it can't be opened: System Settings → Privacy & Security → **Open Anyway**.
   If it says the app is "damaged", run this in Terminal once:
   `xattr -cr "/Applications/Dat Desk.app"`
3. Allow the Keychain prompt with **Always Allow** (it holds the device key and cookies).

No other permission is needed: the Mac app has no screenshots, live view, support terminal or
"terminal/editor open" watch. TrackingEye still gets presence, the activity log, remote actions
and hardware details (Mac UUID, serial number, model, CPU, RAM, network addresses).

## Publish an update

Put the files from the artifact on the backend in `updates/datdesk-mac/darwin/`
(the artifact already has `latest.yml`). Raise `version` in `package.json` before each build.
Mac users see "Dat Desk X is available" and the download opens in their browser.

To remove the warnings and get real auto-update, buy an Apple Developer account ($99/year),
add the signing certificate and notarization secrets to the workflow, and switch back to electron-updater.
