'use strict'

// 直连隧道该把连接转到哪个端口。
//
// 现场（2026-11-07，SHIYAN 生产实例）：这台机器把「局域网」关着。局域网端口在被关掉时
// 根本没人监听（`resolveLanPort` 直接早返回、sidecar 也不起），而直连隧道的回环入口默认
// 把连接转给那个端口——于是手机那条隧道**握手能成、数据一到就断**（空响应），表现成
// 「隧道一直建不起来」。此前每台手机都退回中继走，tailcat 从没真正用上。
//
// 这条守卫钉住：局域网关着时，直连隧道改转宿主 web 端口（手机 API 就在那，LAN sidecar
// 平时也只是把连接原样转给 `ctx.webServer.port`）。把 `chooseTailcatTarget` 改回「永远返回
// 局域网端口」，第二、三条会立刻红。

const test = require('node:test')
const assert = require('node:assert/strict')

const { chooseTailcatTarget } = require('../lib/tailcat/wiring.cjs')

test('局域网开着：直连隧道照旧转给当前局域网端口', () => {
  const target = chooseTailcatTarget({ lanEnabled: () => true, lanPort: () => 18787, webPort: () => 3080 })
  assert.equal(target(), 18787)
})

test('局域网关着：直连隧道改转宿主 web 端口（局域网端口此时没人监听）', () => {
  const target = chooseTailcatTarget({ lanEnabled: () => false, lanPort: () => 18787, webPort: () => 3080 })
  assert.equal(target(), 3080, '局域网关时若仍转局域网端口，隧道会握手成功却收不到数据')
})

test('每次现读端口，不把值缓存下来', () => {
  let lan = 18787
  const target = chooseTailcatTarget({ lanEnabled: () => true, lanPort: () => lan, webPort: () => 3080 })
  assert.equal(target(), 18787)
  lan = 19999
  assert.equal(target(), 19999, '端口会被自适应改掉，入口必须每次连接现读')
})
