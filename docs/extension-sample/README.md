# 最小样例：抄这个目录起步

一个能装进手机、能跑、能跟 App 说话的最小扩展。它只有两个文件 —— 这就是「一个扩展」的全部。

```
manifest.json   自述
index.html      入口页（固定这个名）
```

## 怎么拿它跑起来

1. 把整个目录拷到电脑上的开发目录，目录名就是它的标识：

   ```
   cp -r <这个插件包>/docs/extension-sample ~/.dsh/extension-dev/example
   ```

2. 手机上：设置 → 扩展 → 打开「开发者模式」→ 回到扩展页 → 最底下「本地开发」→ 刷新 →
   「导入」。

3. 现在再改 `index.html` 里任何一个字，回到手机上重进这一页（或点调试面板的「重载」）
   就是新的。要自动刷新，在你自己的插件仓库里串一条构建 + 拷到开发目录的循环，见
   `docs/extension-authoring.md` 第 9.1 节。

## 它演示了三件事

- **读 App 给的内容**：`window.__DSH_EXTENSION__` 上的 `content` / `capabilities` / `versionName`。
- **向 App 要一次数据**：`window.__dshHostFetch(service, path)`，以及没有这项能力时页面该
  自己说清「这一页没取数」而不是转圈。
- **让 App 办一件事**：发一条 `{ kind: 'action', action: 'chat.draft', params }`，等
  `dsh-extension-reply` 那个事件按 `id` 回。

## 改的时候注意

- `manifest.json` 的 `capabilities` 里写的能力必须是 App 认识的那几个（`content.read` /
  `card.write` / `host.action` / `host.data`），写了别的会被当成没写。
- 配色全用 `--dsh-theme-*` 变量，别写死颜色 —— 写死的话用户切到夜间，这一页还是亮白的。
- 顶栏与返回键由 App 画，页面里别再画一条。
- 要取电脑上的数据，得让**你的插件**（不是扩展目录）在 `package.json` 里声明
  `dshMobileDataServices`，见文档第 5.5 节。
