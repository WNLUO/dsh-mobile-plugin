---
name: zhihu.com
display: 知乎
domains: ["zhihu.com"]
aliases: ["知乎", "zhihu"]
apps: ["zhihu"]
open: www.zhihu.com
mode: desktop
pace: careful
description: 问答社区，问题、回答、文章与话题
---
## 是什么
知乎是问答社区，主域名 `zhihu.com`。核心内容是「问题」下方的一条条「回答」，另有文章、专栏、想法等内容形式。另有同名手机 App（见 `zhihu`）。

## 页面与网址
- 问题页：`https://www.zhihu.com/question/<qid>`，qid 是数字。
- 单条回答：`https://www.zhihu.com/question/<qid>/answer/<answerId>`。
- 文章：`https://zhuanlan.zhihu.com/p/<id>`（专栏子域名，按 `zhihu.com` 子域命中）。
- 用户：`/people/<slug>`；专栏：`/column/<slug>`；想法：`/pin/<id>`；话题：`/topic/<id>`。
- 搜索：`https://www.zhihu.com/search?type=content&q=<关键词>`（`type=content|people|topic`）。
- 热榜：`https://www.zhihu.com/hot`。
- 分页：回答列表滚动时前端按 `limit`/`offset` 自动取（见接口节），URL 不变。

## 界面
首页默认是推荐流，顶部有「关注 / 推荐 / 热榜」等切换；左侧或顶部是搜索框。问题页顶部是问题标题与描述，下面是回答列表，每条回答带作者、正文、赞同/反对、评论数，长回答会折叠成「展开阅读全文」。右侧常有「相关问题」和话题标签。

导航栏有首页、会员、发现、等待回答、我的等入口。个人主页分动态、回答、提问、文章、专栏等标签。

## 功能
- 提问、写回答、评论、赞同或反对，赞同可在赞同/喜欢之间切换。
- 收藏回答到收藏夹；关注问题、话题、用户。
- 写文章与专栏；发「想法」（短内容）。
- 搜索覆盖问题、回答、文章、用户、话题，可只看某一类。
- 盐选专栏是付费内容；私信与通知在消息入口。

## 接口
- 回答列表：`https://www.zhihu.com/api/v4/questions/<qid>/answers?include=data[*].content,voteup_count,comment_count,author.name,author.headline,created_time&limit=20&offset=0&sort_by=default|created`。返回 `data[]`，每条 `id`、`content`（HTML）、`voteup_count`、`comment_count`、`author.name`、`created_time`；`paging.is_end` 判断到底。字段全表见 `references/api-fields.md`。
- 问题信息：`https://www.zhihu.com/api/v4/questions/<qid>?include=title,detail,answer_count,follower_count`，返回 `title`、`detail`、`answer_count`、`follower_count`。
- 单条回答：`https://www.zhihu.com/api/v4/answers/<answerId>?include=content,voteup_count,comment_count,author.name,created_time`。
- 注：`include` 里的字段用 `,` 或 `;` 分组指定，不加 `include` 只回默认字段；未登录/风控时可能返回 `error` 或跳登录，需要带常规浏览器头与 Cookie，是否需要额外签名/验证待确认。

## 已知现象
- 未登录浏览常弹出登录框，或只能看部分内容。
- 长回答显示为摘要，点「展开阅读全文」才展开。
- 推荐流里会混入广告和推广内容。
- 部分回答和盐选内容需要会员或付费才能看全。
- 列表接口有风控，连续快速请求或缺少浏览器头会返回错误或空。
