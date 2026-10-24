<h3 align="center">AI-HUB 移动端插件</h3>

<p align="center">
  <img src="https://raw.githubusercontent.com/WNLUO/dsh-mobile-plugin/main/assets/banner.png" alt="AI-HUB：用手机接着电脑上的 DSH 往下用" width="100%">
</p>

<p align="center">
  <a href="https://apps.apple.com/us/app/ai-hub/id6821681438"><img alt="App Store" src="https://img.shields.io/badge/App_Store-%E4%B8%8B%E8%BD%BD-black?style=for-the-badge&logo=appstore&logoColor=white"></a>
  <a href="https://app.wnluo.com/public/apps/14"><img alt="Android APK" src="https://img.shields.io/badge/Android_APK-%E4%B8%8B%E8%BD%BD-3DDC84?style=for-the-badge&logo=android&logoColor=white"></a>
  <a href="https://github.com/WNLUO/dsh-mobile-plugin/releases/latest/download/ai-hub-android.apk"><img alt="GitHub APK" src="https://img.shields.io/badge/GitHub_APK-%E6%9C%80%E6%96%B0%E7%89%88-181717?style=for-the-badge&logo=github"></a>
  <a href="https://testflight.apple.com/join/4fn5PCMD"><img alt="TestFlight" src="https://img.shields.io/badge/TestFlight-%E6%B5%8B%E8%AF%95%E7%89%88-0D96F6?style=for-the-badge&logo=apple&logoColor=white"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-mobile-plugin"><img alt="npm" src="https://img.shields.io/npm/v/dsh-mobile-plugin?style=flat-square"></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="platform" src="https://img.shields.io/badge/platform-iOS%20%7C%20Android-999999?style=flat-square">
  <a href="EN-README.md"><img alt="English" src="https://img.shields.io/badge/README-English-2f81f7?style=flat-square"></a>
</p>

<p align="center">电脑上开着的 DSH，手机上接着用。</p>

**AI-HUB 的手机端插件。** 装在电脑这边，手机 App 就通过一条中转隧道或局域网配对连进你的 DSH —— 看会话、接着聊、管理文件和工作区，进度实时同步。它也可以脱离桌面外壳单独跑在服务器上，当作无头宿主用。

## 🌟 功能

- 🚀 **两种连法**：经 relay v2 隧道从公网连回来，或者在同一个 Wi-Fi 下走局域网代理直连。
- 📱 **受限的移动 API**：`/api/mobile/v1/*` 只开手机需要的口子 —— 不暴露 shell、系统设置与任意文件写入。
- 🗂️ **会话与工作区**：新建会话、归入指定工作区，手机端排的顺序也会同步回电脑。
- 📡 **实时事件**：设备事件 SSE 全程转发，手机上看到的就是电脑那边的进度。
- 🧹 **自动归档**：闲置会话自动收进归档，只从列表里隐藏，日志不删。
- 🔐 **配对与凭据**：本机配置接口、可选的配对策略，设备凭据可以单独吊销。

## 📥 下载 AI-HUB 手机 App

- [App Store](https://apps.apple.com/us/app/ai-hub/id6821681438)（正式版，已在架）
- [Android APK](https://app.wnluo.com/public/apps/14)
- [Android APK（GitHub 渠道）](https://github.com/WNLUO/dsh-mobile-plugin/releases/latest/download/ai-hub-android.apk)；[历史版本](https://github.com/WNLUO/dsh-mobile-plugin/releases)
- [TestFlight 测试版](https://testflight.apple.com/join/4fn5PCMD)（比商店版先拿到新构建，正式版照常从 App Store 更新）

装好 App 只有一半，另一半是这个插件。

## 🚀 安装与更新

### 桌面端

在 DSH 的 **设置 → 插件** 里搜索并安装 `dsh-mobile-plugin`，然后打开 **设置 → 移动端 → 打开配置页面** 做配对。插件市场负责检查和安装更新，通常更新后不用重启 DSH。

### 无头 Host（Linux）

需要 Node.js、pnpm，以及可用的 DSH 插件宿主依赖。仓库里的 `host.js` 就是独立入口：

```sh
pnpm install --frozen-lockfile
DSH_HOME=/opt/dsh-mobile/.dsh DSH_MOBILE_PROFILE=mobile node host.js
```

`DSH_HOME` 是数据根目录，默认 `~/.dsh`；`DSH_MOBILE_PROFILE` 是 profile 名称，默认 `mobile`。无头 Host 的 Web 服务默认只监听 `127.0.0.1:3080`，不对局域网直接开放。

配置接口只限本机访问，看状态和拿配对信息：

```sh
curl http://127.0.0.1:3080/api/relay/status
curl http://127.0.0.1:3080/api/relay/pairing
```

更多的部署方式见下面的「无头部署」。

## 🔌 配置与 API

无头运行时用这几个本机接口管远程连接：

- `POST /api/relay/toggle`：开或关远程控制。
- `POST /api/relay/regenerate`：重新生成配对码。
- `POST /api/relay/config`：设置 `relayUrl`、`lanEnabled`、`lanPort`、`name` 和 `pairingPolicy`。
- `POST /api/relay/reconnect`：重连隧道与局域网代理。

移动 API 要 Bearer token。设备事件流 `GET /api/mobile/v1/events/stream` 用 SSE 转发宿主事件。建会话时可以传 `workspaceId` 或 `cwd`，前者优先，并会把会话归进那个工作区；手机端的排序同样会同步到宿主工作区。

配对策略默认 `code`，凭配对码放行；设成 `deny` 就拒绝所有新配对。

`session_cleanup` 工具能归档会话，也能永久删除归档过的会话，删除前要显式确认，删掉不可恢复。**删除是排队的**：会话立刻从列表里消失，日志和投影缓存等宿主下次启动才从磁盘上删 —— 宿主没有「删除会话」的接口，进程活着的时候从它脚底下删文件，它会打开一个已经不在的日志，那是未捕获异常，会带走整个宿主进程。

## 🖥️ 无头部署

无头服务器上，启动器和插件本体是分开管的：启动器由部署流程同步到 `/opt/dsh-mobile/`，插件本体装进 profile：

```sh
cd <DSH_HOME>/profiles/<profile>
pnpm add dsh-mobile-plugin@<版本>
```

宿主优先挂 profile 里装的那份，没装才用源码树版本。设备凭据库随 npm 包一起发，不用单独装。仓库锁文件用 `pnpm install --frozen-lockfile`。

> 别用 `npm install --legacy-peer-deps` 装插件；正式安装走 DSH 插件市场。

## 🔄 本机调试 OTA

新版插件的管理面板里有张「本机调试 OTA」卡片，可以手动检查并安装中转发布的紧急完整包。入口只认宿主本机的访问，手机和公网都触发不了；装完靠切换实现代生效，切换失败会退回上一代。正式发布源仍然是 npm，等 npm 上的版本号追到 OTA 版本时就自动接管。第一次发带这个功能的 npm 包需要重启一次 DSH，让稳定外壳把 OTA 能力加载进来。

要发一个紧急完整包，用仓库里的打包脚本，别手工 `tar`：

```sh
# 只打包（产物在当前目录）
node scripts/pack-ota.mjs

# 打包并发布，发布后会下载回来核对哈希
node scripts/pack-ota.mjs --publish https://你的中转 --token <中转的 OTA 发布 token>
```

脚本干四件事：文件清单问 `npm pack --dry-run --json` 要（**不碰系统 tar**，三个平台同一份逻辑）、往包里写一份 `lib/ota-manifest.json`（版本 + 每个文件的路径与字节数）、用客户端的真解包器自检、发布后再下载回来比 sha256。中转那边也记哈希，客户端装之前会核对 —— 半个包、被中间层改过的包都装不上去。

`--platform` 默认 `process.platform`（`darwin` / `linux` / `win32`）；这个插件是纯 JS，也可以 `--platform any` 发一份三个系统通用，客户端在自己平台没有包时会回落去问 `any`。`channel` 一般 `stable`。发布接口没配 token 时是关闭的，下载不受影响；版本按号比，最后发的那个才是「最新」。

## 👨‍💻 开发

```sh
pnpm install --frozen-lockfile
npm test
```

改过 `React/` 面板源码，先在该目录跑 `pnpm run build`，并把生成的 `lib/panel/index.html` 和源码一起提交。

## 📦 仓库与发布

这里是插件的公开发布仓库，仓库根就是 npm 包根。开发和 App、中转服务器一起放在私有 monorepo 里，所以这个仓库的提交历史从拆分那天开始；发布时要把同一次改动同步过来。

- npm 包的 `repository` 字段负责关联插件列表条目，改完要再发一次版，注册表里的信息才会更新。
- 收录靠往 awesome-dsh-plugin 提 `data/plugins/<owner>__<repo>.yml`。描述里的数字和 API 名称都要能在代码里核实；列表要求 `description.en`、`category: remote`，包要声明 `dsh.bundle`，仓库要有 `dsh-plugin` topic。
- 「仓库创建满一天」这条检查过一阵会自己重跑。截图可以用 `screenshots.json` 提供，也可以让市场从这个 README 里找。
- GitHub 的 release 页放手机 App 的 APK（下载入口见开头那一节）：资产名固定用 `ai-hub-android.apk`，而且要发成正式版 —— 草稿和预发布都不会成为「最新」，README 里那条直连跟着就断了。插件自己走 npm 发布，不在这个仓库发 release。
- 隐私政策：[PRIVACY.md](PRIVACY.md)。技术支持与常见问题：[SUPPORT.md](SUPPORT.md)。

### 发版流程

**顺序是死的：抬号重建 → 提交 → 预检全绿 → 同步 → 打 tag → 等流水线。** 预检没过不许往下走，尤其不许「先把 tag 推上去看看」。

1. 跑 `node scripts/bump-version.mjs` 更新版本号（演示页的 `DEMO_VERSION` 会一起改，别手改）。
2. 改过 `React/` 就跑 `cd React && pnpm run build`。
3. 提交这次发版该带的文件，别 `git add -A`。
4. 在**主仓**的插件目录跑 `npm run release:check`。它按固定顺序查六件事：是不是在主仓里（跨仓对账要读 `app/`）、版本号与 tag（三段 `0..999`、这个 tag 没打过、不比上一版低）、工作区干不干净、面板产物有没有跟上面板源码、整套测试、真打一次包看文件清单。任何一步红就停，并说明该修哪里。**它要求在提交之后跑**，因为查的是「发出去的那一份」。
5. 把提交同步到公开仓库 `WNLUO/dsh-mobile-plugin`。
6. 推一个与版本号同名的 tag（版本 0.1.99 就推 `v0.1.99`）。那个仓库的 `.github/workflows/publish.yml` 会跑测试并直接发布，不需要人在浏览器里点二次验证 —— 它走 npm 的 trusted publishing（OIDC），npm 认的是这条流水线而不是某个令牌。
7. 等流水线绿。它末尾自己会核 `npm view dsh-mobile-plugin version`，你也可以手动看一眼。
8. 要在本机用上新版就跑 `node scripts/reload-dev.mjs`（打包 + 正规安装 + 就地重载），它报 ✔ 才算数。

两条别弄反：

- **流水线是第二道闸，不是唯一一道。** 它在单独检出里跑，跨仓对账（手机端接口常量 ↔ 插件路由表）会自己跳过；面板产物它只查「在不在包里」，查不出新旧。这两件事只有第 4 步能查。
- **热重载报 ✔ 不算测过。** 它把当前工作区装进 profile 跑一遍，不跑测试、不打包，也碰不到任何跨版本组合（老 App 配新插件之类）。它证明的是装载没问题，不是这一版能发。

`npm publish` 仍能在开发机上手动跑，但现在要人过二次验证：账号上只有安全密钥时，npm 会打印一条 `www.npmjs.com/auth/cli/…` 链接，要用密钥在浏览器里点一下，且发起那台机器的出口 IP 要能打开 npm 官网。这条路留着应急，日常发版走 tag。

## 📎 远程控制元数据

配对请求可以带设备信息，App 现在会发 `id`、`deviceId`、`name`、`platform`、`osVersion` 和 `appVersion`；局域网代理与中转会补上它们观察到的手机 IP。
