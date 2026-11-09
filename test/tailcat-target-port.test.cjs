'use strict'

// 直连隧道该把连接转到哪个端口。
//
// 现场（2026-11-07，SHIYAN 生产实例）：这台机器把「局域网」关着。局域网端口在被关掉时
// 根本没人监听（`resolveLanPort` 直接早返回、sidecar 也不起），而直连隧道的回环入口默认
// 把连接转给那个端口——于是手机那条隧道**握手能成、数据一到就断**（空响应），表现成
// 「隧道一直建不起来」。此前每台手机都退回中继走，tailcat 从没真正用上。
//
// 2026-11-09 修：局域网关着时**不能再裸转宿主 web 端口**。那是一条纯 TCP 透传，请求上
// 不带任何转发标记，而控制面 `localOnly` 的判据全落在转发标记与 Host 上、不校验来源 IP
// （见 `lib/shared/via-header.js` 文件头）——于是一台已配对的手机经隧道打
// `/api/relay/revoke-all`、`/api/relay/config`、`/api/relay/update/apply`，会被当成
// 「本机设置页」照单执行。现在改为转给 `relay/tunnel-forwarder.cjs` 起的落点代理，
// 它打上 `x-dsh-via` 再转 web 端口，移动 API 原样放过（只认 token）。
//
// 这条守卫钉住：局域网开着转局域网端口；关着转落点代理（**不是** web 端口）。把
// `chooseTailcatTarget` 改回「关着就返回 web 端口」，第二条会立刻红。

const test = require('node:test')
const assert = require('node:assert/strict')

const { chooseTailcatTarget } = require('../lib/tailcat/wiring.cjs')

test('局域网开着：直连隧道照旧转给当前局域网端口', () => {
  const target = chooseTailcatTarget({ lanEnabled: () => true, lanPort: () => 18787, tunnelPort: () => 40911 })
  assert.equal(target(), 18787)
})

test('局域网关着：转给打标记的落点代理，绝不裸转 web 端口', () => {
  const target = chooseTailcatTarget({ lanEnabled: () => false, lanPort: () => 18787, tunnelPort: () => 40911 })
  assert.equal(target(), 40911, '局域网关时若转 web 端口，请求不带转发标记，会被控制面当成「本机设置页」')
})

test('每次现读端口，不把值缓存下来', () => {
  let lan = 18787
  const target = chooseTailcatTarget({ lanEnabled: () => true, lanPort: () => lan, tunnelPort: () => 40911 })
  assert.equal(target(), 18787)
  lan = 19999
  assert.equal(target(), 19999, '端口会被自适应改掉，入口必须每次连接现读')
})
