# 知乎 v4 接口字段

## GET /api/v4/questions/{qid}/answers
参数：`limit`（每页，最大 20）、`offset`（从 0 开始）、`sort_by`（`default` 或 `created`）、`include`（逗号分隔，或 `;` 分组）。

返回 `data[]`，每条回答：
- `id`：回答 ID。
- `content`：回答正文（HTML）。
- `voteup_count`：赞同数。
- `comment_count`：评论数。
- `author`：`{ name, headline, url_token, avatar_url_template }`。
- `created_time`、`updated_time`：时间戳（秒）。
- `is_collapsed`：是否被折叠。

`paging`：`{ is_end, next, totals }`。

## GET /api/v4/questions/{qid}
`include=title,detail,answer_count,follower_count,comment_count` → 返回 `title`、`detail`（问题描述 HTML）、`answer_count`、`follower_count`、`comment_count`。

## GET /api/v4/answers/{answerId}
`include=content,voteup_count,comment_count,author.name,created_time` → 单条回答同上的字段。
