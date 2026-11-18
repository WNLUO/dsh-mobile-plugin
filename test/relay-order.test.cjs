'use strict'
// `orderByLatency` 的纯排序契约：能测到延迟的按升序在前，不可达 / 没测到的排后并保持原相对顺序。
//
// 这条函数是 worker 连中转前「先按实测延迟排序、再按序连」的唯一排序处（探测在 relay-probe
// 的另一半）。纯函数、不发网络，所以这里直接喂假数据钉住边界。

const assert = require('node:assert/strict')
const test = require('node:test')

const { orderByLatency } = require('../lib/relay/relay-probe.js')

test('能测到延迟的按升序排在最前', () => {
  const urls = ['https://a', 'https://b', 'https://c']
  const latency = new Map([['https://a', 80], ['https://b', 20], ['https://c', 50]])
  assert.deepEqual(orderByLatency(urls, latency), ['https://b', 'https://c', 'https://a'])
})

test('不可达的排后面，且保持它们在原数组里的相对顺序', () => {
  const urls = ['https://a', 'https://b', 'https://c', 'https://d']
  const latency = new Map([['https://a', null], ['https://b', 30], ['https://c', null], ['https://d', 10]])
  // b、d 可达（d 更快在前）；a、c 不可达，按原序 a 在 c 前。
  assert.deepEqual(orderByLatency(urls, latency), ['https://d', 'https://b', 'https://a', 'https://c'])
})

test('缺失等同不可达：Map 里没有的键也排后面', () => {
  const urls = ['https://a', 'https://b', 'https://c']
  const latency = new Map([['https://b', 5]])
  assert.deepEqual(orderByLatency(urls, latency), ['https://b', 'https://a', 'https://c'])
})

test('不改原数组', () => {
  const urls = ['https://a', 'https://b', 'https://c']
  const snapshot = urls.slice()
  orderByLatency(urls, new Map([['https://a', 90], ['https://b', 10], ['https://c', 50]]))
  assert.deepEqual(urls, snapshot, '入参数组必须原样不动')
})

test('空数组返回空数组', () => {
  assert.deepEqual(orderByLatency([], new Map()), [])
  assert.deepEqual(orderByLatency([], {}), [])
})

test('普通对象进参与 Map 等价', () => {
  const urls = ['https://a', 'https://b', 'https://c']
  const latency = { 'https://a': 70, 'https://b': 30, 'https://c': null }
  assert.deepEqual(orderByLatency(urls, latency), ['https://b', 'https://a', 'https://c'])
})

test('全都不可达时整体保持原序', () => {
  const urls = ['https://a', 'https://b', 'https://c']
  assert.deepEqual(orderByLatency(urls, new Map([['https://a', null], ['https://b', null], ['https://c', null]])), urls)
})
