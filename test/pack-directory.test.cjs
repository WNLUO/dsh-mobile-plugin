'use strict';

/**
 * 整包打包的命令选择。Windows 上系统没有 zip，原来那条路会让装扩展直接失败；
 * 这里钉住「Windows 用自带 tar、其余系统保持 zip」，以及两条宿主路都在用这个工具。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { packCommand, packDirectory } = require('../lib/mobile/pack-directory.js');

test('Windows 用系统自带 tar 打 zip，其余系统仍是 zip', () => {
  assert.deepEqual(packCommand('win32', '/tmp/out.zip'), {
    command: 'tar',
    args: ['-a', '-cf', '/tmp/out.zip', '.'],
  });
  assert.deepEqual(packCommand('darwin', '/tmp/out.zip'), {
    command: 'zip',
    args: ['-r', '-q', '-X', '/tmp/out.zip', '.'],
  });
  assert.deepEqual(packCommand('linux', '/tmp/out.zip'), {
    command: 'zip',
    args: ['-r', '-q', '-X', '/tmp/out.zip', '.'],
  });
});

test('两条宿主整包路都走 pack-directory，不再自己调系统 zip', () => {
  for (const name of ['extension-catalog.js', 'extension-dev.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', name), 'utf8');
    assert.match(source, /packDirectory\(directory, outFile\)/, `${name} 要共用按平台选命令的打包工具`);
    assert.doesNotMatch(source, /execFileSync\(['"]zip['"]/, `${name} 不该再直接调 zip：Windows 上没有`);
  }
});

test('当前平台真打一份 zip：包内是相对路径，临时包不进包', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pack-directory-'));
  const directory = path.join(parent, 'src');
  const out = path.join(parent, 'out.zip');
  try {
    fs.mkdirSync(path.join(directory, 'libs'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'index.html'), '<h1>ok</h1>');
    fs.writeFileSync(path.join(directory, 'libs', 'a.js'), 'export default 1');

    packDirectory(directory, out);

    const raw = fs.readFileSync(out);
    assert.equal(raw.subarray(0, 2).toString('latin1'), 'PK', '产物得是 zip');
    assert.match(raw.toString('latin1'), /index\.html/, '包内要有相对路径的入口页');
    assert.match(raw.toString('latin1'), /libs\/a\.js/, '子目录也要在，且用正斜杠');
    assert.doesNotMatch(raw.toString('latin1'), /out\.zip/, '临时包不能把自己打进去');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
