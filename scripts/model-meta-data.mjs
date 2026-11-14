/** 公开资料转换：保留独立推理档位，已知不读图与未知能力分开。 */
export const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function effortValues(record) {
  const options = Array.isArray(record?.reasoning_options) ? record.reasoning_options : [];
  const effort = options.find((option) => option?.type === 'effort');
  return Array.isArray(effort?.values) ? effort.values : undefined;
}

export function levelsOf(record) {
  const values = effortValues(record)?.map((value) => value === 'none' ? 'off' : value);
  if (!values) return undefined;
  const picked = LEVELS.filter((level) => values.includes(level));
  if (picked.length === 0) return undefined;
  return picked.length === 1 && picked[0] === 'off' ? [] : picked;
}

/** 只记录与档位 id 不同的协议值，例如 OpenAI 的 none。 */
export function wiresOf(record) {
  const values = effortValues(record);
  if (!values) return undefined;
  return values.includes('none') ? { off: 'none' } : {};
}
