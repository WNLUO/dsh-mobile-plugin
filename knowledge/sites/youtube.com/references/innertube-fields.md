# InnerTube /player 响应字段

`POST https://www.youtube.com/youtubei/v1/player`，body：`{ videoId, context: { client: { clientName: "WEB", clientVersion: "2.xxxxx", hl, gl } } }`。

响应：

- `playabilityStatus`：`{ status, reason, playableInEmbed }`。`status` 常见 `OK`、`LOGIN_REQUIRED`、`AGE_VERIFICATION_REQUIRED`、`UNPLAYABLE`。
- `videoDetails`：`{ videoId, title, lengthSeconds, keywords[], channelId, shortDescription, thumbnail.thumbnails[], viewCount, author, isLiveContent }`。
- `streamingData`：`{ expiresInSeconds, formats[]{ itag, url, mimeType, bitrate, width, height, contentLength, qualityLabel, audioQuality }, adaptiveFormats[]{ ..., signatureCipher } }`。
- `captions.playerCaptionsTracklistRenderer.captionTracks[]`：`{ baseUrl, name.simpleText, languageCode }`。
- `microformat.playerMicroformatRenderer`：`{ publishDate, uploadDate, category, viewCount, ownerChannelName }`。

## oEmbed
`GET https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<id>&format=json`：`title`、`author_name`、`author_url`、`thumbnail_url`、`thumbnail_width`、`thumbnail_height`、`html`。
