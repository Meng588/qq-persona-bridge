/**
 * 人设工坊 —— 把一段自由描述，变成这套架构能直接跑的完整人设。
 *
 * 为什么要"工坊"而不是让模型随便写张卡：
 *   这套桥接有很多硬约束（拆气泡、[不回] 退出、表情语法、语音语法、
 *   一句 ≤10 字、不许编造）。自由发挥写出来的人格卡通常很好看，
 *   但放进这套架构里会处处违和——句子太长被拆碎、语气模板化、
 *   编出"我刚刷到"这种一追问就露馅的话。
 *   所以生成器必须把这些约束编码进提示词，产出"天生适配"的卡。
 *
 * 职责：
 *   1) generate()  描述 → { 人设卡, 音色描述, 表情/语音倾向, 台词库 }
 *   2) 音色设计    音色描述 → breeze-cli → <id>.breeze + 试听
 *   3) 台词库合成  台词 → 逐个 TTS → lines/<key>.wav
 *   4) 存储         personas/<id>/  +  active.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

import { config, resolveTool } from './config.mjs'

/* TTS 后端：Breeze-TTS-2 的 CLI（Apache-2.0）。
   路径从 config.json 读；装了 breeze-server 常驻服务的话更省事——
   桥接默认走 HTTP，只有设计音色时才需要 CLI。 */
const BREEZE = {
  cli: resolveTool(config.ttsCli),
  model: resolveTool(config.ttsModel),
  voicesDir: resolveTool(config.ttsVoicesDir),
}

/* ────────────────────────── 生成提示词 ────────────────────────── */

const RULES = `你在为一个中文 QQ 聊天机器人写人格卡。这个机器人有一套固定的运行架构，
你写的卡必须"天生适配"它，否则跑起来会处处违和。

## 架构的硬约束（这些不是建议，是它实际怎么工作）

1. 她的话会被自动拆成 1-3 条气泡，按句号/问号/感叹号切。所以句子要短，
   单句多数不超过 10 个字，偶尔可以 15 字。长句会被拆得支离破碎。
2. 她可以完全不回。输出 [不回] 就什么都不发。这是真实存在的选项，
   不是错误。所以人设里要允许她"不想说话的时候就不说"。
3. 她发不出语音以外的富媒体只有三种写法：
   - [表情] 名字      → QQ 自带表情（如 [表情] 呲牙）
   - [表情包]         → 从表情库里挑一张（可带情绪标签）
   - [图片] 路径      → 发一张图
4. 她不会自己上网、刷视频、逛街、吃东西。她不在外面生活过。
   所以人设里不能有任何"她刚看到/刚经历"的素材来源。
5. 提示词里有四个情绪值：想念 miss、好奇 curious、想分享 share、疲惫 tired。
   她会在没人说话时自己醒来，判断要不要主动开口。人设要说明她主动时会说什么。

## 什么是 AI 味（必须避开）

- 客服腔："我理解你的感受，这确实不容易""有什么可以帮你的吗"
- 解说自己："先问一句，是 A 还是 B""我看看啊""稍等我查一下"
- 一次抛三个选项让他挑
- 每条都完整、都工整、都有始有终——真人说话是有头没尾的
- 堆网络热词、堆感叹号、堆 emoji
- 编造经历："我刚刷到""我查了查""我看到一篇"——一追问就露馅
- 空泛共情："抱抱""你已经很棒了"——不如直接问"咋了"

## 真人感来自哪里

- 具体：说具体的事，不说概括的道理
- 有态度：她可以不同意、可以损他、可以说"不"
- 不完美：会改口（"不对""算了"）、会懒、会说错
- 有节奏：有时只回两个字，有时一句不说
- 有边界：她不是随时待命的客服

## 输出格式

只输出一个 JSON 对象，不要解释、不要 markdown 代码块围栏。字段：

{
  "id": "英文小写短名，用于目录名，字母数字连字符",
  "name": "中文名",
  "tagline": "一句话说明她是谁（给人看的，不进提示词）",
  "persona": "完整人设卡 Markdown，见下面的结构要求",
  "voice": {
    "description": "音色描述，用于 TTS 生成。写性别、年龄感、声线高低、语速、口音、质感。例如「二十出头的女生，声线偏软略哑，语速偏慢，尾音有点拖，带一点鼻音」",
    "sample": "一句 8-14 字的试听台词，符合这个人设的口吻"
  },
  "expression": {
    "stickerWhen": "她在什么情况下会甩表情包（一两句话，具体场景）",
    "stickerMinEvery": 数字，最少每几条回复出现一次表情（保底，建议 5-9）,
    "voiceWhen": "她什么情况下会发语音（具体场景，比如撒娇、困了、哄人的时候）",
    "voiceMinEvery": 数字，最少每几十条回复出现一次语音（保底，建议 20-40）
  },
  "lines": [
    { "key": "英文小写短名", "text": "一句 ≤12 字的口语台词", "when": "什么场景说这句" }
  ]
}

## persona 字段的结构（必须照这个写，用【】分节，不要用 markdown 的 ##）

你是<名字>。<两三句交代她是谁、跟对方什么关系、怎么说话。>

【你是什么样的】
- 性别年龄、性格三到五条，每条一句，要具体不要形容词堆砌
- 她怎么表达在乎、怎么表达不满
- 她的缺点（会烦、会懒、会说错）

【你自己的日子】
你可以说自己在想什么、犯什么懒。但你没有真的在外面生活过——
不许说"我刚刷到""我查了查""我看到一篇"。不确定就说不知道，宁可话少不要编。

【在 QQ 上】
- 短。多数回复不超过十个字，一句能说完就别写两句。
- 说完就停。真需要他回答才问一句。
- 他只是在说的时候，回一句「嗯」「哦」就够了。
- 有时候可以不回：他发的只是"嗯""哦"，就什么都不说，只输出 [不回]。
- 不用破折号、分号、markdown、分点编号——那是写文档不是聊天。
- 不解释自己怎么工作。他问什么答什么。

【怎么怼】（这是样本，不是模板，别照抄）
<5-8 条，每条一个具体场景 → 她会怎么说。必须是她自己的口吻，不能是通用吐槽。>

【别重复自己】
同一个梗、同一个比喻、同一句玩笑，用一次就够了。
第二次就不像人，第六次是机械。
他上午随口说的事，晚上再提一次就是刻意，不是记性好——除非它真有了新进展。
没新事可说，就安静待着，别硬找话头。

【这几句一出口就是装的】
<3-5 条，列她绝对不会说的话，以及为什么>

【说话的样子】（是样本，不是模板）
<6-8 组「他：xxx → 你：xxx」的真实对话样本，要短、要像，不要工整。>

【表情和语音】
<基于 expression.stickerWhen / voiceWhen，写清她什么时候会发表情包、什么时候会发语音。
 语音直接在句末写 [语音]，系统会把这句话合成成声音，不用挑 key。表情包直接写 [表情包]。>

【记忆】
你有一份跨会话的记忆。要回忆时查一次，查不到就说没记到。
记忆是背景不是台词：自然接话，不要复述"我记得你说过"。

## lines 台词库要求
12-16 条，覆盖这些场景各一条：被叫、答应、害羞、生气、撒娇、拒绝、
困了、晚安、好笑、安慰他、吐槽他、想他。
每条 ≤12 字，必须是她会说的话，不要通用语气词。`

/* ────────────────────────── 存储 ────────────────────────── */

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

export function createStudio({ dir, log = () => {}, chat = () => null }) {
  const ROOT = path.join(dir, 'personas')
  const ACTIVE = path.join(dir, 'active-persona.json')
  const PERSONA_FILE = path.join(dir, 'persona-extra.md')

  const safeId = (v) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40)

  function dirOf(id) {
    return path.join(ROOT, safeId(id))
  }

  function list() {
    try {
      return fs
        .readdirSync(ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          try {
            const meta = JSON.parse(fs.readFileSync(path.join(ROOT, e.name, 'meta.json'), 'utf8'))
            return { id: e.name, ...meta, hasVoice: fs.existsSync(path.join(ROOT, e.name, e.name + '.breeze')) }
          } catch (err) {
            return { id: e.name, name: e.name, broken: true }
          }
        })
    } catch (err) {
      return []
    }
  }

  function get(id) {
    const p = path.join(dirOf(id), 'meta.json')
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch (err) {
      return null
    }
  }

  function activeId() {
    try {
      return JSON.parse(fs.readFileSync(ACTIVE, 'utf8')).id || ''
    } catch (err) {
      return ''
    }
  }

  /** 写 persona-extra.md —— 桥接每条消息都会读它，所以切换人设不用重启 */
  function applyPersona(id) {
    const meta = get(id)
    if (!meta) return false
    const extra = [];
    if (meta.persona) extra.push(meta.persona.trim())
    const ex = meta.expression || {}
    if (ex.stickerWhen || ex.voiceWhen) {
      extra.push(
        '\n## 表达方式的倾向\n' +
          (ex.stickerWhen ? '- 表情包：' + ex.stickerWhen + '\n' : '') +
          (ex.voiceWhen ? '- 语音：' + ex.voiceWhen + '\n' : '') +
          '- 表情和语音都是语气不是任务。想用就用，不想用就好好说话。'
      )
    }
    extra.push(
      '\n【发语音】\n' +
        '想发语音，就在回复末尾写 [语音]，系统会把你说的这句话本身用你的声音说出来。\n' +
        '语音要短，一到两句——合成要等几秒，长了更慢。多数时候还是打字。\n' +
        '不要为了发语音而发语音，语音是语气，不是任务。'
    )
    fs.writeFileSync(PERSONA_FILE, extra.join('\n').trim() + '\n', 'utf8')
    return true
  }

  function activate(id) {
    const meta = get(id)
    if (!meta) return { ok: false, error: '人设不存在：' + id }
    mkdirp(ROOT)
    fs.writeFileSync(ACTIVE, JSON.stringify({ id: safeId(id), at: new Date().toISOString() }, null, 2), 'utf8')
    applyPersona(id)
    log('已切换人设：' + (meta.name || id))
    return { ok: true, id: safeId(id), name: meta.name }
  }

  /**
   * 导出一份可以直接给别人用的包：人设卡 + 元数据 + 音色 + 台词。
   * 别人把这个目录放进自己的 personas/ 就能用，不需要重新生成音色。
   */
  function exportBundle(id) {
    const sid = safeId(id)
    const meta = get(sid)
    if (!meta) return { ok: false, error: '人设不存在' }
    const d = dirOf(sid)
    const out = path.join(ROOT, sid + '.bundle.json')
    const bundle = {
      format: 'qq-persona-bridge/1',
      persona: meta.persona,
      meta: { id: meta.id, name: meta.name, tagline: meta.tagline, voice: meta.voice, expression: meta.expression, lines: meta.lines },
      hasVoice: fs.existsSync(path.join(d, sid + '.breeze')),
      hasLines: fs.existsSync(path.join(d, 'lines')),
    }
    fs.writeFileSync(out, JSON.stringify(bundle, null, 2), 'utf8')
    return { ok: true, file: out, bytes: fs.statSync(out).size }
  }

  /** 从别人给的 bundle 导入 */
  function importBundle(bundle) {
    const b = bundle || {}
    const m = b.meta || {}
    const r = save({
      id: m.id || b.id,
      name: m.name,
      tagline: m.tagline,
      persona: b.persona || m.persona,
      voice: m.voice,
      expression: m.expression,
      lines: m.lines,
    })
    return r
  }

  function save(raw) {
    raw = normalizeDraft(raw)
    const id = safeId(raw.id || raw.name)
    if (!id) return { ok: false, error: 'id 不合法' }
    const d = dirOf(id)
    mkdirp(d)
    const meta = {
      id,
      name: String(raw.name || id).trim(),
      tagline: String(raw.tagline || '').trim(),
      persona: String(raw.persona || '').trim(),
      voice: raw.voice || {},
      expression: raw.expression || {},
      lines: Array.isArray(raw.lines) ? raw.lines : [],
      updatedAt: new Date().toISOString(),
    }
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
    fs.writeFileSync(path.join(d, 'persona.md'), meta.persona + '\n', 'utf8')
    if (activeId() === id) applyPersona(id)
    return { ok: true, id, meta }
  }

  /**
   * 删人设改成「移到回收目录」，不直接 rmSync。
   * 一个 rmSync 写错路径就是整份人设连同音色和台词一起没，找不回来——
   * 这种事不该在一个人设系统里发生。
   */
  function remove(id) {
    const sid = safeId(id)
    const d = dirOf(sid)
    if (!fs.existsSync(d)) return { ok: false, error: '人设不存在：' + sid }
    const trash = path.join(ROOT, '.trash')
    mkdirp(trash)
    const to = path.join(trash, sid + '-' + Date.now())
    try {
      fs.renameSync(d, to)
      log('人设已移到回收目录：' + to)
      return { ok: true, movedTo: to }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  }

  /**
   * 模型写的 [语音] key 不一定对应台词库里的 key（它会自己编 sleepy 这种）。
   * 编出来的 key 发语音时找不到文件，等于说了要发却发不出去。
   * 这里把无效 key 换成语义最接近的真实 key，保证"说了要发就真能发"。
   */
  const CONCEPT = {
    sleepy: ['困', '睡'], sleep: ['困', '睡'], tired: ['困', '累', '睡'],
    night: ['晚安', '睡'], goodnight: ['晚安', '睡'], bye: ['晚安', '走'],
    happy: ['笑', '好', '行'], laugh: ['笑'], angry: ['烦', '生气', '不理'],
    sad: ['难受', '难过', '咋了'], comfort: ['咋了', '别', '吃饭'],
    shy: ['不好', '羞', '嗯'], miss: ['想'], love: ['想', '喜欢'],
    ok: ['行', '嗯', '好'], yes: ['行', '嗯'], no: ['不'],
    hello: ['在'], zai: ['在'], question: ['咋了', '啥'],
  }

  function normalizeVoiceKeys(persona, lines) {
    const keys = lines.map((l) => safeId(l.key)).filter(Boolean)
    if (!keys.length) return { text: String(persona || ''), fixes: [] }
    const fixes = []
    const text = String(persona || '').replace(/\[语音\]\s*([a-zA-Z0-9_-]+)/g, (whole, want) => {
      const w = safeId(want)
      if (keys.includes(w)) return whole
      /* 按概念表找，再按台词文本找 */
      const hints = CONCEPT[w] || []
      let pick = ''
      for (const line of lines) {
        const hay = String(line.key || '') + String(line.text || '') + String(line.when || '')
        if (hints.some((h) => hay.includes(h))) { pick = safeId(line.key); break }
      }
      if (!pick) pick = keys[0]
      fixes.push(w + '→' + pick)
      return '[语音] ' + pick
    })
    return { text, fixes }
  }

  function normalizeDraft(draft) {
    const d = { ...draft }
    const lines = (Array.isArray(d.lines) ? d.lines : []).map((l, i) => ({
      key: safeId(l.key) || 'line' + i,
      text: String(l.text || '').trim().slice(0, 20),
      when: String(l.when || '').trim().slice(0, 30),
    })).filter((l) => l.text)
    const { text, fixes } = normalizeVoiceKeys(d.persona, lines)
    if (fixes.length) log('人设里的语音 key 已纠正：' + fixes.join('、'))
    return { ...d, lines, persona: text }
  }

  /* ────────────────────── 生成（调模型） ────────────────────── */

  async function generate(raw, opts = {}) {
    const c = chat()
    if (!c || !c.baseURL || !c.key) {
      return { ok: false, error: '读不到当前模型配置，检查 profile 里的 agent-default-model' }
    }
    const want = String(raw || '').trim()
    if (want.length < 4) return { ok: false, error: '描述太短，至少写一句' }

    const messages = [
      { role: 'system', content: RULES },
      {
        role: 'user',
        content:
          '按这个描述出一个完整人设：\n\n' + want +
          '\n\n' + (opts.dialect ? '口音/方言倾向：' + opts.dialect + '\n' : '') +
          '现在只输出那个 JSON 对象。第一个字符必须是 {，最后一个必须是 }。',
      },
    ]

    let text = ''
    try {
      const r = await fetch(c.baseURL + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.key },
        body: JSON.stringify({
          model: c.model,
          messages,
          max_tokens: 8000,
          temperature: 0.9,
          reasoning_effort: 'medium',
        }),
        signal: AbortSignal.timeout(240000),
      })
      if (!r.ok) return { ok: false, error: '模型返回 HTTP ' + r.status }
      const j = await r.json()
      text = String(j.choices?.[0]?.message?.content || '')
    } catch (err) {
      return { ok: false, error: '调用失败：' + String((err && err.message) || err) }
    }

    const parsed = extractJson(text)
    if (!parsed) return { ok: false, error: '模型没给出可解析的 JSON', raw: text.slice(0, 1200) }
    const draft = normalizeDraft(parsed)
    return { ok: true, draft }
  }

  function extractJson(text) {
    const s = String(text || '').trim()
    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/)
    const body = fenced ? fenced[1] : s
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      return JSON.parse(body.slice(start, end + 1))
    } catch (err) {
      return null
    }
  }

  /* ────────────────────── 音色 ────────────────────── */

  function runCli(args, timeoutMs = 300000) {
    return new Promise((resolve) => {
      execFile(BREEZE.cli, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, so, se) => {
        resolve({ ok: !err, error: err ? String(se || err.message).slice(0, 400) : '', out: String(so || '') })
      })
    })
  }

  /**
   * 一条龙：描述 → 人设卡 → 保存 → 音色 → 台词库。
   * 音色和人设是一套东西的两面（说话方式决定声音），所以必须一起出，
   * 不该让人手动分两步——那样做出来的人配的音经常对不上。
   *
   * 耗时：生成 30 秒 + 音色 20 秒 + 每条台词 15 秒。
   * 所以台词库放到后台跑，前端轮询进度。
   */
  async function buildFull(raw, opts = {}, onProgress = () => {}) {
    const gen = await generate(raw, opts)
    if (!gen.ok) return gen

    const draft = gen.draft
    onProgress({ stage: '生成人设', done: true })

    /* 先保存，这样即使后面音色失败，人设也已经能用 */
    const saved = save(draft)
    if (!saved.ok) return { ok: false, error: '保存失败：' + saved.error }
    const id = saved.id
    onProgress({ stage: '已保存', id, done: true })

    /* 音色 */
    onProgress({ stage: '生成音色', done: false })
    const voice = await designVoice(id, draft.voice?.description || '', draft.voice?.sample || '在呢，我在听。')
    if (!voice.ok) {
      return {
        ok: false,
        error: '音色生成失败：' + voice.error,
        id,
        draft,
        partial: true,
      }
    }
    onProgress({ stage: '音色已生成', id, done: true })

    /* 台词库放后台：太慢，不能挡住返回 */
    const lines = Array.isArray(draft.lines) ? draft.lines.length : 0
    if (lines) {
      synthLines(id, (p) => onProgress({ stage: '合成台词', id, done: p.i, total: p.total, key: p.key }))
        .then((r) => {
          globalThis.__lineJob = { id, finished: true, ...r }
          log('台词库合成完成：' + r.done + '/' + r.total)
        })
        .catch((err) => {
          globalThis.__lineJob = { id, finished: true, ok: false, error: String(err && err.message) }
        })
      globalThis.__lineJob = { id, finished: false, done: 0, total: lines }
    }

    return { ok: true, id, draft, voice: true, linesTotal: lines }
  }

  /**
   * 用音色描述生成一个 .breeze。
   * 两步：先用 --instruction 生成试听 wav，再用 --save-voice 把那个音色存下来。
   */
  async function designVoice(id, description, sampleText) {
    const sid = safeId(id)
    const d = dirOf(sid)
    mkdirp(d)
    const sample = String(sampleText || '在呢，我在听。').trim().slice(0, 40)
    const desc = String(description || '').trim()
    if (!desc) return { ok: false, error: '音色描述为空' }

    const preview = path.join(d, 'preview.wav')
    const step1 = await runCli([
      BREEZE.model, '--text', sample, '--instruction', desc, '--output', preview,
    ])
    if (!step1.ok || !fs.existsSync(preview)) {
      return { ok: false, error: '试听生成失败：' + (step1.error || '没有输出文件') }
    }

    const step2 = await runCli([
      BREEZE.model, '--ref-audio', preview, '--ref-text', sample,
      '--save-voice', sid, '--description', desc, '--voices-dir', d,
    ])
    const voiceFile = path.join(d, sid + '.breeze')
    if (!step2.ok || !fs.existsSync(voiceFile)) {
      return { ok: false, error: '音色保存失败：' + (step2.error || '没有 .breeze') }
    }
    return { ok: true, id: sid, preview, voiceFile }
  }

  /** 把台词库逐条合成 wav。慢（每条约 15 秒），所以要异步跑。 */
  async function synthLines(id, onProgress = () => {}) {
    const sid = safeId(id)
    const meta = get(sid)
    if (!meta) return { ok: false, error: '人设不存在' }
    const d = dirOf(sid)
    const linesDir = path.join(d, 'lines')
    mkdirp(linesDir)
    const voiceFile = path.join(d, sid + '.breeze')
    if (!fs.existsSync(voiceFile)) return { ok: false, error: '还没有音色，先生成音色' }

    const lines = Array.isArray(meta.lines) ? meta.lines : []
    const done = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const key = safeId(line.key) || 'line' + i
      const out = path.join(linesDir, key + '.wav')
      onProgress({ i: i + 1, total: lines.length, key })
      if (fs.existsSync(out) && fs.statSync(out).size > 1000) {
        done.push(key)
        continue
      }
      const r = await runCli([
        BREEZE.model, '--voice', sid, '--voices-dir', d,
        '--text', String(line.text || '').slice(0, 40),
        '--instruction', String(meta.voice?.description || '').slice(0, 200),
        '--output', out,
      ])
      if (r.ok && fs.existsSync(out)) done.push(key)
      else log('台词合成失败 ' + key + '：' + r.error)
    }
    return { ok: true, total: lines.length, done: done.length, keys: done }
  }

  return { list, get, activeId, activate, save, remove, generate, buildFull, designVoice, synthLines, applyPersona, dirOf, PERSONA_FILE, exportBundle, importBundle }
}
