# GitHub REST 字段

## GET /repos/{owner}/{repo}
`id`、`full_name`、`owner.login`、`description`、`private`、`html_url`、`language`、`stargazers_count`、`watchers_count`、`forks_count`、`open_issues_count`、`subscribers_count`、`topics[]`、`license{spdx_id,name}`、`default_branch`、`created_at`、`updated_at`、`pushed_at`、`size`（KB）、`archived`、`fork`。

## GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
`name`、`path`、`sha`、`size`、`type`（file|dir|symlink|submodule）、`download_url`、`content`（base64）、`encoding`。

## GET /repos/{owner}/{repo}/issues/{n}
`number`、`title`、`state`、`body`、`user.login`、`labels[]{name,color}`、`assignees[]`、`comments`、`created_at`、`updated_at`、`closed_at`、`pull_request{url,merged_at}`（是 PR 时才有）。

## GET /search/repositories?q=...
`total_count`、`items[]`（每项是 repo 字段的子集）。
