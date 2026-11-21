// 扩展目录声明：来源、用途和年龄只透传作者提供的事实，不推断评级。
'use strict';

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function httpsOrNull(value) {
  const text = textOrNull(value);
  if (!text) return null;
  try { return new URL(text).protocol === 'https:' ? text : null; } catch { return null; }
}

function ageRatingOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const system = textOrNull(value.system);
  const rating = textOrNull(value.value);
  const minAge = Number.isInteger(value.minAge) && value.minAge >= 0 && value.minAge <= 21 ? value.minAge : null;
  return system && rating ? { system, value: rating, minAge, url: httpsOrNull(value.url) } : null;
}

function metadataOf(value) {
  const row = value && typeof value === 'object' ? value : {};
  return {
    purpose: textOrNull(row.purpose) || textOrNull(row.description),
    sourceUrl: httpsOrNull(row.sourceUrl),
    publicUrl: httpsOrNull(row.publicUrl),
    ageRating: ageRatingOf(row.ageRating),
  };
}

/** package.json 的仓库写法有字符串与对象两种；它是来源地址，不是公共详情页。 */
function packageSourceUrl(manifest) {
  const repository = manifest && manifest.repository;
  const raw = typeof repository === 'string' ? repository : repository && repository.url;
  return httpsOrNull(typeof raw === 'string' ? raw.replace(/^git\+/, '').replace(/\.git$/, '') : null)
    || httpsOrNull(manifest && manifest.homepage);
}

module.exports = { metadataOf, ageRatingOf, httpsOrNull, packageSourceUrl };
