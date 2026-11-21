<!-- 无头宿主的预设加载、存储统计与归档清理说明。 -->
# 无头部署与配置接口

在没有任何图形界面的服务器上跑插件。同一份包可以当作无头宿主使用，手机连的是一台没有屏幕的机器。

## 无头 Host（Linux）

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

## 部署

无头服务器上，启动器和插件本体分开管：启动器由部署流程同步到 `/opt/dsh-mobile/`，插件本体装进 profile：

```sh
cd <DSH_HOME>/profiles/<profile>
pnpm add dsh-mobile-plugin@<版本>
```

宿主优先挂 profile 里装的那份，没装才用源码树版本。设备凭据库随 npm 包一起发，不用单独装。仓库锁文件用 `pnpm install --frozen-lockfile`。

无头 Host 按运行时的预设机制加载随包提供的移动标准预设，包括工具配置和移动端排查知识库。新版使用声明式预设，旧版保留目录加载。加载失败的预设会在手机上显示原因，并且不能设为默认档。

> 别用 `npm install --legacy-peer-deps` 装插件；正式安装走 DSH 插件市场。

## 远程连接接口

无头运行时用这几个本机接口管远程连接：

- `POST /api/relay/toggle`：开或关远程控制。
- `POST /api/relay/regenerate`：重新生成配对码。
- `POST /api/relay/config`：设置 `relayUrl`、`lanEnabled`、`lanPort`、`name` 和 `pairingPolicy`。
- `POST /api/relay/reconnect`：重连隧道与局域网代理。

## 移动 API

移动 API 要 Bearer token。设备事件流 `GET /api/mobile/v1/events/stream` 用 SSE 转发宿主事件。建会话时可以传 `workspaceId` 或 `cwd`，前者优先，并会把会话归进那个工作区；手机端的排序同样会同步到宿主工作区。完整契约见 [mobile-api-contract.md](mobile-api-contract.md)。

配对策略默认 `code`，凭配对码放行；设成 `deny` 就拒绝所有新配对。配对请求可以带设备信息，App 会发 `id`、`deviceId`、`name`、`platform`、`osVersion` 和 `appVersion`，局域网代理与中转会补上它们观察到的手机 IP。

## 会话清理

`session_cleanup` 能归档会话；使用默认 JSONL 存储时，也能永久删除归档过的会话。删除前要显式确认，删掉不可恢复。

**JSONL 存储的删除是排队的**：会话立刻从列表里消失，日志和投影缓存等宿主下次启动才从磁盘上清掉。宿主没有删除会话的接口，运行中删除正在使用的日志会导致读写失败。

使用 SQLite 存储时，归档和用量统计照常可用，永久清理会明确返回不支持；已排队的清理也会保留，不删除旧日志、不解除归档。迁移后留下的 JSONL 只保存迁移前的历史，不能据此判断数据库里的会话是否存在，也不能靠删掉它完成清理。
