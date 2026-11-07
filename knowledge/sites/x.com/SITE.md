---
name: x.com
display: X（原推特）
domains: ["x.com", "twitter.com"]
aliases: ["X", "推特", "Twitter", "twitter"]
apps: []
open: x.com
mode: desktop
pace: careful
description: 社交平台，短帖、时间线与实时话题
---
## 是什么
X（推特 Twitter 改名后）是社交平台，主域名 `x.com`，旧地址 `twitter.com` 仍会跳转过来。核心内容是「帖子」（post）：一段短文字，可带图片、视频、链接和投票。X 的 App 还没在我们的 App 知识里，`apps` 先留空，补了 APP.md 再加反链。

## 页面与网址
- 单条帖子：`https://x.com/<用户名>/status/<帖子id>`，id 是约 19 位数字。
- 用户主页：`https://x.com/<用户名>`，媒体页 `/media`，喜欢 `/likes`。
- 搜索：`https://x.com/search?q=<关键词>&f=live|media|user`，`f=live` 看最新、`f=media` 看媒体、`f=user` 看用户。
- 探索/趋势：`/explore/tabs/trending`、`/explore/tabs/news`。
- 视频查看器：`/<用户名>/status/<id>/video/1`。
- 旧域名 `twitter.com/<...>` 与 `x.com/<...>` 是同一路径；`t.co/<code>` 是外链短链，会跳到站外。
- 参数 `f=` 是搜索过滤，`src=typed_query` 是来源标记，可忽略。

## 界面
桌面网页左侧是一列导航：首页、探索、通知、私信、书签、列表、社区、个人资料，底部还有发帖入口。中间是时间线，右侧是搜索框和趋势榜。移动网页把导航收进顶部与底部标签，时间线占满屏。

帖子的固定结构：作者头像与昵称、正文、媒体、以及下面一排操作——回复、转帖、点赞、查看数、书签、分享。点开一条帖子是同一条的详情页，下面接回复。

## 功能
- 发帖：文字、图片（最多四张）、视频、投票、引用另一条帖子。
- 时间线有「为你推荐」和「正在关注」两种排序。
- 转帖分两种：直接转帖，和带评论的引用转帖。
- 搜索可按「热门 / 最新 / 用户 / 媒体」切换；趋势榜按地区列当前热门话题。
- 私信是独立入口；列表可把指定账号聚成一条时间线；社区（Communities）是按主题的圈子。
- 个人资料页有帖子、回复、媒体、喜欢等标签；订阅用户可发长文。

## 接口
- 页面自己走的是私有 GraphQL：`https://x.com/i/api/graphql/<queryId>/TweetDetail?variables=...`、`/UserTweets`、`/SearchTimeline` 等，POST/GET，需要登录 Cookie（含 `auth_token`、`ct0`）和配套的 `x-csrf-token`、`authorization` Bearer。`<queryId>` 随前端发版变，不稳定，待确认。web_capture 能读到页面已发出的响应正文，但自己重放要先登录。
- 公开只读兜底（不登录也能取单条帖元数据）：`https://cdn.syndication.twimg.com/tweet-result?id=<帖子id>&token=<占位>`，返回 JSON 含 `text`、`user.name`、`user.screen_name`、`created_at`、`favorite_count` 等。`token` 由前端算法生成，待确认（第三方库如 react-tweet 走的就是这条）。
- 结论：这些接口随时会改，最稳的是只读页面自己发出的请求正文（web_capture）。

## 已知现象
- 未登录访问常被登录墙挡住，或只能看少量内容。
- 时间线默认按推荐算法排序，不完全是时间顺序。
- 视频和图片在单独的查看器里打开，可左右切换。
- 长文、编辑帖子、部分私信功能与订阅账号相关。
- 内部 GraphQL 的 `queryId` 会随发版变，今天能读的接口明天可能换路径。
