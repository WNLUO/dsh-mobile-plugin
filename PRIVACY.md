# 隐私政策 · AI-HUB 移动端（dsh-mobile-plugin）

生效日期：2026-11-21。适用于 AI-HUB 手机 App（`com.dsh.mobile`，iOS / Android）及配套宿主插件。
公开用户政策：<https://ai-hub.wnluo.com/privacy>；服务条款：<https://ai-hub.wnluo.com/terms>。

## 1. 数据与接收方

AI-HUB 把手机连接到你配对的电脑上的 DeepSeek Harness。没有独立的 AI-HUB 注册账号、广告或跨 App 追踪。电脑、代理与配置的模型服务是不同的数据接收方；使用自己的电脑不代表所有 AI 处理都在电脑本地。

- **配对与连接**：手机保存设备标识、连接地址、备注及授权凭据。电脑、地址目录与中转处理定位、授权和连接所必需的记录。它们不是广告标识。系统钥匙串中的部分配对和试用记录可能在重装后保留。
- **消息与 AI 服务**：文字、图片、文件先交给配对电脑。电脑代理可将这些内容及必要历史、身份提示、工作区资料和工具结果交给其配置的模型提供方或其他工具服务，可能包含个人或机密信息。远程服务与用户自建服务各自的保留、使用、删除规则独立适用。
- **发送许可**：新消息发送前，App 显示已知提供方及端点并征求同意。宿主明确支持接收方校验且实际自建端点已知时，按电脑、提供方及端点保存许可；电脑接收提示前校验期望提供方和端点，变化后重新确认。实际端点未知或旧插件不支持校验时，只许可这一条消息及其离线重试，每条新消息均重新确认，并说明按电脑配置路由。接收后的排队执行及工具调用仍受电脑配置控制。电脑代理或 CLI 的进一步路由取决于电脑配置，用户应在同意前确认配置和相应服务条款。
- **拒绝与撤回**：拒绝保留草稿。可在「设置 → 数据与隐私」撤回；新消息需重新确认，原生待发队列同步清空。清空失败时显示尚未确认并允许重试，回前台也继续同步。已在途或已送达数据不能追回，撤回也不会删除电脑或模型提供方的副本。
- **传输**：局域网可直连，其他连接可能经中转或隧道。新加密配对保护手机与电脑之间的正文；旧未加密连接会在 App 提示，重新配对可升级。中转处理路由及运维元数据，具体保留方式取决于实际部署与运营方，不对所有自建中转作纯内存或不落盘承诺。端到端加密不阻止电脑把内容交给配置的 AI 服务。

## 2. 更新、诊断与反馈

分发平台 `app.wnluo.com` 接收安装标识、平台、机型、系统和 App 版本、构建及运行时版本、分发渠道和更新状态，用于更新、装机统计与可靠性诊断。连接运维记录可能包含路径、状态、耗时和路由信息；自动报告不以收集对话正文为目的。用户主动反馈会把其选择发送的文字、附件及诊断资料交给运营方排障和回复。

不读取广告标识或硬件序列号，不出售个人数据，不接第三方广告或分析 SDK。App 功能不申请定位、通讯录或健康权限。

## 3. 购买与免费地区

- App Store 的中国大陆、香港、澳门、台湾门店，以及符合条件的既有用户免费。
- 其他 App Store 门店的新用户从第一次成功配对起有 App 内七天试用，到期后可按月订阅或一次买断。额外商店推介优惠以系统购买页及资格为准。
- 支付由苹果完成。App 只接收商品、权益及订阅到期信息，并在手机缓存以便离线使用；我们不接收银行卡资料。
- Android 直装版免费且没有内购。App 内价格来自商店的本地化价格，订阅管理和恢复购买使用系统能力。

## 4. 权限与本地保存

相机用于扫码及主动拍摄附件；相册选择器用于选图，保存图片申请添加权限。主动打开的预览网页可能使用麦克风。通知提供任务和消息提醒，本地网络用于访问电脑。

本机保存凭据、偏好、草稿、待发消息、会话与附件缓存、下载的更新。系统钥匙串和普通 App 存储分别管理。

## 5. 控制、保留与删除

可删除配对设备及其对应手机凭据和缓存，使用 App 内清理功能，在电脑撤销设备授权。卸载删除普通 App 存储，不保证删除系统钥匙串记录。设备删除或卸载不会删除电脑文件、聊天、模型提供方记录、已发送反馈或服务端诊断。

电脑数据在电脑处理，模型服务副本按相应提供方的删除流程处理。需要删除我们运营服务所持记录，请联系下方邮箱；我们会核对涉及的记录及适用保留要求。

## 6. 儿童、变更与联系

面向开发者和成年人，不面向十三岁以下儿童，不在知情情况下收集儿童个人资料。重要数据处理变化会更新本政策，并按情况在 App 或发布说明告知。

插件源码与依赖公开：<https://github.com/WNLUO/dsh-mobile-plugin>。联系：admin@wnluo.com。

## English summary

AI-HUB connects a phone to a paired computer. The computer may send messages, files, history, identity instructions and tool context to its configured model providers or other services, including personal data. The app requests permission before sending and shows the actual provider and endpoint when available; unknown endpoints or older plugins without explicit recipient validation require confirmation for each new message. Remembered permission for custom endpoints requires validation support; the computer checks the expected recipient before accepting a prompt. Later queued execution remains governed by the computer configuration. Refusing keeps the draft. Permission can be revoked in Data & privacy, where native queue-clear failures remain visible and can be retried. Data already sent or in flight cannot be recalled.

Phone-to-computer encryption does not prevent onward AI processing. Relay retention depends on the deployment and operator; we do not promise memory-only storage for all relays. The distribution platform receives installation and update diagnostics. User-submitted feedback contains the material the user chooses to send.

Mainland China, Hong Kong, Macao and Taiwan App Store storefronts and eligible existing users are free. Other new App Store users have a seven-day app trial from first pairing, then a monthly subscription or one-time purchase billed by Apple. Android direct builds are free with no in-app purchases.

Deleting phone copies does not delete computer, provider, feedback or server records. Some Keychain records can survive reinstalling. Contact admin@wnluo.com to request deletion of records held by our operated services. Full bilingual policy: <https://ai-hub.wnluo.com/privacy>.
