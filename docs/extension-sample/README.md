# 最小样例：抄这个目录起步

一个能装进手机、能跑、能跟 App 说话的最小扩展。它只有两个文件（外加这一页说明）——
这就是「一个扩展」的全部。

```
manifest.json   自述
index.html      入口页（固定这个名）
```

## 怎么拿它跑起来

1. 把整个目录拷到电脑上的开发目录，目录名就是它的标识（也就是它在手机上的 slug）：

   ```
   cp -r <这个插件包>/docs/extension-sample ~/.dsh/extension-dev/example
   ```

2. 手机上：设置 → 扩展 → 打开「开发者模式」。**这一下之后就不用再管手机了** —— 电脑上这个
   目录里有什么，手机就自己在几秒内装上，你改了内容它也跟着变。扩展页末尾那段「本地开发」
   只是一张状态表（哪个包装上了、哪一版、正在装哪一份），没有「导入」这类按钮要你点。

3. 现在再改 `index.html` 里任何一个字，回到手机上重进这一页就是新的。要自动刷新，在你
   自己的插件仓库里串一条构建 + 拷到开发目录的循环，见 `docs/extension-authoring.md` 第 9.1 节。

## 它演示了四件事

- **读 App 给的内容**：`window.__DSH_EXTENSION__` 上的 `content` / `capabilities` / `versionName`。
- **让 App 办一件事**：发一条 `{ kind: 'action', action: 'chat.draft', params }`，等
  `dsh-extension-reply` 那个事件按 `id` 回。
- **挑文件 / 存文件 / 存自己那份数据**：三个入口都在 `window.__dshExtension` 上，而且
  **只在对应能力被授予时才存在** —— 所以先判存在再画按钮（这份样例就是这么写的）。
- **取数那条通道用不了时，页面该怎么说**：这份样例的清单里**没有**声明 `hostData`，所以
  `window.__dshHostFetch` 根本不存在，页面上那一段会如实说「这一页没有向宿主取数」，而不是
  一直转圈。真要取数，得在自己的清单里声明（作者须知第 5.5 节）。

## 改的时候注意

- `manifest.json` 的 `capabilities` 里写的能力必须是 App 认识的那几个，表外的名字会被当成
  没写。整张表见作者须知第 4 节 —— 这份样例自己声明的是 `content.read` / `file.pick` /
  `file.save` / `storage`。
- 配色全用 `--dsh-theme-*` 变量，别写死颜色 —— 写死的话用户切到夜间，这一页还是亮白的。
- 顶栏与返回键由 App 画，页面里别再画一条。
- 要取电脑上的数据，得让**你的插件**（不是扩展目录）在 `package.json` 里声明
  `dshMobileDataServices`，见作者须知第 5.5 节。
