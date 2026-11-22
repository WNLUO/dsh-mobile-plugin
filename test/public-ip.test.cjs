// 公网 IPv4 探测：按顺序取第一个合法的公网地址，全失败回 null；成功缓存 5 分钟、失败 60 秒。
'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { detectPublicIpv4, resetPublicIpCache } = require('../lib/relay/public-ip.cjs')

const SOURCES = [
  'https://api.ipify.org',
  'https://ipv4.icanhazip.com',
  'https://myip.ipip.net',
  'https://ddns.oray.com/checkip',
]

/** 按 URL 给回复的假 fetch：记下每次请求，未配置的 URL 当作连不上。 */
function fakeFetch(replies) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (!Object.prototype.hasOwnProperty.call(replies, url)) throw new Error(`unexpected ${url}`)
    const reply = replies[url]
    if (reply instanceof Error) throw reply
    return { ok: true, text: async () => reply }
  }
  return { fetchImpl, calls }
}

test('公网 IPv4：第一个回显服务给出合法地址就采用，不再问后面的', async (t) => {
  resetPublicIpCache()
  t.after(resetPublicIpCache)
  const { fetchImpl, calls } = fakeFetch({ [SOURCES[0]]: '1.207.158.147\n' })

  const result = await detectPublicIpv4({ fetchImpl })

  assert.equal(result.ip, '1.207.158.147')
  assert.equal(result.source, SOURCES[0])
  assert.equal(typeof result.ms, 'number')
  assert.deepEqual(calls, [SOURCES[0]], '命中后不许再请求后面的源')
})

test('公网 IPv4：第一个回私网或垃圾正文就跳到下一个，取到第二个的地址', async (t) => {
  resetPublicIpCache()
  t.after(resetPublicIpCache)

  for (const firstReply of ['192.168.1.5', '这里没有地址']) {
    resetPublicIpCache()
    const { fetchImpl, calls } = fakeFetch({
      [SOURCES[0]]: firstReply,
      [SOURCES[1]]: '1.207.158.147\n',
    })

    const result = await detectPublicIpv4({ fetchImpl })

    assert.equal(result.ip, '1.207.158.147', `${firstReply} 不该被当成公网 IPv4`)
    assert.equal(result.source, SOURCES[1])
    assert.deepEqual(calls, [SOURCES[0], SOURCES[1]])
  }
})

test('公网 IPv4：四个源全失败时回 null 且不抛错', async (t) => {
  resetPublicIpCache()
  t.after(resetPublicIpCache)
  const { fetchImpl, calls } = fakeFetch({
    [SOURCES[0]]: new Error('timeout'),
    [SOURCES[1]]: '10.0.0.2',
    [SOURCES[2]]: '当前 IP：100.64.3.4',
    [SOURCES[3]]: 'Current IP Address: 127.0.0.1',
  })

  const result = await detectPublicIpv4({ fetchImpl })

  assert.deepEqual(result, { ip: null, source: null, ms: null })
  assert.deepEqual(calls, SOURCES, '失败时把四个源都试完')
})

test('公网 IPv4：成功后 5 分钟内复用缓存，不重复打外网；过期后才再探测', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  resetPublicIpCache()
  t.after(resetPublicIpCache)
  const { fetchImpl, calls } = fakeFetch({ [SOURCES[0]]: '1.207.158.147' })

  const first = await detectPublicIpv4({ fetchImpl })
  const second = await detectPublicIpv4({ fetchImpl })
  assert.equal(calls.length, 1, '5 分钟内第二次调用不该再打外网')
  assert.deepEqual(second, first, '缓存命中的 ms 是当初那一次探测的耗时')

  t.mock.timers.tick(5 * 60 * 1000 + 1)
  await detectPublicIpv4({ fetchImpl })
  assert.equal(calls.length, 2, '成功缓存过期后要重新探测')
})

test('公网 IPv4：失败结果 60 秒内不重试，过期后才重新探测', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  resetPublicIpCache()
  t.after(resetPublicIpCache)
  const { fetchImpl, calls } = fakeFetch({
    [SOURCES[0]]: new Error('offline'),
    [SOURCES[1]]: new Error('offline'),
    [SOURCES[2]]: new Error('offline'),
    [SOURCES[3]]: new Error('offline'),
  })

  assert.equal((await detectPublicIpv4({ fetchImpl })).ip, null)
  assert.equal(calls.length, 4)

  await detectPublicIpv4({ fetchImpl })
  assert.equal(calls.length, 4, '失败缓存 60 秒内不该重新打外网')

  t.mock.timers.tick(60 * 1000 + 1)
  await detectPublicIpv4({ fetchImpl })
  assert.equal(calls.length, 8, '失败缓存过期后要把四个源重新试一遍')
})
