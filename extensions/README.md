# 随插件发布的官方扩展

这个目录随 `dsh-mobile-plugin` 的 npm 包一起发布，装的是**我们自己发的官方扩展**。宿主只认
`catalog.json` 里登记的 slug，目录里有但没登记的一律不下发。当前清单是空的。

**Office 预览不走这里**：它发在 APP 分发系统（`platform = extension`），源码、渲染器与那六个库
在独立仓库 `dsh-office-plugin`，手机上的扩展市场页读的就是分发系统清单。

第三方扩展不经过这里。作者在自己的插件包里声明 `dshMobileExtensions` 就能让他的手机拉到，
不用提 PR、不用我们审 —— 见 `dsh-mobile-extensions` 仓库的作者须知第 8 节（同包 `docs/` 下那份是
发版前同步来的副本）。这一份只讲随本包发布的官方这一档。

## 加一个官方扩展

1. 在 `extensions/<slug>/` 放扩展包：`manifest.json` 与 `index.html` 等，形状与 App 侧现有
   扩展包一致（自包含、相对路径引用，不许外链）。目录名就是 slug，只认字母、数字、点、
   下划线、横线，最长 64 个字符。**入口页固定叫 `index.html`**：手机打开扩展找的就是包目录
   下这一层，`manifest.json` 里写 `main` 指到别的文件不生效。缺 `index.html` 的包宿主列清单
   时会直接跳过，别等装到手机上才发现打不开。
2. 在 `extensions/catalog.json` 的 `packages` 里加一条，填 `slug`（必须与目录名一致）与
   `description` / `author` / `releaseNotes`。
3. 发版前在本地跑一遍自验：

   ```sh
   cd dsh-mobile-plugin
   node --test test/extension-catalog.test.cjs   # 宿主列包、入口页、取文件的判据
   npm pack --dry-run                            # 看扩展目录是否真进了 npm 包
   ```

   按发版那套全量口径验（含「登记的扩展都带入口页」）跑 `node scripts/preflight-release.mjs`；
   空清单时这几条都是绿的，第一个包进来才真正验得到。
4. 随下一次插件发版上架；从 `packages` 里删掉那一条即下架。

这个目录是随包发布的只读内容，宿主不会创建它，也不会写它。

## 判据（机械判定，不解释原因）

官方扩展是我们自己发的，不审作者人品，只判「能不能装」——这几条判不过的包不会出现在手机上：

- 缺 `manifest.json`、或缺入口页 `index.html`；
- 整包不超过 20 MB、不超过 400 个文件，单文件不超过 8 MB。

（第三方插件自带的那一档用同一套判据，见 `lib/mobile/third-party-extensions.js`。）

## 字段含义

`catalog.json` 的形状是 `{"packages": [{"slug": "...", "description": "...", "author": "...", "releaseNotes": "..."}]}`。

- `slug`（必填）：包目录名，也是手机侧的身份。重复只认第一条，不合规的连读都不读。
- `description` / `author` / `releaseNotes`（可选）：只收非空字符串，缺了或不是字符串一律
  回 `null`。
- **不要在这里写 `name`、`version`、`size`、`sha256`、`files`、`capabilities`**：文件清单与哈希
  由宿主扫目录现算，名字、版本、能力从包自己的 `manifest.json` 读，填了也不认。

宿主下发给手机的一条 Package 还带这些从包里读出来的字段：`name`、`versionName`、
`apiVersion`、`capabilities`（从 `manifest.json` 收窄成字符串数组）、`size`、`fileCount`、
`files`（每项 `path` / `size` / `sha256`）。

## 取文件

`GET /api/mobile/v1/extension/catalog/file?slug=&path=` 按清单里的文件逐个字节下发
（base64 + sha256）。`path` 只能是包目录内的相对路径，绝对路径、`..`、resolve 之后越出包目录
的一律拒绝。这个 slug 既不在本插件的 `catalog.json` 里、也不是哪个插件声明过的，取不到任何文件。

## 与另两条来源的区别

手机扩展页里一共三档来源，别混：

- **官方**：本目录，随 `dsh-mobile-plugin` 发版，登记在 `catalog.json`；
- **第三方插件**：作者自己的插件里声明 `dshMobileExtensions`，用户自己装插件、自己承担；
- **本地开发包**：作者电脑上的 `$DSH_HOME/extension-dev`（走 `/extension/dev/*`），边写边看，
  只能手动导入、界面标「本地」。
