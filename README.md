# dsh-mobile-plugin

[English](EN-README.md)

AI-HUB 手机端插件，为 DSH 提供移动 API、远程连接和局域网代理。插件也可作为无头 Cordis Host 独立运行，不依赖桌面外壳或 Electron。

## 下载 AI-HUB 手机 App

- [Android APK](https://app.wnluo.com/public/apps/14)
- [Android APK（GitHub 渠道）](https://github.com/WNLUO/dsh-mobile-plugin/releases/latest/download/ai-hub-android.apk)；[历史版本](https://github.com/WNLUO/dsh-mobile-plugin/releases)
- [App Store](https://apps.apple.com/us/app/ai-hub/id6821681438)（若暂时无法打开，可能是 App 仍在等待苹果审核通过。）
- [TestFlight 测试版](https://testflight.apple.com/join/4fn5PCMD)

## 功能

- 通过 relay v2 隧道连接手机 App，并支持局域网代理。
- 提供受限的 `/api/mobile/v1/*` 移动 API。
- 支持会话创建、工作区归属与会话排序同步。
- 支持设备事件 SSE 转发、自动归档和会话清理。
- 提供本机配置接口与配对授权策略。

## 安装与使用

### 在 DSH 桌面端

在 DSH 的 **设置 → 插件** 中搜索并安装 `dsh-mobile-plugin`。安装后，从 **设置 → 移动端 → 打开配置页面** 配置连接与配对。插件市场负责检查和安装更新；通常更新后无需重启 DSH。

### 无头 Host（Linux）

需要 Node.js、pnpm，以及可用的 DSH 插件宿主依赖。仓库提供 `host.js` 作为独立入口：

```sh
pnpm install --frozen-lockfile
DSH_HOME=/opt/dsh-mobile/.dsh DSH_MOBILE_PROFILE=mobile node host.js
```

`DSH_HOME` 是数据根目录，默认 `~/.dsh`；`DSH_MOBILE_PROFILE` 是 profile 名称，默认 `mobile`。无头 Host 的 Web 服务默认监听 `127.0.0.1:3080`，不对局域网直接开放。

配置接口仅限本机访问。可用以下地址查看状态和获取配对信息：

```sh
curl http://127.0.0.1:3080/api/relay/status
curl http://127.0.0.1:3080/api/relay/pairing
```

更多无头部署方式见下文「无头部署」。

## 配置与 API

无头运行时可通过本机接口管理远程连接：

- `POST /api/relay/toggle`：启用或关闭远程控制。
- `POST /api/relay/regenerate`：重新生成配对码。
- `POST /api/relay/config`：设置 `relayUrl`、`lanEnabled`、`lanPort`、`name` 和 `pairingPolicy`。
- `POST /api/relay/reconnect`：重新连接隧道与局域网代理。

移动 API 需要 Bearer token。设备事件流 `GET /api/mobile/v1/events/stream` 使用 SSE 转发宿主事件。创建会话时可传 `workspaceId` 或 `cwd`；前者优先，并将会话归入指定工作区。移动端排序也会同步到宿主工作区。

配对策略默认为 `code`（凭配对码放行）；设为 `deny` 时拒绝所有新配对。自动归档只隐藏符合条件的闲置会话，不删除日志。`session_cleanup` 工具可归档会话，也可永久删除已归档会话；删除不可恢复，需要显式确认。删除是「排进待删队列」：会话立刻从列表里消失，日志与投影缓存等宿主下次启动时才从磁盘上删掉 —— 宿主没有「删除会话」的接口，进程活着的时候从它脚底下删文件会让它读到不存在的日志，那是未捕获异常，会带走整个宿主进程。

## 无头部署

无头服务器的启动器与插件本体分开管理：启动器由部署流程同步到 `/opt/dsh-mobile/`，插件本体安装在 profile 中：

```sh
cd <DSH_HOME>/profiles/<profile>
pnpm add dsh-mobile-plugin@<版本>
```

宿主会优先挂载 profile 中安装的插件；未安装时才使用源码树版本。设备凭据库随 npm 包一同提供，不需要单独安装。仓库锁文件应使用 `pnpm install --frozen-lockfile`。

> 不要使用 `npm install --legacy-peer-deps` 安装插件；正式安装请使用 DSH 插件市场。

## 本机调试 OTA

新版插件的管理面板提供「本机调试 OTA」卡片，可手动检查并安装中转发布的紧急完整包。入口仅限宿主本机访问，不会由手机或公网触发；安装后通过实现代切换生效，切换失败会恢复上一代。npm 仍是正式发布源；后续 npm 正式版本达到 OTA 版本时会接管该版本。首次发布带此功能的 npm 包需要重启一次 DSH，让稳定外壳加载 OTA 能力。

发布一个紧急完整包：用仓库里的打包脚本，不要手工 `tar`。

```sh
# 只打包（产物在当前目录）
node scripts/pack-ota.mjs

# 打包并发布，发布后会下载回来核对哈希
node scripts/pack-ota.mjs --publish https://你的中转 --token <中转的 OTA 发布 token>
```

脚本做四件事：文件清单问 `npm pack --dry-run --json` 要（**不碰系统 tar**，三个平台同一份逻辑）、往包里写一份 `lib/ota-manifest.json`（版本 + 每个文件的路径与字节数）、用客户端的真解包器自检、发布后再下载回来比 sha256。中转那边也记哈希，客户端装之前会核对——半个包、被中间层改过的包都装不上去。

`--platform` 默认 `process.platform`（`darwin` / `linux` / `win32`）；这个插件是纯 JS，也可以 `--platform any` 发一份三个系统通用，客户端在自己平台没有包时会回落去问 `any`。`channel` 一般 `stable`。发布接口没配 token 时是关闭的，下载不受影响；版本按号比，最后发的那个才是「最新」。

## 开发

```sh
pnpm install --frozen-lockfile
npm test
```

修改 `React/` 面板源码后，先在该目录运行 `pnpm run build`，并将生成的 `lib/panel/index.html` 与源码一起提交。

## 仓库与发布

本仓库是插件的公开发布仓库，仓库根目录就是 npm 包根目录。开发与 App、中转服务器位于私有 monorepo，因此公开仓库的提交历史从拆分时开始；发布时需将同一次改动同步到公开仓库。

- npm 包的 `repository` 字段用于关联插件列表条目；修改后需再次发布，注册表信息才会更新。
- 插件列表收录通过向 awesome-dsh-plugin 提交 `data/plugins/<owner>__<repo>.yml` 完成。描述中的数字和 API 名称应能由代码核实；列表要求 `description.en`、`category: remote`，包需声明 `dsh.bundle`，仓库需有 `dsh-plugin` topic。
- 仓库创建满一天的检查会自动重跑；截图可通过 `screenshots.json` 提供，也可由市场从 README 查找。
- GitHub 的 release 页放手机 App 的 APK（下载入口见开头那一节）：资产名固定用 `ai-hub-android.apk`，并且发成正式版 —— 草稿与预发布都不会成为「最新」，README 里那条直连会随之断掉。插件自身走 npm 发布，不在本仓库发 release。
- 隐私政策：[PRIVACY.md](PRIVACY.md)。技术支持与常见问题：[SUPPORT.md](SUPPORT.md)。

### 发布新版本

1. 运行 `node scripts/bump-version.mjs` 更新版本号。
2. 若修改了 `React/`，运行 `cd React && pnpm run build`。
3. 运行 `npm test`，并用 `npm pack --dry-run` 检查发布文件。
4. 运行 `npm publish`，按提示完成 npm 二次验证。
5. 用 `npm view dsh-mobile-plugin version` 确认注册表版本，再同步改动到公开仓库。

## 远程控制元数据

配对请求可携带设备信息，App 当前发送 `id`、`deviceId`、`name`、`platform`、`osVersion` 和 `appVersion`；局域网代理与中转会补充观察到的手机 IP。
