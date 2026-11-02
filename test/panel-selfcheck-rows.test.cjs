'use strict';

/**
 * 守卫：连接自检那几行的**颜色档位**（面板侧，读源码）。
 *
 * 这张卡回答的是「手机能不能连进来」，所以四种防火墙结果各自的档位是一条产品判断，
 * 不该凭手感改：
 *   · `allowsApp === true`  → 好（放行了）
 *   · `allowsApp === false` → 坏（挡住了，这是唯一需要人动系统设置的一格）
 *   · `enabled === false`   → **好**，不是「不知道」。防火墙上一条规则都没有 = 什么都不挡，
 *     那件事对「能不能连」是通的；早先给的是灰点（`off`），用户看到灰点 +「防火墙没开」
 *     以为哪里坏了（2026-11-02 用户报的）。
 *   · 读不到 / 系统上没有可查的防火墙 → 黄（查不到，不许写成正常）
 *
 * 变异证明：把 `enabled === false` 那一支的 `ok` 改回 `off`（或把 `allowsApp === false` 的
 * `error` 改成 `warn`），下面三条各自会红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'React', 'src');
const read = (...parts) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');

/** 把 `firewallRow` 里某一支的原文切出来，断言它的档位与文案键。 */
function branch(source, marker) {
  const at = source.indexOf(marker);
  assert.ok(at > 0, `firewallRow 里找不到这一支：${marker}`);
  return source.slice(at, at + 260);
}

test('防火墙那几行的档位：没开算好，挡住才算坏，读不到是黄', () => {
  const source = read('lib', 'selfcheck.ts');

  const off = branch(source, 'firewall.enabled === false');
  assert.match(off, /tone: 'ok'/, '防火墙没开要判「好」：它什么都不挡，手机连得进来');
  assert.match(off, /panel\.selfcheck\.firewallOff/, '这一支说的是「没开」');
  assert.ok(!/tone: 'off'/.test(off), '别退回灰点：用户会把灰点读成「有问题」');

  const blocked = branch(source, 'firewall.allowsApp === false');
  assert.match(blocked, /tone: 'error'/, '挡住了才是要人动手的那一格，必须是红');

  const allowed = branch(source, 'firewall.allowsApp === true');
  assert.match(allowed, /tone: 'ok'/, '放行了就是好');

  const unknown = branch(source, '!firewall.supported || firewall.enabled === null');
  assert.match(unknown, /tone: 'warn'/, '读不到不许写成正常：黄');
});

test('「没开」那句文案说清它不拦，不只是干巴巴一句「防火墙没开」', () => {
  const dict = read('lib', 'i18n', 'messages', 'selfcheck.ts');
  const zhHans = dict.match(/'panel\.selfcheck\.firewallOff': '([^']*)'/);
  assert.ok(zhHans, '字典里要有 firewallOff 这条');
  assert.ok(/不会拦/.test(zhHans[1]), '简中那句要带「不会拦」：光写「没开」，用户会以为哪儿坏了');
  // 十门语言都得改到，不能只换中文。
  const rows = dict.split("'panel.selfcheck.firewallOff'").length - 1;
  assert.equal(rows, 10, `firewallOff 只落在 ${rows} 门语言里，十门都要有`);
});
