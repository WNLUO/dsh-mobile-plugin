---
name: xiaohongshu.com
display: 小红书
domains: ["xiaohongshu.com", "xhslink.com"]
aliases: ["小红书", "xiaohongshu", "RED"]
apps: ["xiaohongshu"]
open: www.xiaohongshu.com
mode: desktop
pace: careful
description: 生活方式内容社区，图文与视频笔记
---
## 是什么
小红书是生活方式内容社区，主域名 `xiaohongshu.com`，分享链接常见 `xhslink.com` 短链。基本单位是「笔记」：图文或视频配上标题、正文和标签。另有同名手机 App（见 `xiaohongshu`）。

## 页面与网址
- 笔记详情：`https://www.xiaohongshu.com/explore/<noteId>`，noteId 是 24 位十六进制；旧式 `/discovery/item/<noteId>` 也能打开。
- 发现/首页：`https://www.xiaohongshu.com/explore`。
- 搜索：`https://www.xiaohongshu.com/search_result?keyword=<关键词>&source=web_explore_feed`（`type=` 等筛排序/类型的取值待确认现值）。
- 用户主页：`/user/profile/<userId>`，userId 24 位十六进制。
- 话题页：`/page/topics/<id>`。
- 短链 `xhslink.com/<code>` 会 302 跳到上面地址，App 里分享出来的多为短链。
- 参数：笔记 URL 后面常跟 `xsec_token`、`xsec_source`，缺了有些笔记会打不开（风控），待确认。

## 界面
首页是瀑布流的信息流，一张张笔记卡片带封面、标题、作者头像和点赞数；顶部是搜索框，左侧导航有发现、发布、通知、我。

笔记详情页：上方是图片轮播（或视频播放器），下面是标题、正文、话题标签、点赞/收藏/评论数、作者信息与关注按钮，再往下是评论区与相关推荐。个人主页有笔记、收藏、赞过等标签。

## 功能
- 发布图文或视频笔记，可加标题、正文、话题标签和地点。
- 搜索笔记、用户、商品等，可按最新、最热排序。
- 点赞、收藏（可建专辑）、评论、关注作者。
- 关注页看关注的人发的笔记；消息里有评论、赞、新增关注等分类。
- 有直播入口；商品笔记可关联店铺或商品卡。

## 接口
- 笔记详情：页面调 `https://edith.xiaohongshu.com/api/sns/web/v1/feed`（POST，body 里 `source_note_id`）。返回 `data.items[]`，每项 `note_card` 里含 `display_title`、`user.nickname`、`user.user_id`、`interact_info.liked_count`/`collected_count`/`comment_count`、`cover.url_default`、`type`（normal|video）。字段全表见 `references/note-fields.md`。
- 搜索：`https://edith.xiaohongshu.com/api/sns/web/v1/search/notes`（POST），返回结构同上，另带 `xsec_token`。
- 这些请求必须带 `x-s`、`x-t` 签名头（前端 JS 现算）和登录 Cookie，不签名直连会被拒（返回空或 `code` 非 0）；签名算法随版本变，待确认。
- 图片/视频直链在 `cover.url_default`、`video.media.stream...` 里，是 CDN 域名（`sns-img-*.xhscdn.com` 一类），带时效。
- 结论：读页面已发出的响应正文（web_capture）最稳；自己重放要签名，不建议。

## 已知现象
- 未登录时浏览和互动功能受限，常提示登录。
- 信息流按推荐算法分发，不完全按发布时间。
- 图片是竖向长图轮播，视频笔记会自动播放。
- 部分笔记的评论或收藏需要登录后才看得到。
- 少带 `xsec_token` 的笔记链接会打不开或跳登录。
