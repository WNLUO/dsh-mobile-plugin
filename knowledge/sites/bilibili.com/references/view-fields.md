# 视频详情接口字段（x/web-interface/view）

`GET https://api.bilibili.com/x/web-interface/view?bvid=<BV号>` 返回的 `data`：

- `bvid` / `aid`：视频的 BV 号与数字 av 号。
- `title`、`desc`、`pic`（封面图 URL）、`pubdate`（发布时间戳，秒）。
- `duration`：总时长（秒）。
- `owner`：`{ mid, name, face }`（UP 主的用户 ID、昵称、头像）。
- `stat`：`{ view 播放, danmaku 弹幕, reply 评论, favorite 收藏, coin 投币, share 分享, like 点赞, now_rank, his_rank }`。
- `pages[]`：分P 列表，每项 `{ cid, page, part, duration }`；`cid` 是取弹幕要用的。
- `tname` / `tid`：分区名与分区 ID。
- `videos`：分P 数量。
- `copyright`、`dimension{width,height,rotate}`、`state`。

评论 `GET https://api.bilibili.com/x/v2/reply?type=1&oid=<aid>&pn=<页码>` 的 `data.replies[]` 每项：`member{uname,mid,avatar}`、`content.message`、`like`、`rcount`（楼中楼数）、`ctime`、`replies[]`。

弹幕 `GET https://api.bilibili.com/x/v1/dm/list.so?oid=<cid>` 返回 XML，每条 `<d p="时间,模式,字号,颜色,时间戳,弹幕池,uid,行ID">文字</d>`。
