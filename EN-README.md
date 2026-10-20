# dsh-mobile-plugin

The AI-HUB mobile companion plugin for DSH. It provides the mobile API, remote connectivity, and a LAN proxy. It can also run as a headless Cordis Host without a desktop shell or Electron.

## Download the AI-HUB mobile app

- [Android APK](https://app.wnluo.com/public/apps/14)
- [Android APK (GitHub)](https://github.com/WNLUO/dsh-mobile-plugin/releases/latest/download/ai-hub-android.apk); [older versions](https://github.com/WNLUO/dsh-mobile-plugin/releases)
- [App Store](https://apps.apple.com/us/app/ai-hub/id6821681438) (If the page is temporarily unavailable, the app may still be awaiting Apple review approval.)
- [TestFlight beta](https://testflight.apple.com/join/4fn5PCMD)

## Features

- Connects the mobile app through a relay v2 tunnel and supports LAN proxying.
- Provides the restricted `/api/mobile/v1/*` mobile API.
- Supports session creation, workspace assignment, and session-order synchronization.
- Forwards device events over SSE and supports automatic archiving and session cleanup.
- Provides local configuration endpoints and pairing policies.

## Install and use

### DSH desktop

In DSH, open **Settings → Plugins** and install `dsh-mobile-plugin`. Then open **Settings → Mobile → Open configuration page** to configure connectivity and pairing. The plugin marketplace handles update checks and installation; updates generally do not require a DSH restart.

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

## Configuration and API

When running headless, use these local endpoints to manage remote connectivity:

- `POST /api/relay/toggle`: enable or disable remote control.
- `POST /api/relay/regenerate`: generate a new pairing code.
- `POST /api/relay/config`: configure `relayUrl`, `lanEnabled`, `lanPort`, `name`, and `pairingPolicy`.
- `POST /api/relay/reconnect`: reconnect the tunnel and LAN proxy.

The mobile API requires a Bearer token. The device event stream, `GET /api/mobile/v1/events/stream`, forwards host events over SSE. Session creation accepts `workspaceId` or `cwd`; `workspaceId` takes precedence and assigns the session to that workspace. Session ordering from the mobile app is synchronized with the host workspace.

The default pairing policy is `code`, which allows pairing with a valid pairing code. Set it to `deny` to reject all new pairing requests. Automatic archiving only hides eligible inactive sessions; it does not delete logs. The `session_cleanup` tool can archive sessions or permanently delete already-archived sessions. Deletion is irreversible and requires explicit confirmation.

## Headless deployment

On a headless server, the launcher and plugin package are managed separately. The deployment process synchronizes the launcher to `/opt/dsh-mobile/`; install the plugin package in the profile:

```sh
cd <DSH_HOME>/profiles/<profile>
pnpm add dsh-mobile-plugin@<version>
```

The host prefers the plugin installed in the profile and falls back to the source-tree version if it is not installed. The device credentials package is included with the npm package. Do not use `npm install --legacy-peer-deps`; use `pnpm install --frozen-lockfile` for the repository lockfile.

## Development

```sh
pnpm install --frozen-lockfile
npm test
```

After changing the panel source in `React/`, run `pnpm run build` in that directory and commit the generated `lib/panel/index.html` with the source.

## Repository and releases

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

## Remote-control metadata

Pairing requests may include device information. The app currently sends `id`, `deviceId`, `name`, `platform`, `osVersion`, and `appVersion`; the LAN proxy and relay server add the phone IP they observe.
