<h3 align="center">AI-HUB mobile plugin</h3>

<p align="center">
  <img src="https://raw.githubusercontent.com/WNLUO/dsh-mobile-plugin/main/assets/banner.png" alt="AI-HUB: keep using DSH on your phone" width="100%">
</p>

<p align="center">
  <a href="https://apps.apple.com/us/app/ai-hub/id6821681438"><img alt="App Store" src="https://img.shields.io/badge/App_Store-Download-black?style=for-the-badge&logo=appstore&logoColor=white"></a>
  <a href="https://app.wnluo.com/public/apps/14"><img alt="Android APK" src="https://img.shields.io/badge/Android_APK-Download-3DDC84?style=for-the-badge&logo=android&logoColor=white"></a>
  <a href="https://github.com/WNLUO/dsh-mobile-plugin/releases/latest/download/ai-hub-android.apk"><img alt="GitHub APK" src="https://img.shields.io/badge/GitHub_APK-Latest-181717?style=for-the-badge&logo=github"></a>
  <a href="https://testflight.apple.com/join/4fn5PCMD"><img alt="TestFlight" src="https://img.shields.io/badge/TestFlight-Beta-0D96F6?style=for-the-badge&logo=apple&logoColor=white"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-mobile-plugin"><img alt="npm" src="https://img.shields.io/npm/v/dsh-mobile-plugin?style=flat-square"></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="platform" src="https://img.shields.io/badge/platform-iOS%20%7C%20Android-999999?style=flat-square">
  <a href="README.md"><img alt="中文" src="https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-2f81f7?style=flat-square"></a>
</p>

<p align="center">Pick up on your phone exactly where your desktop left off.</p>

**The mobile-side plugin for AI-HUB.** Install it on the computer and the phone app reaches your DSH through a relay tunnel or a LAN pairing — browse sessions, keep chatting, manage files and workspaces, with progress synced live. It also runs on a server without a desktop shell, as a headless host.

## 🌟 Features

- 🚀 **Two ways to connect**: come back from anywhere over the relay v2 tunnel, or connect directly through the LAN proxy on the same Wi-Fi.
- 📱 **A restricted mobile API**: `/api/mobile/v1/*` exposes only what the phone needs — no shell, no system settings, no free-form file writes.
- 🗂️ **Sessions and workspaces**: create sessions, assign them to a workspace, and session order set on the phone syncs back to the desktop.
- 📡 **Live events**: the device event stream forwards host events over SSE, so the phone sees the same progress the desktop does.
- 🧹 **Automatic archiving**: idle sessions move to the archive, hidden from lists without deleting logs.
- 🔐 **Pairing and credentials**: local configuration endpoints, an optional pairing policy, and per-device credentials you can revoke.

## 📥 Download the AI-HUB app

- [App Store](https://apps.apple.com/us/app/ai-hub/id6821681438) (the release build, live on the store)
- [Android APK](https://app.wnluo.com/public/apps/14)
- [Android APK (GitHub)](https://github.com/WNLUO/dsh-mobile-plugin/releases/latest/download/ai-hub-android.apk); [older versions](https://github.com/WNLUO/dsh-mobile-plugin/releases)
- [TestFlight beta](https://testflight.apple.com/join/4fn5PCMD) (new builds land here first; the release build still updates through the App Store)

The app is only half of it; this plugin is the other half.

## 🚀 Install and update

### DSH desktop

In DSH, open **Settings → Plugins** and install `dsh-mobile-plugin`, then open **Settings → Mobile → Open configuration page** to pair. The plugin marketplace handles update checks and installation; updates generally do not require a DSH restart.

### Headless Host (Linux)

Requires Node.js, pnpm, and the DSH plugin host dependencies. The repository includes `host.js` as a standalone entry point:

```sh
pnpm install --frozen-lockfile
DSH_HOME=/opt/dsh-mobile/.dsh DSH_MOBILE_PROFILE=mobile node host.js
```

`DSH_HOME` sets the data directory and defaults to `~/.dsh`. `DSH_MOBILE_PROFILE` sets the profile name and defaults to `mobile`. The headless Host's Web service listens on `127.0.0.1:3080` by default and is not exposed directly to the LAN.

The configuration endpoints are restricted to local access. Check the status and retrieve pairing information with:

```sh
curl http://127.0.0.1:3080/api/relay/status
curl http://127.0.0.1:3080/api/relay/pairing
```

See **Headless deployment** below for more deployment details.

## 🔌 Configuration and API

When running headless, use these local endpoints to manage remote connectivity:

- `POST /api/relay/toggle`: enable or disable remote control.
- `POST /api/relay/regenerate`: generate a new pairing code.
- `POST /api/relay/config`: configure `relayUrl`, `lanEnabled`, `lanPort`, `name`, and `pairingPolicy`.
- `POST /api/relay/reconnect`: reconnect the tunnel and LAN proxy.

The mobile API requires a Bearer token. The device event stream, `GET /api/mobile/v1/events/stream`, forwards host events over SSE. Session creation accepts `workspaceId` or `cwd`; `workspaceId` takes precedence and assigns the session to that workspace. Session ordering from the mobile app is synchronized with the host workspace.

The default pairing policy is `code`, which allows pairing with a valid pairing code. Set it to `deny` to reject all new pairing requests.

The `session_cleanup` tool can archive sessions or permanently delete already-archived sessions. Deletion is irreversible and requires explicit confirmation. **Deletion is queued**: the sessions disappear from lists immediately, while their logs and projection cache are removed from disk the next time the host starts — the host has no delete-session API, and removing files underneath a running host makes it open a log that no longer exists, which is an uncaught error that takes the whole host process down.

## 🖥️ Headless deployment

On a headless server, the launcher and plugin package are managed separately. The deployment process synchronizes the launcher to `/opt/dsh-mobile/`; install the plugin package in the profile:

```sh
cd <DSH_HOME>/profiles/<profile>
pnpm add dsh-mobile-plugin@<version>
```

The host prefers the plugin installed in the profile and falls back to the source-tree version if it is not installed. The device credentials package ships with the npm package. Use `pnpm install --frozen-lockfile` for the repository lockfile.

> Do not install the plugin with `npm install --legacy-peer-deps`; use the DSH plugin marketplace for a real install.

## 🔄 Local OTA for debugging

The management panel of recent plugin versions has a "Local OTA" card that can manually check for and install an emergency full package published through the relay. The entry point is reachable from the host machine only; neither the phone nor the public internet can trigger it. Installation takes effect by switching implementation generations, and a failed switch rolls back to the previous one. npm remains the official release source, and a later npm version takes over once it reaches the OTA version. The first npm release with this feature needs one DSH restart so the stable shell loads the OTA capability.

To publish an emergency full package, use the packing script in this repository instead of running `tar` by hand:

```sh
# pack only (artifacts land in the current directory)
node scripts/pack-ota.mjs

# pack and publish, then download it back to verify the hash
node scripts/pack-ota.mjs --publish https://your-relay --token <the relay's OTA publish token>
```

The script does four things: it asks `npm pack --dry-run --json` for the file list (**no system tar**, same logic on all three platforms), writes `lib/ota-manifest.json` into the package (version plus every file's path and byte count), self-checks with the client's real unpacker, and after publishing downloads the package back to compare sha256. The relay records the hash too, and the client verifies it before installing — truncated or tampered packages never install.

`--platform` defaults to `process.platform` (`darwin` / `linux` / `win32`); this plugin is pure JS, so `--platform any` publishes one package for all three systems, and a client with no package for its own platform falls back to `any`. `channel` is normally `stable`. The publish endpoint is closed when no token is configured; downloads are unaffected. Versions compare numerically, so the last one published is "latest".

## 👨‍💻 Development

```sh
pnpm install --frozen-lockfile
npm test
```

After changing the panel source in `React/`, run `pnpm run build` in that directory and commit the generated `lib/panel/index.html` with the source.

## 📦 Repository and releases

This is the public release repository, and its root is the npm package root. Development takes place in a private monorepo alongside the app and relay server, so this repository's history starts from the date it was split out. Sync the same changes here when releasing.

- The npm package's `repository` field links it to the plugin-list entry. Changes to this field take effect in the registry with the next publish.
- To add the plugin to awesome-dsh-plugin, submit `data/plugins/<owner>__<repo>.yml`. Numbers and API names in the description must be verifiable in the code. The listing requires `description.en` and `category: remote`; the package must declare `dsh.bundle`, and the repository must have the `dsh-plugin` topic.
- The repository-age check reruns automatically after the repository is one day old. Screenshots can be provided through `screenshots.json`; otherwise, the marketplace may find them in this README.
- The GitHub release page carries the mobile app's APK (linked at the top). Keep the asset name fixed at `ai-hub-android.apk` and publish it as a full release: drafts and pre-releases never become "latest", which would break that direct link. Plugin versions ship to npm, so no plugin releases are created here.
- Privacy policy: [PRIVACY.md](PRIVACY.md). Support and FAQ: [SUPPORT.md](SUPPORT.md).

### Publish a new version

1. Run `node scripts/bump-version.mjs` to update the version.
2. If `React/` changed, run `cd React && pnpm run build`.
3. Run `npm test` and inspect the package contents with `npm pack --dry-run`.
4. Run `npm publish` and complete the npm verification prompt.
5. Confirm the registry version with `npm view dsh-mobile-plugin version`, then sync the changes to the public repository.

## 📎 Remote-control metadata

Pairing requests may include device information. The app currently sends `id`, `deviceId`, `name`, `platform`, `osVersion`, and `appVersion`; the LAN proxy and relay server add the phone IP they observe.
