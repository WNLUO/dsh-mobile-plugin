---
name: github.com
display: GitHub
domains: ["github.com"]
aliases: ["GitHub", "github", "代码仓库"]
apps: []
open: github.com
mode: desktop
pace: standard
description: 代码托管与协作平台，仓库、Issue 与 PR
---
## 是什么
GitHub 是代码托管与协作平台，主域名 `github.com`。核心单位是「仓库」（repository）：一个项目的代码、提交历史、Issue、Pull Request、Actions 等都挂在仓库下。我们暂无 GitHub 的 App 知识，`apps` 先留空，日后补了 APP.md 再加反链。

## 页面与网址
- 仓库首页：`https://github.com/<owner>/<repo>`。
- 文件：`/blob/<分支>/<路径>`；目录：`/tree/<分支>/<路径>`。
- 提交历史：`/commits/<分支>`；某次提交：`/commit/<sha>`；单文件历史：`/commits/<分支>/<路径>`；Blame：`/blame/<分支>/<路径>`。
- Issue 列表：`/issues`；单条：`/issues/<编号>`；新建：`/issues/new`。
- PR 列表：`/pulls`；单条：`/pull/<编号>`；文件改动：`/pull/<编号>/files`。
- 标签 `/labels`、里程碑 `/milestones`、讨论 `/discussions`、Actions `/actions`、某次运行 `/actions/runs/<run_id>`。
- Releases：`/releases`；标签：`/tags`。
- 搜索：`https://github.com/search?q=<关键词>&type=repositories|code|issues|pullrequests|users`，`type` 决定搜哪个范围。
- 用户/组织：`/<name>`；Gist：`gist.github.com/<user>/<gist_id>`（`gist.github.com` 是 `github.com` 的子域，按子域命中）。

## 界面
仓库页顶部是一排标签：Code、Issues、Pull requests、Actions、Projects、Wiki、Security、Insights、Settings。Code 页左侧是分支切换与文件树，中间是文件列表，下面渲染 README；右侧 About 栏有简介、Topics、Releases、语言占比。

文件页顶部显示路径和分支，右上角是「Raw / Blame / 历史」等按钮；代码行可以点行号定位。顶部全局搜索框可切「仓库 / 代码 / Issue / 用户」等范围。个人主页顶部是头像与关注信息，下面是置顶仓库和贡献热力图。

## 功能
- 浏览目录与单个文件、查看提交历史、对比分支、看某一行是谁改的（Blame）。
- Star、Watch、Fork 一个仓库；Releases 页下载发行包。
- Issues 与 Pull Requests 各有列表和筛选，PR 里有 Files changed、Commits、Checks 三个视图。
- Actions 跑 CI 工作流；代码搜索可按语言、仓库过滤。
- 支持 Markdown 渲染、任务清单、代码块、表格。

## 接口
- 仓库信息：`https://api.github.com/repos/<owner>/<repo>`，GET，返回 `full_name`、`description`、`stargazers_count`、`forks_count`、`open_issues_count`、`language`、`license.spdx_id`、`topics[]`、`default_branch`、`pushed_at` 等。字段全表见 `references/repo-fields.md`。
- 目录/文件：`https://api.github.com/repos/<owner>/<repo>/contents/<path>?ref=<分支>`，返回 `name`、`type`（file|dir）、`size`、`download_url`；文件内容在 `content`（base64）。
- 文件原文：`https://raw.githubusercontent.com/<owner>/<repo>/<分支>/<路径>`（纯文本，不是 JSON）。
- Issue/PR：`https://api.github.com/repos/<owner>/<repo>/issues/<编号>`，PR 也能从这里取（带 `pull_request` 字段），返回 `title`、`state`、`body`、`user.login`、`labels[]`、`comments`、`created_at`。
- 搜索：`https://api.github.com/search/repositories?q=<关键词>`、`/search/issues?q=...`。
- 未登录按 IP 限流（每分钟约 60 次），登录后更高；响应头 `X-RateLimit-Remaining` 可看余量。

## 已知现象
- 部分操作（提交、开 PR、评论、Star）需要登录。
- 大文件走 Git LFS，页面上是占位说明而不是内容。
- 未登录时对 API 和页面有访问频率限制，刷太快会临时被挡。
- 私有仓库只有授权账号看得到。
- 代码搜索需要登录，未登录只能搜仓库/Issue。
