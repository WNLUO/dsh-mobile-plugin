# React/

移动端插件的网页端（单页）。组件一律取自 [Appica UI](https://appica.dev/ui)，不自己写基础组件。

## 开发

```bash
pnpm install
pnpm dev        # http://127.0.0.1:5273，/api 自动转发到本机 DSH 网页端
```

端口是 5273；DSH 网页端不在默认 19387 时用 `DSH_WEB_URL=http://127.0.0.1:<端口> pnpm dev`。

## 构建

```bash
pnpm build      # 产出 ../lib/panel/index.html（单文件，宿主直接吐这一个文件）
```

产物进插件包，改完页面要重新构建再发布；只跑 `pnpm dev` 的改动不会影响已发布的插件。
