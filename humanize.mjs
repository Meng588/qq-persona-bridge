/**
 * 把一段话拆成几条消息发出去 —— 真人聊天不会一次甩一长段。
 * 规则：先按换行分段，长段再按句子归并到 40 字左右，最多 maxBubbles 条。
 * 每条去掉句尾的句号（聊天气泡里不带句号更自然）。
 */
export function toBubbles(text, maxBubbles = 3) {
  const raw = String(text || '').trim()
  if (!raw) return []

  const parts = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean)
  const out = []
  for (const part of parts) {
    if (part.length <= 40) { out.push(part); continue }
    const sentences = part.match(/[^。！!？?\n]+[。！!？?]?/g) || [part]
    let buf = ''
    for (const sentence of sentences) {
      if (!buf) buf = sentence
      else if ((buf + sentence).length <= 40) buf += sentence
      else { out.push(buf); buf = sentence }
    }
    if (buf) out.push(buf)
  }

  while (out.length > maxBubbles) {
    const tail = out.pop()
    out[out.length - 1] += tail
  }

  return out
    .map((bubble) => bubble.replace(/\s*\n\s*/g, ' ').replace(/。\s*$/, '').trim())
    .filter((bubble) => bubble.length > 0)
}

/**
 * 去掉"选择题"式的尾巴。
 *
 * 模型特别爱这么问：先给判断，再抛一个"是 A 还是 B"让他挑。
 * 连着几条都同一个骨架，一眼机器。这里只动句尾，中间不碰。
 *
 *   1. …了，是躺下睡不着还是半夜醒。   → …了
 *   2. …？钱、人，还是每天干的事本身？  → …（那段列举整句删掉）
 *   3. 躺下睡不着，还是睡着了老醒？     → 躺下睡不着？
 */
export function detemplate(text) {
  const before = String(text || '').trim()
  const wasQuestion = /[？?]$/.test(before)
  let out = before
  let changed = false

  /* 1. 句尾"是…还是…"，前面有标点就直接砍 */
  const step1 = out.replace(/[，,。；;]\s*是[^。！!？?\n]{1,40}还是[^。！!？?\n]{1,40}[。.！!？?]?\s*$/, '')
  if (step1 !== out) { out = step1; changed = true }

  /* 2. 句尾那个小句里同时有「、」和「还是」——整句删掉 */
  const listed = out.match(/[^。！!？?\n]*、[^。！!？?\n]*还是[^。！!？?\n]*[？?。]?\s*$/)
  if (listed) {
    const keep = out.slice(0, out.length - listed[0].length)
    if (keep.trim().length >= 4) { out = keep; changed = true }
  }

  /* 3. 只剩一句"A，还是B？"——**故意不砍**。
        新性格会真的这么问（"你这是想听我说该，还是想听我不该？"），砍了只剩半截更假。 */

  /* 什么都没改就原样返回，别动正常句子 */
  if (!changed) return before

  out = out.replace(/[，,。；;、\s]+$/, '').trim()
  if (out.length < 2) return before
  if (wasQuestion && !/[？?。！!]$/.test(out)) out += '？'
  return out
}
