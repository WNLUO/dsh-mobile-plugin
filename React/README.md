# React/

移动端插件的网页端（单页）。组件一律取自 [Appica UI](https://appica.dev/ui)，不自己写基础组件。

## 开发

```bash
pnpm install
DSH_WEB_URL=http://127.0.0.1:<端口> pnpm dev   # http://127.0.0.1:5273，/api 转发到你点名的宿主
```

端口是 5273。`pnpm dev` **只连你显式指定的宿主**（`DSH_WEB_URL`），没给就用 `dsh web` 的默认 19387；它不再自己扫本机端口去找宿主。

这一点是故意的：桌面版 DSH 用的是系统随机端口，自动扫会把它当成「本机 DSH 网页端」连上去，于是随手在开发页面上点几下（比如把引导走一遍）就把这台电脑正在用的真实配置改了。只想预览界面、不碰任何真实配置，用下面的 `pnpm demo`；要看真实数据，才显式带上 `DSH_WEB_URL`。

## 演示（录屏用）

```bash
pnpm demo       # http://127.0.0.1:5274/demo.html，打开就是引导页
```

这一页**不连任何宿主**：`src/demo/host.ts` 在渲染前覆写 `window.fetch`，把这页会打的那组
`/api/relay/*` 全部就地答掉，状态只在内存里，二维码是仓库里的假图。所以在这页上怎么点都
碰不到本机正在用的插件，刷新即回初始状态。配置完点「进入插件」看到的主页也全是演示数据。

`pnpm demo` 用的是 `vite.demo.config.ts`（把 `/api` 代理清空），别拿 `pnpm dev` 开这一页：
那条代理指向本机 DSH，留着等于给漏网的请求开后门。想看主页那一屏用
`?scene=settings` 直接进。演示页只在开发服务器里活着，`React/` 整个目录不进包。

## 构建

```bash
pnpm build      # 产出 ../lib/panel/index.html（单文件，宿主直接吐这一个文件）
```

产物进插件包，改完页面要重新构建再发布；只跑 `pnpm dev` 的改动不会影响已发布的插件。
