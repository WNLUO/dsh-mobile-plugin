// 每代插件持有自己的媒体服务，卸载时中止其收存并释放订阅。
'use strict';
const instances = new WeakMap();
function mediaServiceOf(ctx) { return instances.get(ctx) || null; }
function setMediaService(ctx, service) { instances.set(ctx, service); return () => { instances.delete(ctx); service.close(); }; }
module.exports = { mediaServiceOf, setMediaService };
