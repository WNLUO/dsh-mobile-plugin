# 移动端接口契约（协议 v2）

本文面向要对接本插件宿主的所有移动客户端开发者——包括官方 App，以及计划自行实现
鸿蒙（HarmonyOS）或其它平台的第三方客户端。目标是让一条独立的实现只依据这份契约和
测试向量，就能与宿主完成配对、建立加密会话、调用移动 API。

范围：

- 配对握手与 `sealed` 载荷：票据、密钥派生、AES-256-GCM、密文形状、字段约束。
- 配对之后的鉴权头与协议 v2 请求/响应信封。
- 移动端端点清单（按域分组）。

本文的事实以仓库源码为准；凡是与源码不一致的地方，以源码为准。加密字节口径的最终裁判是
`test/e2ee-vectors.json`——两端先各自跑通它，再谈联调。

---

## 0. 术语与总览

| 术语 | 含义 |
| --- | --- |
| 宿主（host） | 运行 `dsh web` 并加载本插件的这台电脑。移动 API 由它应答。 |
| 中转（relay） | 独立的纯转发隧道（`dsh-mobile-server` 编出的 `dsh-relay`）。它只按实例号转发，不判断"谁能进这台机器"。 |
| 实例号（instanceId） | 宿主的唯一标识，形如 `a1b2c3d4`。多台宿主共用一个中转时，中转靠它决定把请求转给谁。 |
| 票据（ticket） | 写在配对二维码里的一次性凭据，32 字节随机数，编码为 43 字符 base64url。它**只写在二维码里，绝不经过中转**。 |
| T1 凭据 | 每设备凭据，形如 `<instanceId>.<exp>.<随机串>`，同时充当 token、cookie 与设备凭据。 |

协议有两代：

- **v1（旧）**：手输六位配对码，请求/回包均明文。仅为升级前的老客户端保留，新客户端不应再实现。
- **v2**：扫码带票据，配对请求与回包都加密，配对之后每条业务请求都走加密信封。本文描述 v2。

协议版本在**配对握手时定死**，不逐请求协商。宿主在配对回包里回 `proto`（v2 为 `2`），
客户端据此落盘，之后每条请求按它决定发不发信封。

---

## 1. 配对握手

### 1.1 端点

```
POST /api/mobile/v1/pair
Content-Type: application/json
```

这条路径由宿主应答（不是中转）。它**不要求鉴权**——配对之前客户端手上还没有任何凭据。
局域网直连还有一条同义的入口 `/__lan_pair`，两者签发同一种凭据、行为一致；本文以
`/api/mobile/v1/pair` 为准。

### 1.2 请求体

两种形状都认，由请求体里有没有 `sealed` 决定：

**v2（新）**

```json
{ "instanceId": "a1b2c3d4", "sealed": "<base64>", "ticketId": "<可选>" }
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `sealed` | 是 | 加密后的配对请求，标准 base64。形状见 §1.5。 |
| `instanceId` | 否 | 客户端自报的目标实例号。**若带了就必须与宿主实例号一致**，否则拒绝。 |
| `ticketId` | 否 | 批量导入时用的一次性券编号。带它就从宿主的一次性券表取票据，否则用面板二维码那张票据。 |

**v1（旧，仅兼容）**

```json
{ "instanceId": "a1b2c3d4", "code": "123456", "device": { "name": "iPhone" } }
```

`code` 为六位数字。这条老形状一字未改地照旧工作，但新客户端不要实现它。

**形状判定规则**（宿主侧逻辑，客户端按此发即可）：

- 有 `sealed` → 走 v2。
- 没有 `sealed` 但有 `code` → 走 v1 老形状。
- 既没有 `sealed` 也没有 `code`，但请求体带了 `proto` 字段 → 视为过期旧二维码，回
  `400 { ok:false, code:"legacy-pairing-retired" }`，应提示用户重新扫码。
- 两者都没有、也没有 `proto` → 按畸形请求处理。

### 1.3 票据与配对密钥

票据是 32 字节随机数；在二维码里以 **43 字符 base64url** 编码传递。客户端取到后先做
base64url 解码，得到 32 字节原始票据，再派生配对密钥：

```
pairKey = HKDF-SHA256(
  ikm  = ticket          // 32 字节原始票据
  salt = instanceId      // UTF-8 字节
  info = "dsh-pair-v2"   // UTF-8
  len  = 32 字节
)
```

`salt` 取实例号，把不同宿主的两张二维码绑死在各自机器上：同一张票据换一个实例号，
派生出的密钥也不同。

### 1.4 加密算法与 AAD

- AEAD：**AES-256-GCM**，tag 长度 16 字节。
- nonce：12 字节随机。
- 配对阶段使用的 AAD 字符串为：

  ```
  pair|v2|<instanceId>
  ```

  按 UTF-8 编码后作为 AAD 传入。

> 说明：AEAD 选 AES-256-GCM 而不是 ChaCha20-Poly1305，是因为桌面宿主跑在 Electron 里、
> 链接的是 BoringSSL，没有 chacha20-poly1305。两端都要能算，AES-256-GCM 是共同解。

### 1.5 密文形状

`seal` 的输出是一段连续字节：

```
nonce(12 字节) || 密文 || tag(16 字节)
```

配对请求与回包都把这整段字节做**标准 base64** 后放进 `sealed` 字段。

- 请求：客户端构造 `nonce||密文||tag`，base64 后作为请求体的 `sealed` 发出。
- 回包：宿主用同一把 `pairKey`、同一 AAD 封装业务明文，base64 后作为回包的 `sealed`。

解封时若认证失败，必须整条失败、返回错误，**绝不返回半截明文**。密文总长不足
`12 + 16 = 28` 字节可直接判为非法。

### 1.6 请求 `sealed` 的明文

解密后是一段 UTF-8 JSON。客户端在配对请求里必须放入：

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `deviceKey` | 必须匹配 `^[A-Za-z0-9_-]{43}$`（43 字符 base64url，解码后 32 字节） | 设备主密钥。宿主用它重算会话密钥、验签。 |
| `keyId` | 必须匹配 `^[0-9a-f]{16}$`（16 位小写十六进制） | 设备密钥标识。后续请求用它告诉宿主该拿哪把 deviceKey。 |
| `device` | 对象，可选 | 设备元信息（如 `name`、`platform`），供宿主记录与展示。 |

`deviceKey` 与 `keyId` 的形状由宿主在解封后强制校验，形状不对立即拒绝，不会写入凭据库。
客户端必须保证这两个值符合上述正则。

### 1.7 回包

**v2 回包是密文，`sealed` 里是业务明文**，外形固定为：

```json
{ "ok": true, "proto": 2, "sealed": "<base64>" }
```

客户端用配对时派生的同一把 `pairKey`、同一 AAD（`pair|v2|<instanceId>`）解封 `sealed`，
得到明文 JSON。明文可能包含以下字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | boolean | 恒为 `true`。 |
| `proto` | number | 协议版本；v2 为 `2`，v1 旧形状为 `1`。客户端据此落盘。 |
| `instanceId` | string | 宿主实例号。 |
| `token` | string | 每设备凭据（T1），见 §2.1。 |
| `cookie` | string | `dsh_lan=<token>`，供 RN 的 fetch 存 cookie 用（RN fetch 读不到 `Set-Cookie`）。 |
| `deviceId` | string | 本设备在宿主凭据库里的记录 id。 |
| `deviceCredential` | string | 设备凭据，值等于 `token`。 |
| `credentialExpiresAt` | number | 凭据过期时间（毫秒时间戳）。 |
| `serverTime` | number | 宿主当前时间（毫秒），客户端用于校准时钟。 |
| `hostPlatform` | string | 宿主系统平台标识（可选，宿主有该信息时才带）。 |
| `lanUrls` | string[] | 局域网直连候选（可选，关掉局域网直连或没有候选时不带）。 |
| `ipv6Candidates` | string[] | IPv6 直连候选（可选）。 |

**必须把回包当密文读，不允许回退明文。** 明文里是 `token` / `cookie` / `deviceCredential`，
都是可直接冒用的长期凭据；一旦实现里留了"解不开就按明文读"的兜底，链路中间的人只要老实
转发就能拿到这台设备的通行证，前面所有加密都白做。认证失败就是失败，重来。

> 上述字段名与含义以 `lib/mobile/pairing.js` 的回包构造为准。`hostPlatform` / `lanUrls` /
> `ipv6Candidates` 是可选字段，不是每次都在。

### 1.8 错误

| HTTP | 响应体 | 触发条件 |
| --- | --- | --- |
| 400 | `{ ok:false, error:"请求体不是合法 JSON" }` | 请求体不是合法 JSON。 |
| 400 | `{ ok:false, code:"legacy-pairing-retired", error:"..." }` | 过期旧二维码（见 §1.2 判定）。 |
| 401 | `{ ok:false, error:"配对码错误" }` | 配对失败统一回这一句，含解封失败、票据不对等，不区分细节。 |
| 429 | `{ ok:false, error:"尝试过于频繁，请稍后再试" }`，带 `Retry-After` 头 | 触发限流。 |
| 500 | `{ ok:false, error:"internal error" }` | 宿主内部错误。 |

配对成功后，宿主会作废本次资格（换二维码票据或消费一次性券），同一张二维码不能配对第二次。

---

## 2. 配对之后的请求

### 2.1 凭据

配对回包里的 `token`、`cookie` 的值、`deviceCredential` 三样是**同一枚**每设备凭据（T1），
形如 `<instanceId>.<exp>.<随机串>`。它既是通行证、又能在宿主凭据库里查到（用于吊销、过期、
续期与单设备解绑）。

客户端应把它当作设备凭据保存，后续请求二选一携带：

- 首选：放在 `X-Dsh-Device-Credential` 头里。
- 兼容：作为 `Authorization: Bearer <token>` 发。

宿主鉴权顺序为：`X-Dsh-Device-Credential` 头 → `Authorization: Bearer` → 旧 HMAC 令牌兜底。
若出示的凭据在库里查得到，**以库里记录为准**（吊销或过期立即拒绝，不再回退）；查不到才回退
到旧的无状态 HMAC 令牌。因此同一枚凭据被吊销后，不会因为"还能验 HMAC"而复生。

鉴权失败时宿主回明文 `401`，并带 `error.code` 区分原因：

- `device-revoked`：这台设备已被解除绑定，应提示重新扫码。
- `device-expired`：授权已过期，应提示重新扫码。
- `unauthorized`：缺少或无效的移动 token。

这三种响应都是**明文**，客户端要在解不开信封的情况下也能读懂。

### 2.2 请求头清单

| 头 | 必填 | 说明 |
| --- | --- | --- |
| `X-Dsh-Instance` | 走中转时必填 | 目标实例号，多台宿主共用一个中转时用来路由到正确的宿主。客户端从配对回包里的 `instanceId` 取。 |
| `X-Dsh-Device-Credential` | 二选一 | 设备凭据（T1），见 §2.1。 |
| `Authorization` | 二选一 | `Bearer <token>`。 |
| `X-Dsh-Proto` | v2 加密请求必填 | 值为 `2`，表示这条请求使用协议 v2 信封。 |
| `X-Dsh-Device` | 建议 | 本机设备 id（`deviceId`），宿主据此认设备。 |
| `X-Dsh-Device-Name` | 可选 | 用户给设备起的名字；仅供展示。 |
| `X-Dsh-Device-Model` | 可选 | 机型；仅供展示。 |
| `X-Dsh-Platform` | 可选 | 平台标识。 |
| `X-Dsh-Os-Version` | 可选 | 系统版本。 |
| `X-Dsh-App-Version` | 可选 | App 版本。 |

设备身份这几格是**每次请求顺手带上**的，宿主在鉴权通过那一刻把它们写回凭据记录（缺哪格
就保留原值，不会把已有名字清空）。它们只用于展示，不参与"这台手机是谁"的判定——认设备靠
`X-Dsh-Device` 与凭据本身。

**被动降级检测**：如果某枚凭据记录里带了 `deviceKey`（说明它当初是按 v2 配的），而请求却没带
`X-Dsh-Proto: 2`，宿主回 `400 { ok:false, code:"e2ee-required" }`。这是防止中间人把加密头删掉、
让宿主误按明文解析。客户端遇到它应带上信封重发。

### 2.3 协议 v2 请求信封

v2 下，业务请求不再是明文 JSON，而是加密信封。会话密钥由 `deviceKey` 派生：

```
deriveSessionKeys(deviceKey):
  up   = HKDF-SHA256(ikm=deviceKey(32B), salt=空, info="dsh-v2|up",   32B)
  down = HKDF-SHA256(ikm=deviceKey(32B), salt=空, info="dsh-v2|down", 32B)
  sig  = HKDF-SHA256(ikm=deviceKey(32B), salt=空, info="dsh-v2|sig",  32B)
```

其中 `deviceKey` 是配对时放入 `sealed` 的那个 32 字节密钥（即 `deviceKey` 字段 base64url
解码后的字节）。上下行必须分开用 `up` / `down`，签名用 `sig`，三者不共用。

**请求头**（除 §2.2 的身份头外，信封相关）：

| 头 | 说明 |
| --- | --- |
| `X-Dsh-Key-Id` | 设备密钥标识（配对时的 `keyId`），宿主用它找到 `deviceKey`。 |
| `X-Dsh-Ts` | 请求时间戳（毫秒）。宿主允许 ±5 分钟时钟偏差。 |
| `X-Dsh-Nonce` | 本次请求的随机串（base64url）。 |
| `X-Dsh-Sig` | 对"密文请求体"的 HMAC-SHA256 签名（base64url，32 字节）。 |
| `X-Dsh-Params` | 可选。把私密查询参数加密后放这里（见下）。 |
| `X-Dsh-Accept-Enc` | 可选。带 `g` 表示客户端接受压缩后的响应。 |

**请求体**是一个 JSON 信封，`c` 为明文经 `up` 密钥封装后的标准 base64：

```json
{ "v": 2, "c": "<base64>" }
```

请求明的 AAD 为 `v2|up|<METHOD>|<PATH>`，其中 `PATH` 从 `/api/mobile/v1/` 起算（中转会剥掉
部署前缀）。`<METHOD>` 大写。

**私密查询参数**：`path`、`query`、`refs` 这三个会把"在哪个目录干活、搜了什么、配哪把 key"
暴露在 URL 上，因此应放进 `X-Dsh-Params`。其明文为 JSON，用 `up` 密钥与 AAD
`v2|params|<ts>|<nonce>` 封装后 base64。其余参数（`sessionId`、`limit`、`offset`、`rev`、
`fresh`、`archived` 等）留在 URL 上。

**签名**：签名对象是**线上那串密文请求体字节**（不是明文，先解再验签会让"把 A 接口的密文
搬到 B 接口"成立）。规范串按线上原样拼，不做任何规范化：

```
v2 \n METHOD \n PATH \n QUERY \n TS \n NONCE \n HEX(sha256(body))
```

- `METHOD` 大写；`PATH` 从 `/api/mobile/v1/` 起算；`QUERY` 带 `?`、按实际发出顺序、不排序。
- `TS` 为毫秒时间戳；`NONCE` 为请求头里的同一个随机串。
- 摘要为**小写十六进制 64 字符**，不是 base64。
- 用 `sig` 密钥做 HMAC-SHA256，结果 base64url 编码放进 `X-Dsh-Sig`。

**响应信封**形状为：

```json
{ "v": 2, "n": "<base64url nonce>", "c": "<base64 密文+tag>" }
```

- `n` 是 12 字节 nonce 的 base64url；`c` 是 `密文||tag` 的 base64。
- 解封前要把 `n` 与 `c` 拼回 `nonce||密文||tag` 再解（App 侧 `open` 期待这一整段）。
- 下行 AAD 为 `v2|down|<METHOD>|<PATH>|<请求ts>|<请求nonce>`——绑定的是**本次请求**的 ts 与
  nonce，防止把上一个请求的答复塞给这个请求。
- 若有压缩，信封会多一个 `z` 字段，表示正文先解压再用。
- 列表类响应（会话列表、工作区列表）会把 `ok` / `revision` / `generatedAt` 留在明文外层，
  正文放进信封的内层 `env`，供中转离线镜像判断，这是正常形状，客户端两边都要读。

**错误响应永远明文**：`401` / `403` / `503` 以及带 `code` 的错误响应不封装，客户端必须能直接
读懂，再决定重发、校准时钟或提示重新扫码。

**时钟与重放**：时钟偏差超过 5 分钟会回 `400` 并带 `serverTime` 供校准；写请求（非 GET）的
`nonce` 会被宿主记入重放表，重复即回 `409 e2ee-replay`。GET 不记重放（换通道重投会复用同一
nonce）。

---

## 3. 测试向量

`test/e2ee-vectors.json` 是跨端对照最可靠的依据。两端（宿主与客户端）各自用固定输入重算，
输出与 `expect` 逐字节一致才算实现正确。它由 `scripts/gen-e2ee-vectors.cjs` 生成，改协议才重新生成。

**关键编码陷阱**：向量文件里所有密文字段（`pairSealed` / `upSealed` / `downSealed` /
`paramsSealed`）以及 `ticket` / `deviceKey` 都是以 **hex（十六进制）** 存储，纯粹为了可读和可
粘贴；而**线上传输用的是 base64 或 base64url**。例如 `ticket` 在向量里是 64 字符 hex（=32 字节
原始票据），线上是 43 字符 base64url；`pairSealed` 在向量里是 hex，线上 `sealed` 字段是 base64。
把向量的 hex 当 base64 用，必然"解不开"。这是最常见的翻车点。

固定输入：`ticket` 为 32 字节 `0x11`，`deviceKey` 为 32 字节 `0x22`，`instanceId` 为
`a1b2c3d4`，各 nonce 为重复的单字节值。对应的期望值（节选，均可在文件中核对）：

| 字段 | 期望值 |
| --- | --- |
| `pairKey` | `e1d2ef23fffd21bb8662bfa22b9952e251588a96eb2ff6e85254a4a1edf62e59` |
| `keyUp` | `066a168ca46a1d7698d4448b78f9b56900d472e7fd22fd851ce6cdc1410a86dc` |
| `keyDown` | `20ac0b940cb5f7ce9b36e58f85a2a1c8418ccbb1c40256e1447187e0ae015ea0` |
| `keySig` | `3329b0136c54d7f6bf1844998a96f010c52bf775e2ff670cf084bddee7a93903` |
| `canonical` | `v2\nPOST\n/api/mobile/v1/session/send\n?fresh=1\n1761292800123\nRERERERERERERERE\n39abbda0fa1406570963b69ea850f349b6c3e340ad106a8865478b9b011ab1b3` |
| `signature` | `62h639TTDANOTHuxyQ90rys19u8U_Vcu2NPNzEuXJaY` |

自检步骤（建议按序）：

1. `ticket = hexDecode(inputs.ticket)`（32 字节）→ `derivePairKey(ticket, instanceId)` 应等于 `expect.pairKey`。
2. `deviceKey = hexDecode(inputs.deviceKey)`（32 字节）→ `deriveSessionKeys(deviceKey)` 应分别等于
   `expect.keyUp` / `keyDown` / `keySig`。
3. 用 `pairKey` 与 AAD `pair|v2|a1b2c3d4` 解 `hexDecode(expect.pairSealed)`，得到的明文应等于
   `inputs.pairPlain`（里面 `deviceKey` 是 43 字符 base64url 形态，`keyId` 为 `0011223344556677`）。
4. 用 `keyUp` 与 AAD `v2|up|POST|/api/mobile/v1/session/send` 解 `hexDecode(expect.upSealed)`，
   得到 `inputs.bodyPlain`。
5. 用 `sig` 验证 `expect.signature`（规范串见 `expect.canonical`）通过。

以上任一环节对不上，就是该端的某个字节拼错了（base64 变体、AAD 顺序、HKDF 的 info、摘要
hex 还是 base64），先修到全绿再联调。

---

## 4. 端点清单

除特别标注外，所有端点都要求已配对设备（`guarded`）。请求/响应字段后续逐条补充；本节只列
路径与用途，确认"客户端打的地址宿主注册没有"。

**公开（无需鉴权）**

- `GET /api/mobile/v1/health` — 服务探活，回服务名与版本。
- `POST /api/mobile/v1/pair` — 配对，见 §1。

**状态与连接**

- `/api/mobile/v1/status` — 心跳与状态快照（中转地址、p2p 状态等）。
- `/api/mobile/v1/connection-info` — 局域网 / IPv6 直连候选地址。
- `/api/mobile/v1/desktop-view` — 桌面侧视图快照。
- `/api/mobile/v1/tunnel` — 直连隧道地址申请。
- `/api/mobile/v1/p2p/rendezvous` — 点对点隧道会合。

**凭据与设备同步**

- `/api/mobile/v1/device-credential/revoke` — 手机自解绑。
- `/api/mobile/v1/device-credential/upgrade` — 旧会话升级为 T1。
- `/api/mobile/v1/sync/tickets` — 申领一次性同步券。
- `/api/mobile/v1/sync/inbox` — 密文收件箱读写。

**会话**

- `/api/mobile/v1/sessions`、`/monitor`、`/session`、`/session/messages`、`/session/step`
- `/api/mobile/v1/session/attachment`、`/session/local-image`、`/session/file`、`/file/read`
- `/api/mobile/v1/session/send`、`/session/delivery`、`/session/head`、`/session/read`
- `/api/mobile/v1/session/stop`、`/session/rename`、`/session/fork`、`/session/new`
- `/api/mobile/v1/session/models`、`/session/select-model`、`/session/model-option`
- `/api/mobile/v1/session/stats`、`/stats/overview`、`/session/search`
- `/api/mobile/v1/session/goal`、`/session/queue/update`、`/commands`
- `/api/mobile/v1/session/stream`（流式响应）、`/events/stream`（设备事件流）
- `/api/mobile/v1/question/respond`、`/approval/respond`

**agent 预设**

- `/api/mobile/v1/agent-presets`、`/agent-presets/read`、`/copy`、`/remove`、`/default`

**工作区与目录**

- `/api/mobile/v1/workspaces`、`/directory/list`、`/directory/roots`、`/directory/listing`、`/directory/create`
- `/api/mobile/v1/workspace/create`、`/delete`、`/move`、`/move-session`、`/rename`
- `/api/mobile/v1/workspace/archive-session`、`/unarchive-session`、`/pin-session`、`/unpin-session`、`/clear-archived`

**git**

- `/api/mobile/v1/git/repo`、`/status`、`/diff`、`/log`、`/show`、`/branches`、`/overview`
- `/api/mobile/v1/git/stage`、`/unstage`、`/commit`、`/checkout`、`/push`、`/commit-message`

**宿主设置、模型与渠道**

- `/api/mobile/v1/host-settings`、`/host-settings/mutate`、`/llm/providers`、`/llm/models`
- `/api/mobile/v1/model-meta`、`/model-meta/apply`
- `/api/mobile/v1/channels`、`/channels/discover`、`/channels/save`、`/channels/delete`
- `/api/mobile/v1/deepseek-account`、`/credentials`、`/credentials/set`、`/credentials/unset`
- `/api/mobile/v1/skills`、`/session-log`、`/magpie/web`

**子代理与引用**

- `/api/mobile/v1/subagents`、`/subagents/prompt`、`/subagents/interrupt`
- `/api/mobile/v1/file-references`、`/session-references`

**定时任务**

- `/api/mobile/v1/schedule/catalog`、`/list`、`/history`、`/delete`
- `/api/mobile/v1/schedule/create`、`/update`、`/pause`、`/resume`、`/run`

**文件与后台任务**

- `/api/mobile/v1/file/create`、`/file/delete`、`/file/rename`
- `/api/mobile/v1/jobs/cancel`、`/jobs/start`

**插件**

- `/api/mobile/v1/plugins`、`/plugin/self`、`/plugin/self/auto`
- `/api/mobile/v1/plugin/market`、`/market/registries`、`/market/inspect`、`/market/install`、`/market/update`、`/market/progress`、`/market/cancel`、`/market/enabled`
- `/api/mobile/v1/plugin/update/status`、`/check`、`/apply`

**扩展**

- `/api/mobile/v1/extension/cards`、`/card-state`、`/action`、`/data`
- `/api/mobile/v1/extension/dev/packages`、`/dev/file`
- `/api/mobile/v1/extension/catalog`、`/catalog/file`、`/catalog/archive`

**上传、画布、收件箱**

- `/api/mobile/v1/upload/begin`、`/chunk`、`/finish`、`/abort`
- `/api/mobile/v1/canvas/manifest`、`/manifest/save`、`/canvas/file`
- `/api/mobile/v1/inbox/status`、`/clear`、`/auto`

**其它**

- `/api/mobile/v1/narration` — 过程播报开关。
- `/api/mobile/v1/supervisor/tasks`、`/supervisor/knowledge` — 总管账本。
- `/api/mobile/v1/push-token` — 推送令牌上报。
- `/api/mobile/v1/perf-trace` — 性能埋点。
- `/api/mobile/v1/host-web` — 网页版一次性登录令牌。
- `/api/mobile/v1/preview` — 内置浏览器预览（WebSocket 升级路由）。
- `/api/mobile/v1/phone/status`、`/devices`、`/unbind`、`/knowledge`、`/pacing`、`/app-access`、`/phone/control`（升级路由）。
- `/api/mobile/v1/pet/packs`、`/pet/pack/file`、`/pet/pack/delete`。

**中转控制**

- `/api/mobile/v1/relay/config`、`/config/save`、`/enabled`、`/pairing-code`、`/revoke-all`
- `/api/mobile/v1/relay/reconnect`、`/restart-sidecar`、`/check-port`、`/probe`、`/diagnostics`

---

## 5. 待补

以下内容本文只给出了基础口径，逐条字段与示例留待后续补充：

- 各业务端点的请求/响应字段（尤其会话发送、流式（SSE）帧封装、附件上传 v3 分片）。
- SSE 与二进制帧的 AAD 口径（代码中另有 `sseAad` / `fileAad` / v3 分片 AAD 的拼接规则）。
- 压缩协商（`X-Dsh-Accept-Enc: g`）与响应 `z` 字段的完整流程。
- 列表类响应"外层留元数据、正文进 `env`"的完整形状与示例。
