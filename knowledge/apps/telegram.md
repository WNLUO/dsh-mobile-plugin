---
name: telegram
display: Telegram
description: 即时通讯，聊天、群组与频道
packages: ["org.telegram.messenger"]
aliases: ["Telegram", "电报", "TG", "telegram"]
sites: ["telegram.org", "web.telegram.org"]
open: Telegram
pace: careful
---
## 是什么
Telegram 是即时通讯 App，包名 `org.telegram.messenger`。个人聊天、群组、频道都是其中的会话对象；网页版在 `web.telegram.org`。

## 界面
主界面是会话列表（Chats），有搜索、新消息入口，另有 Contacts（联系人）页。进入后默认停留的页面不一定是 Chats，可能是上次看到的会话。会话列表每行显示名称、最后一条消息和未读标记；群组和频道名称旁有成员数或订阅数。

## 功能
- 读消息：在会话列表点目标进入，滚动看历史，每条有发送人和时间；群、频道、联系人是不同对象，频道通常只有管理员能发言。
- 发消息：在已有会话输入，或从 Contacts、新消息入口选收件人，发出后会话里出现新气泡，气泡右侧的勾表示送达状态。
- 联系人页可看资料；频道和群可从名称或简介进入详情。

## 已知现象
- 首次登录要输入手机号并接收验证码，可能还要求两步验证密码；换设备会重新验证。
- 界面语言随系统，不一定是中文。
- 「保存的消息」（Saved Messages）是发给自己的一条会话，不是联系人。
- 频道、群与同名联系人可能重名，进入后看标题和成员/订阅信息才分得清。
- 部分群开启「限制保存内容」，转发和截图会受限。
