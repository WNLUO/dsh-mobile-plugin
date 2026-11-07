# 笔记卡片字段（sns/web/v1/feed 的 data.items[]）

- `id`：笔记 ID（24 位十六进制）。
- `model_type`：条目类型。
- `note_card`：
  - `type`：`normal`（图文）或 `video`（视频）。
  - `display_title`：标题。
  - `user`：`{ user_id, nickname, avatar, images }`。
  - `interact_info`：`{ liked, liked_count, collected, collected_count, comment_count, share_count, followed }`。
  - `cover`：`{ url_default, url_pre, width, height }`。
  - `image_list[]`：`{ url_default, width, height, live_photo }`。
  - `video`：`{ media: { stream: { h264[]{master_url}, h265[] } }, image{...} }`。
  - `tag_list[]`：`{ name, type }`。
  - `time`、`last_update_time`、`ip_location`。

搜索接口 `sns/web/v1/search/notes` 的条目结构相同，另带每条自己的 `xsec_token`。

注：需 `x-s` / `x-t` 签名头与登录 Cookie，签名算法随版本变。
