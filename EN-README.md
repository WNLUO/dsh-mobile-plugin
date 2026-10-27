<h3 align="center">AI-HUB mobile plugin</h3>

<p align="center">
  <img src="assets/banner.jpg" alt="AI-HUB: DSH sessions on a phone and a tablet" width="760">
</p>

<p align="center">
  <a href="https://app.wnluo.com/public/apps/14"><img alt="Android download" src="https://img.shields.io/badge/Android-Download-3DDC84?style=for-the-badge&logo=android&logoColor=white"></a>
  <a href="https://github.com/WNLUO/dsh-mobile-plugin/releases/latest/download/ai-hub-android.apk"><img alt="Android GitHub" src="https://img.shields.io/badge/Android-GitHub-181717?style=for-the-badge&logo=github"></a>
  <a href="https://apps.apple.com/us/app/ai-hub/id6821681438"><img alt="App Store" src="https://img.shields.io/badge/App_Store-Download-black?style=for-the-badge&logo=appstore&logoColor=white"></a>
  <a href="https://testflight.apple.com/join/4fn5PCMD"><img alt="iOS beta" src="https://img.shields.io/badge/iOS_Beta-Download-0D96F6?style=for-the-badge&logo=apple&logoColor=white"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-mobile-plugin"><img alt="npm" src="https://img.shields.io/npm/v/dsh-mobile-plugin?style=flat-square"></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="platform" src="https://img.shields.io/badge/platform-iOS%20%7C%20Android-999999?style=flat-square">
  <a href="README.md"><img alt="中文" src="https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-2f81f7?style=flat-square"></a>
</p>

<p align="center">Pick up on your phone where your desktop left off.</p>

**The mobile-side plugin for AI-HUB.** Install it on the computer and the phone app reaches your DSH through a relay tunnel or a LAN pairing — browse sessions, keep chatting, manage files and workspaces, with progress synced live. It also runs on a server without a desktop shell, as a headless host.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/WNLUO/dsh-mobile-plugin/main/assets/connection-en-dark.svg">
    <img src="https://raw.githubusercontent.com/WNLUO/dsh-mobile-plugin/main/assets/connection-en-light.svg" alt="The phone app reaches the DSH on your computer through a relay, or directly over the LAN" width="720">
  </picture>
</p>

Your phone talks to **the DSH running on your own computer**, not to a cloud service. That computer needs no public IP address and no port forwarding: the plugin dials out from the local network, and the phone comes back along that tunnel.

## Features

### Sessions and workspaces

- Create, resume, rename, and search sessions — or fork any of them into a branch that runs on its own.
- Create, rename, delete, pin, and archive workspaces from the phone; the order you set there syncs back to the desktop.
- Replies stream in chunk by chunk, so you see the text while it is still being written, and tool calls land in real time.
- Idle sessions archive themselves, dropping out of the list without deleting their logs.
- Reading a session on the phone clears its unread dot on the desktop; sidebar expansion state syncs to the phone, so both sides show the same shape.

### Everything you would otherwise walk back for

- **Approvals and questions**: the same cards that pop up on the desktop show up on the phone — permission requests, single choice, multi-select, and free-form answers are all tappable.
- **Queue a line mid-run**: add something while a turn is running and it lands right after the current step.
- **Git**: status and diff, stage, commit, push, switch branches; let the model draft the commit message.
- **Files**: browse directories, read files, and send files from the phone back to the computer, where they land in a fixed inbox directory.
- **Plugins**: search, install, update, and remove plugins from the marketplace on the phone; the plugin can also upgrade itself.
- **Models**: switch models at any time, see which channels and models are available, and configure locally defined channels from the phone.
- **Schedules and subagents**: list scheduled tasks and drop the ones you no longer need; watch running subagents, interrupt one, or send it a line.

### Connection

- Two ways in: back over the relay v2 tunnel from anywhere, or straight through the LAN proxy on the same Wi-Fi.
- Pairing codes with an optional pairing policy; device credentials can be revoked one by one or all at once.
- Optional iOS push notifications; leaving it off affects nothing else.

The mobile API exposes only what the phone needs (`/api/mobile/v1/*`) — no shell, no system settings, no arbitrary file writes.

## Install and update

Installing the app is only half of it; the plugin on this side is what connects it.

### DSH desktop

In DSH, open **Settings → Plugins**, install `dsh-mobile-plugin`, then open **Settings → Mobile → Open configuration page** to pair. The plugin marketplace handles update checks and installation; an update usually does not need a DSH restart.

### Headless host (Linux)

Requires Node.js, pnpm, and the DSH plugin host dependencies. `host.js` in this repository is the standalone entry point:

```sh
pnpm install --frozen-lockfile
DSH_HOME=/opt/dsh-mobile/.dsh DSH_MOBILE_PROFILE=mobile node host.js
```

`DSH_HOME` is the data root and defaults to `~/.dsh`; `DSH_MOBILE_PROFILE` is the profile name and defaults to `mobile`. The headless host's web service listens on `127.0.0.1:3080` only and is not reachable from the LAN.

The configuration endpoints are local-only. Check status and read pairing info with:

```sh
curl http://127.0.0.1:3080/api/relay/status
curl http://127.0.0.1:3080/api/relay/pairing
```

### Headless deployment

On a headless server the launcher and the plugin are managed separately: the launcher is synced to `/opt/dsh-mobile/` by your deployment process, while the plugin itself goes into the profile:

```sh
cd <DSH_HOME>/profiles/<profile>
pnpm add dsh-mobile-plugin@<version>
```

The host prefers the copy installed in the profile and falls back to the source tree. The device credential store ships inside the npm package, so there is nothing extra to install. Lockfiles are installed with `pnpm install --frozen-lockfile`.

> Do not install the plugin with `npm install --legacy-peer-deps`; the supported path is the DSH plugin marketplace.

## Configuration and API

When running headless, these local endpoints manage the remote connection:

- `POST /api/relay/toggle`: turn remote control on or off.
- `POST /api/relay/regenerate`: regenerate the pairing code.
- `POST /api/relay/config`: set `relayUrl`, `lanEnabled`, `lanPort`, `name`, and `pairingPolicy`.
- `POST /api/relay/reconnect`: reconnect the tunnel and the LAN proxy.

The mobile API requires a Bearer token. The device event stream `GET /api/mobile/v1/events/stream` forwards host events over SSE. Creating a session accepts either `workspaceId` or `cwd`; the former wins and files the session into that workspace. Session ordering set on the phone syncs to the host workspace as well.

The pairing policy defaults to `code`, admitting devices that present a valid pairing code; set it to `deny` to reject every new pairing. Pairing requests may carry device information — the app sends `id`, `deviceId`, `name`, `platform`, `osVersion`, and `appVersion`, and the LAN proxy and relay add the phone IP they observed.

`session_cleanup` archives sessions and can permanently delete archived ones. Deletion asks for explicit confirmation and cannot be undone. **Deletion is queued**: the session disappears from the list immediately, while its logs and projection cache are removed from disk on the next host start — the host has no "delete session" endpoint, and deleting files out from under a running host makes it open a log that is no longer there, which is an uncaught exception that takes the whole host process with it.

## Why I built this

DSH runs on my computer, and I am not always sitting in front of it. Out of the house, in another room, lying in bed — when I want to know how far a task got, or it is stuck on an approval waiting for me to tap, the only option used to be walking back.

The starting point is that narrow: this does not squeeze DSH onto a phone screen. It lets you see, keep talking, and tap the thing that needs tapping after you leave the desk.

That made two constraints hard. One is networking: no public IP, no port forwarding on the router, no DDNS set up just to use it once — the plugin dials out from the local network and the phone comes back along that tunnel. The other is capability: the phone gets only the openings it needs — sessions, approvals, file transfer, some configuration — but not a shell and not arbitrary file writes. If the phone is lost or picked up by someone else, the damage is bounded and knowable.

## Alternatives

**Opening DSH's web interface in a mobile browser**: nothing to install, but you have to remember the address every time, the layout is sized for a desktop, and you navigate by pinch-zooming and dragging. No push notifications either, so the moment you leave the page you know nothing — and approvals are the worst of it, since they need a precise tap.

**Remote desktop**: you are still operating that screen, with the phone as a monitor. Lose the network and you get a black screen, and on a small display every action starts with zooming in.

**The mobile apps from AI assistant vendors**: those run on the vendor's servers, and your sessions, files, and quota live there. This connects to the DSH on your own computer, with models you configured and files on your own disk.

## Contact

<p align="center">
  <img src="assets/wechat-group.png" alt="WeCom group QR code" width="180">
</p>

Scan the code above to join our WeCom group. If that is awkward, email <admin@wnluo.com> or <wnluo2@gmail.com>. If it works well for you, a star on the repository is the most concrete way to help.

Privacy policy: [PRIVACY.md](PRIVACY.md). Support and FAQ: [SUPPORT.md](SUPPORT.md).

## Development

```sh
pnpm install --frozen-lockfile
npm test
```

If you changed anything under `React/`, run `pnpm run build` there first and commit the generated `lib/panel/index.html` together with the source.

## License

MIT, see [LICENSE](LICENSE).
