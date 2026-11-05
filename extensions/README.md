# 已审核的第三方扩展

这个目录随 `dsh-mobile-plugin` 的 npm 包一起发布。手机上「随插件发布」那一档扩展从这里读：
宿主只认 `catalog.json` 里登记的 slug，目录里有但没登记的一律不下发。

## 提交流程

1. 在 `extensions/<slug>/` 放扩展包：`manifest.json` 与 `index.html` 等，形状与 App 侧现有
   扩展包一致（自包含、相对路径引用，不许外链）。目录名就是 slug，只认字母、数字、点、
   下划线、横线，最长 64 个字符。**入口页固定叫 `index.html`**：手机打开扩展找的就是包目录
   下这一层，`manifest.json` 里写 `main` 指到别的文件不生效。缺 `index.html` 的包宿主列清单
   时会直接跳过，别等装到手机上才发现打不开。
2. 在 `extensions/catalog.json` 的 `packages` 里加一条，填 `slug`（必须与目录名一致）与
   `description` / `author` / `releaseNotes`。
3. 提 PR 前在本地跑一遍自验：

   ```sh
   cd dsh-mobile-plugin
   node --test test/extension-catalog.test.cjs   # 宿主列包、入口页、取文件的判据
   npm pack --dry-run                            # 看扩展目录是否真进了 npm 包
   ```

   想按发版那套全量口径验（含「登记的扩展都带入口页」），跑 `node scripts/preflight-release.mjs`；
   空清单时这几条都是绿的，第一个包进来才真正验得到。
4. 提 PR，一次只放一个包。合并即随下一次插件发版上架；从 `packages` 里删掉那一条即下架。

这个目录是随包发布的只读内容，宿主不会创建它，也不会写它。

## 审核口径

登记即视为已审核，所以审的是包本身，不是清单里的那几行字：

- 入口页第一屏能不能打开，页面有没有模仿系统界面骗用户填东西；
- 包里会不会往外发请求。页面从 `file://` 加载，CSP 挡外链，资源必须都在包里；
- `manifest.json` 声明的能力与实际行为对不对得上；
- 右栏入口的图标与名字像不像 App 自带的功能（叫「设置」「账户」这类直接打回）；
- 体积：整包不超过 20 MB、不超过 200 个文件，单文件不超过 8 MB。缺 `manifest.json`、
  缺 `index.html`、或体积超了，宿主都会静默跳过，包根本不会出现在手机上。

## 字段含义

`catalog.json` 的形状是 `{"packages": [{"slug": "...", "description": "...", "author": "...", "releaseNotes": "..."}]}`。

- `slug`（必填）：包目录名，也是手机侧的身份。重复只认第一条，不合规的连读都不读。
- `description` / `author` / `releaseNotes`（可选）：只收非空字符串，缺了或不是字符串一律
  回 `null`。`author` 写显示名加一个能联系上的方式，下架时找得到人。
- **不要在这里写 `name`、`version`、`size`、`sha256`、`files`、`capabilities`**：文件清单与哈希
  由宿主扫目录现算，名字、版本、能力从包自己的 `manifest.json` 读，填了也不认。

宿主下发给手机的一条 Package 还带这些从包里读出来的字段：`name`、`versionName`、
`apiVersion`、`capabilities`（从 `manifest.json` 收窄成字符串数组）、`size`、`fileCount`、
`files`（每项 `path` / `size` / `sha256`）。

## 取文件

`GET /api/mobile/v1/extension/catalog/file?slug=&path=` 按清单里的文件逐个字节下发
（base64 + sha256）。`path` 只能是包目录内的相对路径，绝对路径、`..`、resolve 之后越出包目录
的一律拒绝。没登记进 `catalog.json` 的 slug 取不到任何文件。

## 与本地开发包的区别

作者边写边看用 `$DSH_HOME/extension-dev`（作者电脑上的目录，走 `/extension/dev/*`），那条路
绕过审核，只能手动导入、界面标「本地」。这里是随插件 npm 包发布的正式来源，要上架就得走
上面的 PR 与审核。
