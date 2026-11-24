# 新服务商接入清单（面板 + 首次引导）

面向开发者：把一家新的「服务商线路」（ZeroNews / 节点小宝 / FRP 这类，用户填了地址、手机就能
拨回这台电脑的外部入口）接到**面板**和**首次接入引导页**里。

先分清两份文档：
- `docs/line-integration.md`：让一条线路在宿主侧成立——状态字段、上报给总控、心跳、二维码。
- 这份：让面板和引导页「看见」这家服务商——能选、能配、能判「接好没有」、配好再出码。

代码侧靠三处 `Record<NetworkProvider, …>` 强约束：少登记一处，TypeScript 当场编译不过。真正需要
人工的只有每家 10 种语言的译名与说明。

## 1. 登记到地区表（它属于国内还是国际）

- `React/src/lib/network-region.ts`
  - `NetworkProvider` 联合类型加这家 id；
  - `PROVIDERS` 加 `{ region: 'cn' | 'global' }`；
  - `ProviderPage` 与 `PAGE_PATHS` 加对应页（如 `cn/xxx`），地址栏 hash 才能落到它那一页。
- 这里是封闭联合：漏加会让下面几处一起编译报错，这是有意的。

## 2. 引导页注册表（主推 / 就绪判定 / 点开挂哪一页）

- `React/src/lib/onboarding-providers.tsx`
  - `PROVIDER_SETUP` 是 `Record<NetworkProvider, SetupEntry>`，必须补一条：
    - `primary`：该地区主推那家为 `true`（每个地区恰好一家）；
    - `ready(ctx)`：读 `StatusView` 判「这家接好了没有」，配好之后引导页才放二维码；
    - `Page`：点开时挂载的配置面板组件（复用第 4 步那家自己的页）。
  - 漏补 → tsc 报错。引导页本身不用改，它按地区自动列出来、主推排最前。

## 3. 图标与文案键

- `React/src/components/ProviderLook.tsx`：`PROVIDER_LOOK` 是
  `Record<NetworkProvider, { icon, name, hint }>`，补图标与两条 i18n 键。
- 图标放 `React/src/components/ProviderIcons.tsx`，卡片与页面标题共用。
- i18n：`React/src/lib/i18n/messages/panel.ts` 每种语言补
  `panel.provider.<id>`（名字）与 `panel.provider.<id>Hint`（一句话说明）。**十种语言都要齐**，
  `test/panel-i18n.test.cjs` 会检查键集对称、占位符对齐、界面不留硬编码中文。
  - hint 只说「是什么、怎么来」，别写死操作步骤。有免费额度就如实说，别暗示这家是我们运营的。

## 4. 服务商自己的配置页 + 路由

- 新建 `React/src/components/XxxPage.tsx`，参照 `CloudflarePage.tsx` / `JdxbPage.tsx`；
  顶部有返回（回它所属的地区页）。
- `React/src/Console.tsx`：import 它，在 hash 路由里加一条 `page === 'cn/xxx'` 的渲染。
  `openProvider` / `backToRegion` 是通用的，不用改。
- 地区页 `ChinaLinesPage.tsx` / `GlobalLinesPage.tsx` 按 `providersOfRegion` 自动列出，一般不用动。

## 5. 就绪判定（「配好再出码」靠它）

`ready(ctx)` 读 `StatusView` 对应字段（例如 `status.zeroNews?.phase === 'connected'`）。如果这家
的运行状态不在 `/status` 里，先让宿主把它加进 status，或在引导页单独读一次（参考节点小宝的
`jdxbStatus()`，它有自己的接口）。

## 6. 跑哪些守卫

- 面板类型检查（`Record` 穷尽在这一步兜底）；
- `test/panel-i18n.test.cjs`（十语言键集与占位符）；
- `test/panel-network-page.test.cjs`（地区 → 服务商分页）；
- `ssr-smoke`（两屏能渲染）。

## 一句话

加一家服务商：宿主侧线路按 `docs/line-integration.md`，面板侧按本清单登记四处（地区表、引导注册表、
图标文案表、配置页与路由）+ 补十语言译文。前三张表是 `Record<NetworkProvider, …>`，漏了编译就红，
所以「忘了改引导页」这种退化不会再发生。
