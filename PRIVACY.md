# 隐私政策 · AI-HUB 移动端（dsh-mobile-plugin）

生效日期：2026-10-24。适用对象：AI-HUB 手机 App（`com.dsh.mobile`，iOS / Android）以及配套的
`dsh-mobile-plugin` 宿主插件。

## 一句话

AI-HUB 是你自己电脑上 DeepSeek Harness 的手机客户端 —— 它把手机和**你自己的电脑**连起来，
数据主要在这两端之间流动。我们没有账号体系、没有广告、没有第三方分析 SDK，也不做任何追踪。

公开发布版（面向商店审核与用户阅读）：<https://ai-hub.wnluo.com/privacy>（中英双语同页）。

## 1. 我们处理哪些数据

### 1.1 配对与设备授权

- 手机扫描电脑端显示的二维码，得到连接地址与一次性的配对码；配对成功后电脑会给这台手机发一个
  设备凭据（以 `dshc_` 开头的随机密钥），它保存在手机本地，之后每次连接都带着它。
- 电脑侧与中转侧各留一条设备记录：一个随机生成的**设备标识**、凭据的**哈希值**、创建 / 过期 /
  吊销时间。凭据明文不落盘；设备标识不包含你的姓名、手机号、Apple ID 等任何身份信息。
- 你随时可以在插件面板里点「撤销全部授权」，让所有已授权的手机立即失效。

### 1.2 会话内容（你在 App 里看到与发出的东西）

- 你的提问、附件图片、以及你电脑上 agent 产生的内容，只在**手机 ⇄ 你自己的电脑**之间传输。
- **局域网直连**：这些数据不经过我们的任何服务器。
- **中转模式**（手机与电脑不在同一网络时）：数据会经过中转服务器转发。中转只做转发与**短时内存
  缓存**（用于加速列表与消息加载），**不会把会话正文写入磁盘**，服务器进程重启即消失。
- 你选择的图片等附件同样只发往你的电脑，我们不保存。

### 1.3 更新检查与热更新

- App 会定期（约每分钟）向我们的分发平台 `app.wnluo.com` 检查更新，发送的内容是：应用包名、
  运行平台、应用版本与构建号、运行时版本、当前已应用的热更版本，以及一个设备标识。
- 热更包的激活 / 回滚 / 下载失败等事件会上报到同一平台，用于统计更新成功率与排查问题。
  这些数据**不含任何会话内容**。

### 1.4 诊断与运维记录

- 中转服务器会保存少量运维元数据：请求路径与方式、会话标识、命中方式、状态码、耗时等，用于排查
  「连不上 / 很慢」这类问题。**不含会话正文，也不含凭据明文。**
- 手机上另有一份本地连接诊断记录（最近的通道、耗时、错误），只在 App 内展示，你可以随时清空。

### 1.5 语音输入（涉及第三方）

- 语音输入是**可选**功能，不主动开始就不会用。
- 音频在设备上录制后，会发给转写用的语音服务 —— 当前是**微信输入法的私有接口**
  （`wetype.weixin.qq.com`，由腾讯运营）—— 以转成文字。**该音频会离开你的设备**，并按腾讯的隐私政策
  处理；涉及跨境传输的情形（例如欧盟用户使用该服务）请注意这一点。
- 不想这样的话不要使用语音输入，其余功能不受影响。转写结果只落进手机上的消息草稿，之后与普通文字
  一样发往你自己的电脑。

### 1.6 内购（仅商店版）

- **商店版**（App Store / Google Play）：7 天试用后按年订阅或一次性买断。支付完全由苹果或谷歌处理，
  我们看不到也存不了你的姓名、支付方式或卡号；App 只从商店拿到「有没有有效购买、是哪个商品、订阅到期日」，
  并缓存在本机以便离线可用。
- **直装版**（国内分发平台与 GitHub 那个包）：**没有任何内购**，永久免费，界面上不出现收费相关内容。

### 1.7 权限与本地数据

- 权限用途：**相机**扫二维码；**相册**选图发给电脑；**通知**用于任务完成提醒；**本地网络**用于
  访问同一局域网内的电脑。
- App 本地保存：设备列表与备注、会话与列表缓存、主题偏好、下载的热更包。卸载 App 即全部删除。

## 2. 我们不做什么

- 不售卖、不出租任何数据；不做广告；不接入第三方分析、广告或崩溃上报 SDK；不做跨 App 追踪。
- 不收集通讯录、位置、健康、浏览历史等系统数据（App 也不申请这些权限）。
- 不做任何反绕过或指纹识别（收费只在商店渠道里发生；安卓用户完全可以去 GitHub 下免费包，我们不拦不检测）。

## 3. 数据保留与删除

- 设备授权记录：保留到你主动撤销为止（默认有效期一年，到期自动失效）。
- 中转的会话缓存：只存在于内存，服务器重启即清空；落盘的运维元数据按实例滚动覆盖，只保留最近若干条。
- 手机上的一切：卸载 App，或在 App 内删除设备，即可清掉对应数据。
- 需要删除服务器侧记录：用下面的邮箱联系我们。

## 4. 第三方

- 除 Apple 提供的系统能力（通知、相机、相册、App 分发与更新）之外，App 不集成任何用于收集数据的
  第三方 SDK。
- 配套插件的完整源码与依赖清单是公开的：<https://github.com/WNLUO/dsh-mobile-plugin>

## 5. 儿童

本 App 面向开发者与成年用户，不面向 13 岁以下儿童，也不会在知情的情况下收集儿童的个人信息。

## 6. 政策变更

本政策如有更新，会直接改在本页并同步更新上方的生效日期；涉及数据处理的重大变化，我们会在 App 内
或仓库的发布说明里另行提示。

## 7. 联系方式

邮箱：admin@wnluo.com

---

## English summary

AI-HUB is a mobile client for DeepSeek Harness running on **your own computer**. Data flows mainly
between your phone and your own machine. We do not have user accounts, ads, third-party analytics or
tracking. When your phone and computer are not on the same network, traffic is relayed through our
relay server: conversation content is forwarded and cached **in memory only** (never written to disk).
Our update platform (`app.wnluo.com`) receives app version, platform, build numbers and a device
identifier for update delivery and statistics — never conversation content.

**Voice input** is optional and off unless you start it. Audio is recorded on the device and sent to
the transcription service — currently WeChat Input Method (`wetype.weixin.qq.com`, operated by
Tencent) — so it leaves your device and is handled under Tencent's privacy policy. Do not use voice
input if you do not want this; everything else works without it.

**Purchases** exist only in the App Store and Google Play builds (7-day trial, then a yearly
subscription or a one-time purchase). Payment is handled entirely by Apple or Google; the app only
learns whether a valid purchase exists, which product, and the subscription expiry. The build
distributed directly (domestic platforms and GitHub) has **no purchases and is free**.

Uninstalling the app removes all locally stored data. Public policy page:
<https://ai-hub.wnluo.com/privacy>. Contact: admin@wnluo.com
