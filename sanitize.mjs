/**
 * 模型偶尔会把"心里话"写进正文（关掉思考模式后尤其容易）。
 * 这些是自述分析、不是对用户说的话，发出去就是事故。
 *
 * 典型形状：
 *   累了就歇着呗。别撑了。
 *
 *   [不回] 不合适，他这句是求安慰。短回。
 *
 *   大概就一句。别多。哦，那别硬撑了。躺着去。
 */
export function stripLeakedThinking(text) {
  let out = String(text || '').trim()
  if (!out) return out

  /* 1. 正文里夹了 [不回] 标记：前面有正话就截断在标记处 */
  const marker = out.indexOf('[不回]')
  if (marker > 0) out = out.slice(0, marker).trim()

  /* 2. 去掉末尾那种"自述该怎么回"的行 */
  const meta = /^(他想|他这句|他说|他觉得|短回|大概就|别多|不合适|可以回|直接回|这样回|不过|应该|也许|或者干脆|可以就)/
  let lines = out.split('\n').map((line) => line.trim()).filter(Boolean)
  while (lines.length > 1 && meta.test(lines[lines.length - 1])) lines.pop()

  /* 3. 只剩分析、没有正话时，宁可返回空（由上层走 fallback） */
  const joined = lines.join('\n').trim()
  if (meta.test(joined)) return ''
  return joined
}
