---
name: github.com
display: GitHub
description: 代码托管与协作平台，仓库、Issue 与 PR
sites: ["github.com"]
aliases: ["GitHub", "github", "代码仓库"]
---
## 是什么
GitHub 是代码托管与协作平台，主域名 `github.com`。核心单位是「仓库」（repository）：一个项目的代码、提交历史、Issue、Pull Request、Actions 等都挂在仓库下。

## 界面
仓库页顶部是一排标签：Code、Issues、Pull requests、Actions、Projects、Wiki、Security、Insights、Settings。Code 页左侧是分支切换与文件树，中间是文件列表，下面渲染 README；右侧 About 栏有简介、Topics、Releases、语言占比。

文件页顶部显示路径和分支，右上角是「Raw / Blame / 历史」等按钮；代码行可以点行号定位。顶部全局搜索框可切「仓库 / 代码 / Issue / 用户」等范围。个人主页顶部是头像与关注信息，下面是置顶仓库和贡献热力图。

## 功能
- 浏览目录与单个文件、查看提交历史、对比分支、看某一行是谁改的（Blame）。
- Star、Watch、Fork 一个仓库；Releases 页下载发行包。
- Issues 与 Pull Requests 各有列表和筛选，PR 里有 Files changed、Commits、Checks 三个视图。
- Actions 跑 CI 工作流；代码搜索可按语言、仓库过滤。
- 支持 Markdown 渲染、任务清单、代码块、表格。

## 已知现象
- 部分操作（提交、开 PR、评论、Star）需要登录。
- 大文件走 Git LFS，页面上是占位说明而不是内容。
- 未登录时对 API 和页面有访问频率限制，刷太快会临时被挡。
- 私有仓库只有授权账号看得到。
