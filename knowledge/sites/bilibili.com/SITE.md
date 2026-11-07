---
name: bilibili.com
display: 哔哩哔哩
domains: ["bilibili.com", "b23.tv"]
aliases: ["哔哩哔哩", "B站", "bilibili", "b站"]
apps: ["bilibili"]
open: www.bilibili.com
mode: desktop
pace: standard
description: 视频社区网页版，看视频、弹幕与评论
---
## 是什么
哔哩哔哩（B站）是视频社区，网页主域名 `bilibili.com`，站内短链常是 `b23.tv`。内容以中长视频、番剧、直播为主，特色是弹幕和评论区。另有同名手机 App（见 `bilibili`）。

## 页面与网址
- 首页：`https://www.bilibili.com/`
- 视频页：`https://www.bilibili.com/video/BV1xx411c7mD/`，BV 号以 `BV` 开头、共 12 位字母数字；旧式 av 号写成 `/video/av170001`，两者指向同一视频。
- 分P：`/video/<BV号>?p=2`，`p` 从 1 开始。
- 起播位置：`?t=30` 表示从第 30 秒开始。
- 番剧：`/bangumi/play/ss<季id>`（整季）或 `/bangumi/play/ep<集id>`（单集）。
- 直播：`/live/<房间号>`。
- UP 主空间：`/space/<mid>`，投稿列表 `/space/<mid>/video`；`mid` 是数字用户 ID。
- 搜索：`https://search.bilibili.com/all?keyword=<关键词>&search_type=video|media|upuser|article`。
- 排行榜：`/v/popular/rank/all`；热门：`/popular`。
- 短链 `b23.tv/<code>` 会 302 跳到上面某一种地址，按跳转后的 URL 匹配。

## 界面
首页顶部是搜索框和分区导航，下面是推荐视频卡片网格，卡片带封面、时长、播放量、弹幕数。左侧导航有首页、番剧、直播、游戏中心、会员购、动态、热门、频道等。

视频播放页：上方是播放器，控制条里有弹幕开关、画质、倍速、音量、网页全屏/全屏；播放器下方是标题、UP 主与关注按钮、播放量、点赞/投币/收藏/分享，再接简介和分P，最下面是评论区与相关推荐。动态、稍后再看、历史、收藏在个人中心里。

## 功能
- 搜索：结果分视频、番剧、用户、专栏等分组，视频给标题、UP 主、播放量、时长。
- 弹幕：按时间飘过，可开关、调透明度、屏蔽词。
- 评论区分主楼与楼中楼回复，可按热度或时间排序。
- 关注、点赞、投币、收藏（三连）；可以建收藏夹。
- 番剧、直播、专栏各有独立入口；直播页有实时弹幕。

## 接口
- 视频详情（打开播放页就会调）：`https://api.bilibili.com/x/web-interface/view?bvid=<BV号>`（也可用 `aid=<av号>`），GET。返回 `data`：`title`、`owner.name`、`owner.mid`、`stat.view`（播放）、`stat.danmaku`（弹幕数）、`stat.reply`（评论数）、`stat.favorite`、`stat.coin`、`stat.share`、`stat.like`、`pages[]`（分P，含 `cid`）、`desc`、`pubdate`。字段全表见 `references/view-fields.md`。受限视频要登录 Cookie（SESSDATA），`code` 非 0（如 -352、-403）表示风控/权限。
- 新版接口是 `https://api.bilibili.com/x/web-interface/wbi/view`，参数与上面基本一致，但多带 `w_rid`、`wts` 签名参数，签名前端自己算，具体规则随版本变，待确认。
- 评论：`https://api.bilibili.com/x/v2/reply?type=1&oid=<aid>&pn=1`，`type=1` 表示视频，`oid` 用数字 aid（不是 BV 号），返回 `data.replies[]`。
- 弹幕：`https://api.bilibili.com/x/v1/dm/list.so?oid=<cid>`，`cid` 取自 view 接口的 `pages[].cid`，返回的是 XML 不是 JSON。

## 已知现象
- 高清画质、部分番剧和大会员内容与账号等级、会员相关。
- 部分内容需要登录后才能看或参与互动。
- 读到的评论通常只是排在前面的一批，不是全部（接口分页）。
- 受版权和地区限制，个别视频在特定地区不可见。
- 部分新页面用站点自定义字体画数字，读屏可能读成方块，而接口里是明文（是否仍如此待确认）。
