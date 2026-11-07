---
name: youtube.com
display: YouTube
domains: ["youtube.com", "youtu.be"]
aliases: ["YouTube", "油管", "youtube"]
apps: []
open: www.youtube.com
mode: desktop
pace: standard
description: 视频平台，看视频、订阅频道与 shorts
---
## 是什么
YouTube 是视频平台，主域名 `youtube.com`，短链域名 `youtu.be`。内容以频道上传的视频为核心，另有 Shorts 短视频、直播和播放列表。我们暂无 YouTube 的 App 知识，`apps` 先留空。

## 页面与网址
- 观看页：`https://www.youtube.com/watch?v=<videoId>`，videoId 固定 11 位（字母数字加 `-`、`_`）。
- Shorts：`https://www.youtube.com/shorts/<videoId>`。
- 频道：新式 `https://www.youtube.com/@<handle>`；旧式 `/channel/<UC...>`、`/c/<name>`、`/user/<name>`。
- 播放列表：`/playlist?list=<listId>`，listId 常以 `PL`、`UU`、`LL` 开头。
- 搜索：`/results?search_query=<关键词>&sp=<筛选串>`。
- 起播位置：`/watch?v=<id>&t=90s`；嵌入：`/embed/<videoId>`。
- 短链 `youtu.be/<videoId>` 会 302 跳到 watch 页。
- 参数 `sp=` 是筛选编码（上传时间/类型/时长/排序），是位压缩串，不宜手拼，在页面上选即可。

## 界面
桌面网页左侧是导航：首页、Shorts、订阅、我（媒体库）、历史、播放列表，顶部是搜索框。首页是缩略图组成的视频网格，每张卡片带时长、标题、频道名、观看数和发布时间。

观看页分三块：上方是播放器（进度条、播放/暂停、音量、字幕、设置、剧场模式、全屏）；播放器下方是标题、频道与订阅按钮、点赞/点踩、分享、保存，再接简介和评论区；右侧是相关推荐列表。

## 功能
- 搜索可按上传时间、类型、时长、排序方式过滤（即 URL 里的 `sp=`）。
- 播放器里可调画质、播放速度、字幕（含自动生成字幕）、循环。
- 播放列表、稍后观看、点赞的视频都在「媒体库」里。
- Shorts 是上下滑动切换的竖屏短视频流。
- 频道页有首页、视频、Shorts、直播、播放列表、社区、简介等标签。
- 直播页有实时聊天栏。

## 接口
- 观看页背后是 InnerTube：`https://www.youtube.com/youtubei/v1/player`（POST JSON），body 里 `videoId` 加 `context.client`（`clientName`、`clientVersion`、`hl`、`gl`）。返回 `playabilityStatus.status`（OK / LOGIN_REQUIRED / AGE_VERIFICATION_REQUIRED 等）、`videoDetails`（`title`、`author`、`channelId`、`lengthSeconds`、`viewCount`、`shortDescription`、`keywords[]`）、`streamingData`（`formats`/`adaptiveFormats`，含直链与 `signatureCipher`）、`captions`。字段全表见 `references/innertube-fields.md`。
- 轻量公开接口：`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<id>&format=json`，返回 `title`、`author_name`、`thumbnail_url`，不需要 key，但只有标题/作者，没有播放量。
- 首屏数据也塞在页面 HTML 的 `ytInitialData` / `ytInitialPlayerResponse` 里，可从页面源码直接取。
- 注：InnerTube 的 `context.client` 版本号与相关请求头会随前端变化，待确认；oEmbed 最稳。

## 已知现象
- 播放前和播放中会插播广告。
- 点赞、订阅、看年龄限制内容通常要先登录。
- 部分视频有地区限制或会员（Premium）限制。
- 自动生成的字幕可能不完全准确；评论默认按「热门」排序。
- `sp=` 筛选码手改容易失效，用页面勾选更稳。
