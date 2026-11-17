# DSH 手机扩展清单

这是一个**简易的扩展市场清单**：只收录能在 DSH 手机上用的扩展，也就是「带手机扩展声明的 DSH 插件」。作者投稿、CI 扫描核对、App 里展示，装的时候由 DSH 宿主装到它自己那台电脑上。

它是 dsh-market / awesome-dsh-plugin 那套思路的轻量版，只借两件事：**一个插件一个文件地投稿**，和**扫描核对条目还活着**。不做账号、评分、审核流水线——扩展跑在隔离网页框里、能力受 App 白名单约束，来源由作者与用户自己负责。

清单随 `dsh-mobile-plugin` 这个 npm 包发版：合进条目、发一版插件，用户就拿到新目录。宿主直接从自己包里读 `index.json`，不走网络、不依赖任何外部托管。

## 投稿

在 `entries/` 加一个 JSON 文件，文件名 `<owner>__<repo>.json`（owner/repo 用你 GitHub 仓库的地址），提 PR。一个插件一个文件，永不和别人的条目冲突。字段：

```json
{
  "name": "dsh-your-plugin",
  "repo": "https://github.com/owner/dsh-your-plugin",
  "owner": "owner",
  "title": { "en": "Your Plugin", "zh": "你的插件" },
  "description": { "en": "一句功能说明，句号结尾。", "zh": "一句功能说明，句号结尾。" },
  "category": "tools",
  "npm": "dsh-your-plugin",
  "icon": "https://raw.githubusercontent.com/owner/dsh-your-plugin/main/icon.png",
  "capabilities": ["host.data"],
  "added": "2026-11-18"
}
```

- 必填：`name`、`repo`、`description`（至少一门语言）。`owner` 写了就必须和 repo 对得上。
- `npm` 可省：省了就用 `github:owner/repo` 装；填了必须是真实发布在 npm 的包名，**包的 `repository` 字段要指回这个 repo**。
- `category` 取值：`tools` / `office` / `life` / `fun` / `dev`；别的也可，只是没有中文名。
- `icon` / `screenshots` 只认 https 绝对地址；不填图标就显示名字首字母。
- `added` 用 `YYYY-MM-DD`。描述只说功能，不写营销词，数字与 API 名要与代码对得上。

### 准入

自动扫描（`scan.mjs`）核的是硬事实：仓库在、没归档没禁用、包里声明了 `dsh.bundle` 或
`dshMobileExtensions`（只收「带手机扩展的 DSH 插件」）。这几条不过，维护者不会合并。

其余靠维护者读源码把关，CI 不替他判断：

1. 描述里写的数字、命令、API 名是否与代码对得上——夸大是被打回的主要原因。
2. 是不是真在维护、有没有可疑行为（空壳、混淆代码、凭据外传）。仓库刚建、还没成形的，先做完再投。
3. 聚合包（自己不干活、只列一堆依赖）不单独收录，收它依赖的那些插件；依赖要指向原作者。
4. 同一功能已有更好的条目时择善收录，不重复堆。

一个 PR 建议只加少数几条：评审是逐条读源码的，堆一大包没人能认真看完。

## 生成与扫描

```sh
node scripts/build.mjs          # entries/*.json → index.json（宿主读的就是它）
node scripts/build.mjs --check  # CI 校验 index.json 是不是当前 entries 生成的
node scripts/scan.mjs           # 联网扫描每个仓库是否还活着、是否还带扩展声明
node scripts/test-registry.mjs  # 本地守卫，不联网
```

改了条目一定要重新 `build.mjs`，把 `index.json` 一起提交——宿主读的是它，不是 `entries/`。

扫描失败（仓库没了、归档了、把声明删了）**不自动删条目**，只在报告里标出来、提 issue 等人确认。被收录不是永久的：停更、失效、行为异常的条目会被移除。

## 数据怎么到 App

`index.json` 在 `dsh-mobile-plugin` 的 npm 包 `files` 白名单里，随插件发版到用户电脑上。
宿主读到后经已配对的隧道给 App；App 点安装走宿主既有的插件管理器，装到宿主那台电脑上。
App 自己不连公网、不跑 pnpm，也没有任何清单地址要配置——换台电脑装了这版插件，目录就在那。

收录新插件的流程：条目合并进 `entries/` → 重新 `build.mjs` 生成 `index.json` → 发一版
`dsh-mobile-plugin`。**不另发清单、不更新托管地址**；代价是新目录要等这次发版才到用户手里。
