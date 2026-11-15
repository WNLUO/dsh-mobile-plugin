'use strict';
// 已确认需求：两类隧道独立于 LAN 入口，始终转入带远程来源标记的内部代理。
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseTailcatTarget } = require('../lib/tailcat/wiring.cjs');
const { chooseP2PTarget } = require('../lib/p2p/wiring.cjs');

for (const [name, choose] of [['直连隧道', chooseTailcatTarget], ['点对点', chooseP2PTarget]]) {
  test(`${name}不依赖局域网开关和端口，只现读内部代理`, () => {
    let internal = 40911;
    let on = true;
    const target = choose({ lanEnabled: () => on, lanPort: () => { throw new Error('LAN unavailable'); }, tunnelPort: () => internal });
    assert.equal(target(), 40911);
    on = false;
    assert.equal(target(), 40911);
    internal = 40912;
    assert.equal(target(), 40912);
  });
}
