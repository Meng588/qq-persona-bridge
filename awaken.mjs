/**
 * 自主唤醒：不按固定时刻，而是按"状态"决定什么时候醒来、要不要开口。
 *
 * 思路来自 github.com/Pan1127/companion-awakening（念起），做了简化：
 *   · 状态由时间和真实事件推动，不用随机数
 *   · 状态越强越早醒，平静时自动拉长休眠
 *   · 两道门槛：想（0.35）和说（0.72）分开——可以想了不说
 *   · 开口前再确认他有没有刚回来，避免撞车
 *   · 说了的话写回对话时间线，下次聊天她记得自己发过
 *
 * 成本：每次醒来是一次轻量调用（不是 headless 回合），几百 token。
 */
import fs from 'node:fs'
import path from 'node:path'

const HOUR = 3600 * 1000

/** 状态越强，下一次醒来越早；最低 45 分钟，最高 6 小时。再叠时段活跃度 */
function nextWakeDelay(drives, atMs) {
  const strongest = Math.max(drives.miss, drives.curious, drives.share, 0)
  let minutes = 45 + (1 - Math.min(strongest, 1)) * 315

  const hour = new Date(atMs || Date.now()).getHours()
  let factor = 1
  if (hour >= 19 && hour <= 23) factor = 1.5      /* 晚间最活跃 */
  else if (hour >= 0 && hour <= 7) factor = 0.28  /* 深夜几乎沉默 */
  else if (hour >= 8 && hour <= 10) factor = 0.8  /* 早晨还没醒透 */
  minutes = minutes / factor

  return Math.round(Math.min(minutes, 360)) * 60 * 1000
}

export function createAwakening({ dir, log, chat, recent, send, onRemember, memories, threshold = 0.72 }) {
  const stateFile = path.join(dir, 'awake-state.json')

  function loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''))
      if (raw && raw.drives) {
        /* 老的状态文件没有这几个字段，补默认值 */
        if (typeof raw.unanswered !== 'number') raw.unanswered = 0
        if (typeof raw.lastProactiveAt !== 'number') raw.lastProactiveAt = 0
        return raw
      }
    } catch (err) { /* 第一次跑没有，正常 */ }
    return {
      drives: { miss: 0.15, curious: 0.2, share: 0.1, tired: 0.2 },
      lastUserAt: Date.now(),
      lastSpokeAt: 0,
      unanswered: 0,
      lastProactiveAt: 0,
      nextWakeAt: Date.now() + 45 * 60 * 1000,
      thoughts: [],
    }
  }

  function saveState(state) {
    try {
      state.thoughts = (state.thoughts || []).slice(-30)
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
    } catch (err) {
      log('存唤醒状态失败：' + String((err && err.message) || err))
    }
  }

  /** 状态随时间和事件变化：不联系就越来越想，聊过之后就回落 */
  function evolve(state, now) {
    const hoursSinceUser = (now - (state.lastUserAt || now)) / HOUR
    const d = state.drives

    d.miss = Math.min(1, 0.1 + hoursSinceUser * 0.09)
    d.curious = Math.min(1, (d.curious || 0.2) + 0.03)
    d.share = Math.min(1, (d.share || 0.1) + 0.02)
    /* 深夜和清晨更疲惫，说话欲望低 */
    const hour = new Date(now).getHours()
    d.tired = hour >= 23 || hour < 8 ? 0.9 : hour < 10 ? 0.6 : 0.2

    /* 疲惫会压住说话的冲动 */
    d.share = Math.max(0, d.share - d.tired * 0.35)
    return state
  }

  function describe(d) {
    return '思念 ' + d.miss.toFixed(2) + '，好奇 ' + d.curious.toFixed(2) +
      '，想分享 ' + d.share.toFixed(2) + '，疲惫 ' + d.tired.toFixed(2)
  }

  /**
   * 一次调用，一个提示词。"刚聊完该补一句"和"隔久了想找他"不是两种状态，
   * 是同一个问题的两端——都由"距他上次说话多久"决定，所以交给模型自己判断。
   */
  async function askModel(state, messages, memories, strict) {
    const now = new Date()
    const clock = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0')
    const silentMinutes = Math.round((now.getTime() - (state.lastUserAt || now.getTime())) / 60000)
    const warm = silentMinutes < 5

    const situation = warm
      ? '你们刚聊完（' + silentMinutes + ' 分钟前）。你要是还有没说完的，可以补一句；' +
        '没有就安静待着——不要为了接话而接话，也别重复刚才说过的意思。'
      : '距他上次说话已经 ' + (silentMinutes < 90 ? silentMinutes + ' 分钟' : (silentMinutes / 60).toFixed(1) + ' 小时') +
        '。你要是想他了、或者憋着件事想说，可以主动开口；不想说就不说，正常人也不会没事找事。'

    const system = [
      '你是这个 QQ 号本人，按你的人设说话。现在没人跟你说话，你自己醒着。',
      '当前的处境：' + situation,
      '要说的话一到两句，别问候式开场，别问"在吗"。',
      '别拿几小时前的小事当话头。上午他随口说的事，晚上再提一次就是刻意，不是记性好。',
      '同一个话题你连着提过，就别再提了。真没新事可说，就安静待着。',
      '另外：这一刻如果有一件值得长期记住的事（关于他、或关于你自己的感受），用一句话写进 remember；没有就给空。',
      '别写废话，别写"我今天想起他"这种。要具体。',
      '只输出 JSON，不要解释：{"urge":0到1,"thought":"你心里想的（可以不说出口）","message":"要说的话，不说就给空字符串","remember":"值得记住的一句话或空字符串"}',
      strict ? '上一次你没按格式回。这次只允许一个 JSON 对象，第一个字符必须是 {，最后一个必须是 }。不要前言、不要解释、不要代码块。' : '',
    ].filter(Boolean).join('\n')

    /* 未回复次数：让她的语气自己收着，而不是靠代码硬拦（4 次是硬拦） */
    const unanswered = Number(state.unanswered) || 0
    const mood = unanswered <= 0
      ? ''
      : unanswered === 1
        ? '你主动找过他一次，他还没回。语气里可以带一点点等待，但别问"你怎么不理我"，也别解释。'
        : unanswered <= 3
          ? '你已经主动找过他 ' + unanswered + ' 次，他都没回。更短、更收着，宁可只说半句；没有真想说的就别硬找。'
          : '你已经主动找过他 ' + unanswered + ' 次，都没回。（这条代码会拦住，你不必开口）'

    const user = [
      '现在 ' + clock + '，距他上次说话 ' + silentMinutes + ' 分钟。',
      mood ? '处境：' + mood : '',
      '你现在的状态：' + describe(state.drives),
      memories ? '你记得的事：\n' + memories.slice(0, 800) : '',
      messages ? '最近你们聊的：\n' + messages.slice(-1200) : '（你们还没聊过）',
    ].filter(Boolean).join('\n')

    const response = await fetch(chat.baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + chat.key },
      body: JSON.stringify({
        model: chat.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: 400,
        temperature: 1.0,
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const data = await response.json()
    const choice = data?.choices?.[0]?.message || {}
    const text = String(choice.content || '')
    /* reasoning 通道的长度——区分"回了空正文"还是"回了口语" */
    const reasoningLen = String(choice.reasoning_content || choice.reasoning || '').length
    const finish = data?.choices?.[0]?.finish_reason || '?'

    const json = text.match(/\{[\s\S]*\}/)
    if (!json) {
      /* 把现场留下来：下次再出事，一眼能看出它到底回了什么 */
      log('唤醒原始返回（finish=' + finish + '，正文 ' + text.length +
        ' 字，reasoning ' + reasoningLen + ' 字）：' + JSON.stringify(text.slice(0, 200)))
      const err = new Error('返回不是 JSON')
      err.raw = text
      err.reasoningLen = reasoningLen
      throw err
    }
    try {
      return JSON.parse(json[0])
    } catch (parseErr) {
      log('唤醒 JSON 坏了：' + JSON.stringify(json[0].slice(0, 200)))
      const err = new Error('JSON 解析失败：' + String((parseErr && parseErr.message) || parseErr))
      err.raw = text
      throw err
    }
  }

  /**
   * 调一次模型，不按格式回就带着"只说 JSON"再试一次。
   * 两次都不行才放弃——今天两次偶发失败都发生在这条路上。
   */
  async function askModelWithRetry(state, messages, memories) {
    try {
      return await askModel(state, messages, memories)
    } catch (err) {
      const retriable = /返回不是 JSON|JSON 解析失败/.test(String((err && err.message) || ''))
      if (!retriable) throw err
      log('唤醒格式不对，重试一次')
      await new Promise((resolve) => setTimeout(resolve, 800))
      try {
        return await askModel(state, messages, memories, true)
      } catch (err2) {
        log('重试仍然失败：' + String((err2 && err2.message) || err2))
        throw err2
      }
    }
  }

  /* 连续参数：不再是两个模式，而是按"距他上次说话多久"取阈值和间隔 */
  const WARM_MINUTES = 5          /* 5 分钟内算"刚聊完" */
  const WARM_THRESHOLD = 0.45
  const WARM_GAP = 120000         /* 窗口内 2 分钟看一次 */
  const MAX_WARM = 3              /* 一个窗口里最多补 3 次 */
  const MID_MINUTES = 60          /* 5-60 分钟是过渡带 */
  const MID_THRESHOLD = 0.55
  const MID_GAP = 10 * 60 * 1000
  const MAX_UNANSWERED = 4        /* 连着说了这么多次没回，冻结 */

  /* 主动开口的四个可调参数。
     原来的问题是三层闸门叠加：cold 门槛 0.72 + 三小时硬冷却 + urge 从不叠加情绪，
     实测她的 urge 分布是 0.20~0.45，最高 0.62——0.72 那道门槛她从来没摸到过，
     所以一整天只开了一次口。 */
  const COLD_THRESHOLD = 0.48     /* 原来 0.72。实测 urge 分布 0.20~0.45、最高 0.62，0.72 她一次都摸不到 */
  const RECENT_PENALTY = 0.20     /* 三小时内说过 → 门槛加这么多，而不是直接禁止 */
  const COOLDOWN_ANSWERED = 1 * HOUR   /* 他回过话，冷却只要 1 小时 */
  const COOLDOWN_IGNORED = 3 * HOUR    /* 他还没回，保留 3 小时，别显得黏人 */
  const DRIVE_WEIGHT = 0.30       /* 情绪值对"想不想说"的加成权重 */

  /** 按时间取这一次醒来的门槛和下次间隔 */
  function scheduleFor(state, now) {
    const silentMin = (now - (state.lastUserAt || now)) / 60000
    const unanswered = Number(state.unanswered) || 0
    let phase, liveThreshold, gap

    if (silentMin < WARM_MINUTES) {
      phase = 'warm'
      liveThreshold = WARM_THRESHOLD
      gap = WARM_GAP
    } else if (silentMin < MID_MINUTES) {
      phase = 'mid'
      liveThreshold = MID_THRESHOLD
      gap = MID_GAP
    } else {
      phase = 'cold'
      liveThreshold = Math.min(COLD_THRESHOLD + 0.06 * unanswered, 0.98)
      gap = nextWakeDelay(state.drives, now)
    }
    return { phase, liveThreshold, gap, silentMin, unanswered }
  }

  async function tick() {
    if (!chat || !chat.baseURL || !chat.key) {
      log('自主唤醒：当前模型不可用，跳过')
      return
    }
    const now = Date.now()
    const state = evolve(loadState(), now)
    const plan = scheduleFor(state, now)

    /* 冻结：连着说了 MAX_UNANSWERED 次他都没回，就不再调模型了。
       等他先开口（noteUserMessage 会把 unanswered 归零）。 */
    if (plan.unanswered >= MAX_UNANSWERED) {
      state.nextWakeAt = now + nextWakeDelay(state.drives, now)
      state.history = (state.history || []).concat([{
        at: new Date(now).toISOString(),
        drives: { ...state.drives },
        phase: plan.phase,
        urge: 0,
        thought: '',
        message: '',
        spoke: false,
        reason: '未回复 ' + plan.unanswered + ' 次，冻结中（等他说第一句）',
      }]).slice(-200)
      saveState(state)
      log('冻结中：已经说了 ' + plan.unanswered + ' 次他都没回，这次不打扰')
      return
    }

    let verdict
    try {
      /* 主动开口也要看到记忆，否则她只能拿最近几轮里的事当话头，
         那正是"老是翻旧账"的来源之一。 */
      let memBlock = ''
      try {
        memBlock = typeof memories === 'function' ? await memories() : String(memories || '')
      } catch (err) {
        memBlock = ''
      }
      verdict = await askModelWithRetry(state, recent(), memBlock)
    } catch (err) {
      log('自主唤醒：调用失败（' + String((err && err.message) || err) + '）')
      state.nextWakeAt = now + 60 * 60 * 1000
      saveState(state)
      return
    }

    const urge = Number(verdict.urge) || 0
    const message = String(verdict.message || '').trim()
    const thought = String(verdict.thought || '').trim()
    const remember = String(verdict.remember || '').trim()

    if (remember && typeof onRemember === 'function') {
      try { onRemember(remember) } catch (err) { /* 忽略 */ }
    }

    state.thoughts.push({ at: new Date(now).toISOString(), urge, thought, spoke: false })

    let spoke = false
    let reason = ''

    /* 冷却：跨阶段共用的两条，但冷阶段才看"三小时内说过"——
       补一句短话不该被罚三小时不能找人 */
    const warm = plan.phase === 'warm'
    const warmSpoke = Number(state.warmSpoke) || 0
    /* 冷却：他说过话就短，没说就长。而且不是禁止——只是把门槛抬高，
       这样她情绪真的够强时仍然能开口，而不是被时间闸一刀切死。 */
    const cooldown = plan.unanswered > 0 ? COOLDOWN_IGNORED : COOLDOWN_ANSWERED
    const sinceSpoke = now - (state.lastProactiveAt || 0)
    const isRecent = !warm && sinceSpoke < cooldown

    /* 情绪值真正参与判断：原来 drives 只影响"多久醒一次"，
       对"醒来说不说"毫无作用——好奇顶到 1.00 也不帮她开口，这是脱节的。
       现在按权重混进 urge，让情绪积累真的推得动她。 */
    const driveStrength = Math.max(
      Number(state.drives.miss) || 0,
      Number(state.drives.share) || 0,
      (Number(state.drives.curious) || 0) * 0.6
    )
    /* 情绪是加成，不是替代。原来写 urge*0.65 等于把模型判断稀释了，反而更难开口。 */
    const effectiveUrge = Math.min(1, urge + driveStrength * DRIVE_WEIGHT)
    const liveThreshold = Math.min(plan.liveThreshold + (isRecent ? RECENT_PENALTY : 0), 0.98)

    if (warm && warmSpoke >= MAX_WARM) {
      reason = '这个窗口已经补了 ' + warmSpoke + ' 次'
    } else if (effectiveUrge >= liveThreshold && message) {
      if (send(message)) {
        spoke = true
        state.thoughts[state.thoughts.length - 1].spoke = true
        state.lastSpokeAt = now
        if (warm) {
          /* 补话不算"主动找他"，也不计未回复——它只是把话说完了 */
          state.warmSpoke = warmSpoke + 1
        } else {
          state.lastProactiveAt = now
          state.unanswered = plan.unanswered + 1
          state.drives.share = Math.max(0, state.drives.share - 0.6)
          state.drives.miss = Math.max(0, state.drives.miss - 0.5)
        }
        log((warm ? '补话' : '主动开口') + '（urge ' + urge.toFixed(2) + ' 情绪加成 ' +
          driveStrength.toFixed(2) + ' → ' + effectiveUrge.toFixed(2) + '，门槛 ' +
          liveThreshold.toFixed(2) + '，未回 ' + state.unanswered + '）：' + message.slice(0, 40))
      } else {
        reason = '连接断了'
      }
    } else {
      reason = '冲动不够（' + effectiveUrge.toFixed(2) + ' < ' + liveThreshold.toFixed(2) + '｜模型 ' + urge.toFixed(2) + ' + 情绪 ' + driveStrength.toFixed(2) + '×' + DRIVE_WEIGHT + (isRecent ? '，刚说过+罚' : '') + '）'
    }

    /* 不管因为什么没开口，都留一行——否则"她怎么没醒"完全无声 */
    if (!spoke && reason) {
      log('醒来但没开口：' + reason + (thought ? '｜想着：' + thought.slice(0, 30) : ''))
    }

    /* 下次什么时候醒：窗口里补完话就等下一轮；否则按当前阶段算 */
    if (warm && spoke && (Number(state.warmSpoke) || 0) < MAX_WARM) {
      state.nextWakeAt = now + WARM_GAP
    } else {
      state.nextWakeAt = now + plan.gap
    }

    /* 流水：每个时间段一条，页面按这个画时间线 */
    state.history = (state.history || []).concat([{
      at: new Date(now).toISOString(),
      drives: { ...state.drives },
      phase: plan.phase,
      urge,
      thought,
      message,
      spoke,
      reason,
    }]).slice(-200)

    saveState(state)
  }

  /** 当前处在哪个阶段（只用于显示） */
  function phaseOf(state) {
    const min = (Date.now() - (state.lastUserAt || Date.now())) / 60000
    if (min < WARM_MINUTES) return 'warm'
    if (min < MID_MINUTES) return 'mid'
    return 'cold'
  }

  function loop() {
    const state = loadState()
    if (Date.now() >= (state.nextWakeAt || 0)) tick().catch(() => {})
  }

  function status() {
    const state = loadState()
    /* 存的是 UTC，显示要换成本机时区，否则和页面其他地方差 8 小时 */
    const local = (iso) => {
      try {
        const d = new Date(iso)
        return [d.getHours(), d.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':')
      } catch (err) {
        return String(iso || '').slice(11, 16)
      }
    }
    return {
      drives: state.drives,
      /* nextWakeAt 是 0（刚被强制唤醒、或状态被清空）时不能显示成 1970 年 */
      nextWakeAt: (Number(state.nextWakeAt) || 0) > 0
        ? new Date(state.nextWakeAt).toLocaleString('zh-CN')
        : '即将',
      lastSpokeAt: (Number(state.lastSpokeAt) || 0) > 0 ? new Date(state.lastSpokeAt).toLocaleString('zh-CN') : '还没主动说过',
      recentThoughts: (state.thoughts || []).slice(-5),
      history: (state.history || []).slice(-30).map((entry) => ({ ...entry, atLocal: local(entry.at) })),
      nextWakeAtMs: state.nextWakeAt || 0,
      phase: phaseOf(state),
      silentMinutes: Math.round((Date.now() - (state.lastUserAt || Date.now())) / 60000),
      unanswered: Number(state.unanswered) || 0,
      warmSpoke: Number(state.warmSpoke) || 0,
      nowLocal: new Date().toLocaleString('zh-CN'),
    }
  }

  function noteUserMessage() {
    const state = loadState()
    /* 他只要开口，未回复计数就归零、冻结解除，新的接话窗口也从 0 开始 */
    state.unanswered = 0
    state.warmSpoke = 0
    state.lastUserAt = Date.now()
    state.drives.miss = 0.1
    /* 好奇也要回落：原来只涨不降，冲到 1.00 之后就永远没有区分度了，
       等于这个情绪值报废。他真开口聊过，好奇就消掉大半。 */
    const c = Number(state.drives.curious) || 0
    state.drives.curious = Math.max(0.2, 0.2 + c * 0.25)
    saveState(state)
  }

  /**
   * 对话刚结束：打开"接话窗口"，过一会儿她想一次还有没有想补的。
   * 每次聊完都重开窗口，窗口关了才转入主动模式。
   */
  function scheduleSoon(delayMs) {
    const state = loadState()
    /* 不设模式了：只要记住"他刚说完话"，tick 自己会按时间取参数 */
    state.lastUserAt = state.lastUserAt || Date.now()
    state.nextWakeAt = Date.now() + (delayMs || 75000)
    saveState(state)
  }

  /**
   * 想了但没说出口的念头，最近几小时内的。
   * 聊天时塞进上下文，她才会记得"我下午还在想他"。
   */
  function privateThoughts(limit = 2, hours = 6) {
    const state = loadState()
    const cutoff = Date.now() - hours * HOUR
    return (state.history || [])
      .filter((entry) => {
        if (entry.spoke) return false
        const at = new Date(entry.at).getTime()
        return Number.isFinite(at) && at >= cutoff && String(entry.thought || '').trim()
      })
      .slice(-limit)
      .map((entry) => {
        const d = new Date(entry.at)
        const clock = [d.getHours(), d.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':')
        return { clock, thought: String(entry.thought).trim() }
      })
  }

  return { tick, loop, status, noteUserMessage, privateThoughts, scheduleSoon }
}
