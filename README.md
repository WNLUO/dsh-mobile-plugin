# dsh-mobile-plugin

AI-HUB 手机端的对端插件，同时充当**无头 Cordis Host**：它自带 Host 进程入口，提供 relay v2
隧道客户端、局域网代理，以及受限的 `/api/mobile/v1/*` 移动 API。本包**不依赖任何桌面外壳或
Electron 运行时**，`node host.js` 即可独立运行。

`POST /api/mobile/v1/session/new` 的 body 支持 `workspaceId` 或 `cwd`（二选一，前者优先）：传 `workspaceId` 时宿主会把新会话 attach 到该项目账上，宿主项目列表下立即可见；仅传 `cwd` 时会话归入宿主「未分组」。

`POST /api/mobile/v1/workspace/move-session` 透传宿主 `workspace.insertSessionBefore`，移动端拖动会话排序会同步写入宿主工作区。

设备级实时兼容出口：`GET /api/mobile/v1/events/stream`（Bearer token）以 SSE 转发宿主 `events.mux` 的所有设备事件。每帧包装为 `{ type: "device/event", version: 1, eventId, sessionId?, rpcId?, payload }`；`payload` 保留原 mux 负载，旧的 `/session/stream` 与 relay 协议不变。`session/event` 的 `eventId` 为 `${sessionId}:${event.seq}`，其他帧使用连接内序号。工作区变更是否可见取决于宿主 mux 是否发布对应帧；当前插件没有额外伪造工作区事件。

## 仓库与发布

本仓库是插件的**公开发布仓库**，仓库根就是包根：别人从这里读代码，也从这里核对这份代码的说法。

隐私政策（App Store / Google Play 上架用的那份，描述手机 App 会经手哪些数据）：[PRIVACY.md](PRIVACY.md)。

开发和 App 客户端、中转服务器放在一起进行（一个私有 monorepo），所以这里的提交历史从拆分那天开始，
不是项目历史 —— 每次发版，把同一次改动一起推到这里。

- **仓库地址要指回本仓库**：`package.json` 的 `repository` 字段是 npm 包与插件列表条目之间的唯一关联
  （列表侧从注册表自动采集，条目里不许手写 `npm:`）。改了它要等下一次 `npm publish` 才会体现在注册表上。
- **要被插件列表（awesome-dsh-plugin）收录**：往那个仓库提一个数据文件
  `data/plugins/<owner>__<repo>.yml` 就行，**一个文件即全部投稿**；`description.en` 必填，分类用 `remote`。
  硬门槛是 `package.json` 里声明 `dsh.bundle`（只声明 `dsh.client` 会被 CI 拒）、仓库创建满 1 天、
  以及本仓库打了 `dsh-plugin` topic。那条「满 1 天」的检查**会自己转绿**（列表侧每 6 小时重跑一次），
  当天看到红不用重提、也不用关了重开。
- **截图**：市场详情页要图，就在 `package.json` 旁边放一份 `screenshots.json`，列 1-8 张**本仓库内**的图片路径
  （相对路径不能跳出仓库；绝对地址只收 GitHub 托管的 https）。不声明也行，市场会自己从本 README 里找图。
- **描述会被对着代码核**：条目里写的每个数字和 API 名字都要在代码里找得到。夸大是唯一会被打回的原因 ——
  分类选得不准不会，维护者会直接改。

## 无头部署

部署到 Linux 服务器（无桌面环境）时的要点如下。

**目录布局不能漏掉凭据库。** 设备凭据库 `dsh-mobile-credentials` 就在本包目录内部（发布时它仍是独立的一个包，装进来后嵌在插件目录里），代码用包内相对路径引用它：

```js
lib/impl.js:26           require('../dsh-mobile-credentials/lib/credentials.js')
lib/mobile/auth.js:15    require('../../dsh-mobile-credentials/lib/credentials.js')
```

```
/opt/dsh-mobile/
├── dsh-mobile-plugin/
│   └── dsh-mobile-credentials/   # 嵌在插件目录内，漏掉就启动即崩
└── dsh-mobile-server/
```

> **用 pnpm 装，不要加 `--legacy-peer-deps`。**
>
> 本包的 `pnpm-lock.yaml` 是入库的依赖锁，而 pnpm 的 `autoInstallPeers` 会把 peer 冲突
> 一起解掉：`cordis-plugin-hmr@1.0.19` 要 `@deepseek-ai/cordis@~4.0.4`，锁里解析到的
> 正是 4.0.4。
>
> 这份文档以前教的是 `npm install --legacy-peer-deps`。那个参数只是让 npm 跳过 peer
> 冲突检查，不是解决冲突；仓库里又没有 `package-lock.json`，也就是说那次安装**什么都
> 没锁住**——每次干净安装解析出的树都可能不同。

```sh
cd dsh-mobile-plugin
pnpm install --frozen-lockfile     # 锁文件与 package.json 不同步时直接失败，而不是悄悄升级
```

> 锁与 `package.json` 的一致性由 `dsh-mobile-plugin/test/lockfile-sync.test.cjs` 守住。
> 真要让 cordis 对齐到别的版本，改 `package.json` 后跑一次 `pnpm install` 把锁更新进来。

**启动与数据根：**

```sh
DSH_HOME=/opt/dsh-mobile/.dsh DSH_MOBILE_PROFILE=mobile node host.js
# → dsh-mobile-plugin: mobile host ready (profile mobile)
```

`DSH_HOME` 决定数据根（profile、relay 配置、会话），不设则用 `~/.dsh`；`DSH_MOBILE_PROFILE`
决定 profile 名（默认 `mobile`），文件生成在 `$DSH_HOME/profiles/<name>/`。

**Web 端口固定 `3080` 且只绑 `127.0.0.1`**（`webserver` 行的端口表达式是 `ctx.webStartup.port ?? 3080`，
而 `host.js` 传空命令行参数，因此 `--port` 无效）。无头模式的 `web-runtime` 行关闭了
`openBrowser`/`printUrl`，所以**启动日志不会打印端口**，这不是故障。

## 安装与更新

本包有两条完全不同的安装路径，别混用。

**服务器 / 无头部署：启动器 rsync + 插件本体走 npm。**（2026-10-11 改）那一台是**两半**，别混着看：

- **启动器**：`host.js`、两层 patch、`config/`、内嵌的凭据包。把仓库目录 rsync 到 `/opt/dsh-mobile/`，
  然后 `systemctl restart dsh-mobile-host` —— 它只负责把宿主那棵树拼起来。
- **插件本体**：装在 profile 里，用 pnpm 从 npm 装：
  `cd <DSH_HOME>/profiles/<profile> && pnpm add dsh-mobile-plugin@<版本>`。宿主按**绝对路径**挂那份的
  `lib/index.js`（**稳定外壳**），所以这台面板里也有「检查 / 立即更新」，换代**不用重启宿主**。
  profile 的 `autoInstallPeers: false` 是刻意的：peer 依赖（`@deepseek-ai/*`）由宿主自己的依赖树供，
  两边必须解析到**同一份 realpath**，否则会出现两份 cordis（见 `lib/shell/manager.js` 的文件头）。
- 挂哪一份由 `host.js` 现场判断（`profile` 里有没有这个包，不看环境变量）：装了挂那份外壳；
  没装就退回**源码树直挂**（没有外壳，面板里更新不了，只能同步源码 + 重启宿主）。两种现场都会在
  启动日志里打一行「挂载方式 = …」，`npm run test:plugin:server` 会核对它。

**桌面端：从 npm 装，更新交给 DSH 的插件市场。**（2026-10 改的：此前是本包自带的 OTA +
「稳定外壳 + 可热替换的代」，那套已经删掉。）

- 包名 `dsh-mobile-plugin`，凭据库 `dsh-mobile-credentials` **内联在本包里**（`files` 收它），
  所以只发一个包、只有一个版本号要管。
- 装/更新都在 DSH 里做：**设置 → 插件**（插件市场）里安装或更新本插件，底层就是 profile 里
  跑一次 pnpm。装了之后「设置 → 移动端 → 打开配置页面」那一页的更新卡片会直接调市场的公共
  更新接口（`/dsh-market/api/v1/*`），能在页面上检查更新、开始更新、看进度，并在需要时请
  市场代劳重启 DSH。
- **更新后不需要重启 DSH**（2026-10-10 起）：插件入口是一个稳定外壳，市场在 profile 里装完新版，
  外壳会**就地换到新代码**（先把旧实现卸干净、再装新实现），面板那句「重启 DSH 才生效」不再是必须的。
  代价与边界照实说：① **装了外壳的那一版本身仍需重启一次**（旧版本入口就是实现本身，没有外壳可换），
  从再下一版起才真正免重启；② **外壳自己**（`lib/index.js` + `lib/shell/*`）在进程启动时就被 Node
  缓存了，改它要等下次启动 —— 面板会用 `shellChanged` 把这件事说出来，不让你猜；③ 客户端那半个文件
  （设置菜单里的入口）仍然是渲染器直读安装目录的，如果它改了需要刷新浏览器页面（所以这一半刻意保持
  不变，更新界面都放在宿主吐的面板里）。
- **自动更新**（面板 → 插件更新卡片里那个开关，默认关）：打开后每 10 分钟问一次 DSH 插件市场，
  有新版就自动装好并**立即切换**，全程不需要重启。手动点「更新」走的是同一条路。
- 有一个前提要认：市场**只从注册表更新**。如果这台机器上的插件是本地目录 / `file:` tgz 装的
  （市场把它报成 `linked`），自动更新会如实跳过并说明原因 —— 要享受这条链，得先在插件市场里按包名
  重装一次，切到 npm 来源。
- 如果「设置 → 移动端 → 打开配置页面」打不开、页面吐一段 `panel_missing` JSON：那段文案会
  写清是**哪一种**读不到 —— 「装完没重启」（旧实例还挂在这次安装删掉的那个目录上，最常见）、
  「装了老版本」（0.1.47 及更早还没有这一页）还是「真没构建」（源码树里才会遇到）。三种解法
  不同，别照着「没重启」的现场去跑 React 构建。同一句话也会进宿主 stderr。
- 从前那套的教训记在这里：热更新只换宿主侧的实现代，**换不掉设置菜单那一半**（渲染器直接从
  安装目录读它），于是出现过「更新报成功、界面一动不动」，重启 DSH、重启 sidecar 都没用。
  现在只有一条更新路径，这类「哪一半是旧的」不再存在。

### 发版流程（自己发一版更新）

1. **抬版本号**：`node scripts/bump-version.mjs`（三段各 `0..999`）。
2. **改过 `React/` 就先重建面板**：`cd React && pnpm run build`。产物 `lib/panel/index.html`
   是**提交物**，要和源码一起提交 —— 忘了重建，发出去的就是旧页面，而仓库里没有任何东西能
   替你发现（守卫只比字节形状，不比新旧）。
3. **自检**：`npm test`（其中 `panel-artifact` 管产物形状与「读不到时报什么」，
   `publish-payload` 管发布清单收得住每个会被加载的文件）；`npm pack --dry-run` 扫一眼发了什么。
4. **发布**：`npm publish`。
5. **核对**：`npm view dsh-mobile-plugin version`。
6. **到机器上更新**：DSH → 设置 → 插件 里更新，**然后完整重启 DSH**。

**发布这一步现在要你现场过二次验证**（2026-10 起，别以为是配错了）：

- `npm publish` 会打印一条 `https://www.npmjs.com/auth/cli/…` 链接（或直接开浏览器），用账号
  绑定的**安全密钥**确认一下，它自己接着把包发出去。
- 所以这一步**必须能打开 www.npmjs.com**：机房/代理出口 IP 会被它的反机器人拦成 403
  （页面写「访问暂时受限」并带上你的 IP）。换个节点或直连再发。
- npm 已经关掉了「命令行建号」和「验证器 App（TOTP）」两条路：建号只能在网页上做，2FA 只能挂
  安全密钥。这两件事上试命令是白费时间，认它就行。
- **别指望用「绕过 2FA」的令牌跳掉上面这一下**（2026-10-11 实测）：换上这把令牌之后 `npm whoami` 能过，但写操作照样要求交互式验证（拿 `npm dist-tag add` 试的），而 npm 2026-07-31 的公告说这类令牌 2027-01 起连直接发布也会失去。要自动化发布得迁到 trusted publishing（OIDC）或 staged publishing，本项目的发布是人在开发机上发，这两条都不顺手。
- 想少点一次确认，可以建一把「允许绕过 2FA」的细粒度令牌少输几次验证：
  `npm token create --bypass-2fa --packages dsh-mobile-plugin --packages-and-scopes-permission read-write --expires 90`
  （**最长 90 天**）。代价：这类令牌 **2027-01 起不能再直接发布**，到期或到点都得回到上面
  那条交互式路径。
- 还有个死结记在这里：令牌不能指向**还不存在**的包（会报
  `You do not have access to the requested package(s)`），所以**第一版只能用浏览器验证发**，
  令牌是「包已经存在之后」才有的便利。


插件没有 GUI 外壳，配置入口是插件注册在 `webServer` 上的**仅限本机访问**（`localOnly` 守卫）
的 HTTP 端点。`host.js` 启动后，其 `webServer.port` 就是下面 URL 里的 `<port>`
（无头部署下固定 `3080`）：

```sh
curl http://127.0.0.1:<port>/api/relay/status     # 实例 ID、连接地址、开关状态
curl http://127.0.0.1:<port>/api/relay/pairing    # 配对码 + 可直接扫码的 SVG 二维码
```

- `POST /api/relay/toggle` body `{"enabled":true|false}` —— 开关远程控制
- `POST /api/relay/regenerate` —— 轮换配对码
- `POST /api/relay/config` —— 改写 `relayUrl` / `lanEnabled` / `lanPort` / `name` / `pairingPolicy`（无 GUI 外壳时唯一的配置入口）
- `POST /api/relay/reconnect` —— 重新握手隧道与局域网代理

持久化配置在 `mobile-remote-control` 设置命名空间：`enabled`（默认 `false`）、`relayUrl`
（默认空，即只用局域网）、`lanEnabled`（默认 `true`）、`lanPort`（默认 `18787`）、`name`。
插件启动后**不向控制台打印配对信息**，只能经上述端点获取。

## 自动归档

插件默认启用 Host 侧自动归档：激活时扫描一次，此后每 12 小时扫描一次；项目内会话数超过 10 且最后更新时间超过 24 小时的非运行、非空白会话会被归档。归档只隐藏会话，不删除日志。

## 会话清理工具

插件注册模型工具 `session_cleanup`，可直接通过对话执行归档或永久删除。`action: "archive"` 按项目路径、闲置分钟数或会话 ID 筛选并隐藏会话；`action: "delete"` 只处理已经归档的会话，并且必须显式传入 `confirm: true`，删除会话日志和本地投影缓存。删除不可恢复，运行中、空白会话默认不会处理。

## 远程控制元数据

配对请求（relay 的 `pairRequest` 或局域网 `POST /__lan_pair`）可携带 `device` 对象，字段会原样转发并兼容旧版仅传 `code` 的请求。当前 App 发送 `id`、`deviceId`、`name`、`platform`、`osVersion`、`appVersion`，局域网代理与中转会补充服务端观察到的手机 `ip`。

## 配对授权策略

配对码校验始终由传输层完成（中转与局域网代理都用恒定时间比较，且中转对每实例每 IP 做 5 次失败锁定 60 秒）；校验通过后，宿主端由 `pairingPolicy` 决定是否准入，两条链路都汇总到同一个 `POST /api/relay/internal/approval`：

| 取值 | 行为 |
| --- | --- |
| `code`（默认） | 凭配对码放行 |
| `deny` | 拒绝一切新配对 |

原来的桌面端弹窗确认随桌面端一并删除，宿主已无 UI 承接逐次确认，因此改为该策略；`deny` 与删除前的 fail-closed 行为完全等价。策略求值在 [`lib/relay/pairing-policy.js`](lib/relay/pairing-policy.js)，不经过 sidecar worker，故未列入 worker 的 `configure` 白名单。走 `deny` 时每次决策都会写一行审计日志到 stderr。

`/api/mobile/v1/status` 和 `/api/relay/status` 返回宿主 `os`、`osVersion`、`arch`、`appVersion`；移动 token 的签发与校验仍严格绑定宿主 `instanceId`。
