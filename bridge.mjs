/**
 * QQ 私信桥（异步版）
 * ---------------------------------------------------------------------------
 *   QQ ←→ NapCat(ws://127.0.0.1:36199) ←→ 本脚本 ←→ dsh headless
 *
 * 和上一版的区别：
 *   1) 收到消息**立刻回一句"在干了"**，不等模型
 *   2) 每条消息各开一个后台回合，互不阻塞——你可以连着发，不用等上一条跑完
 *   3) 跑完再发一条"✔ 完成"
 *   4) 多开一个本地端口 3002，桌面端的我可以随时往 QQ 推消息：
 *        POST http://127.0.0.1:3002/send  {"text":"..."}
 *
 * 只处理私信；群聊一律忽略；白名单在 allow.json。
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { toBubbles, detemplate } from './humanize.mjs'
import { stripLeakedThinking } from './sanitize.mjs'
import { createAwakening } from './awaken.mjs'
import { createStudio } from './studio.mjs'

import { config, resolveTool } from './config.mjs'

const HOME = os.homedir()
const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const NAPCAT_WS = env('QQPB_WS') || 'ws://127.0.0.1:36199'
const SEND_PORT = Number(env('QQPB_SEND_PORT')) || 3002
const DSH_EXE = resolveTool(config.dshExe, 'DeepSeek Harness.exe')
const DSH_CLI = resolveTool(config.dshCli)
const HISTORY_TURNS = Number(env('QQPB_HISTORY')) || 5
const TIMEOUT_MS = Number(env('QQPB_TIMEOUT_MS')) || 240000
const ACK_MS = Number(env('QQPB_ACK_MS')) || 1200
const PROGRESS_MS = Number(env('QQPB_PROGRESS_MS')) || 90000
const ACK_ON = String(env('QQPB_ACK') || 'off').toLowerCase() === 'on'
const ACK_BASE = env('QQPB_ACK_BASE') || ''
const ACK_MODEL = env('QQPB_ACK_MODEL') || ''

/**
 * 应答和进度用哪个模型：跟着 profile 里当前的默认模型走，别写死。
 * 写死的后果是——换了供应商之后，这两个小调用还在打旧地址，静默失败，
 * 用户那边看到的就是"发消息没人应"。
 */
function currentChat() {
  try {
    const profile = fs.readFileSync(PROFILE_FILE, 'utf8')
    const match = profile.match(
      /- id: agent-default-model\r?\n  config:\r?\n    provider: ([^\r\n]+)\r?\n    model: ([^\r\n]+)/
    )
    if (!match) return null
    const providerId = match[1].trim().replace(/^["']|["']$/g, '')
    const modelId = match[2].trim().replace(/^["']|["']$/g, '')
    const entry = readProviders().find((item) => item.id === providerId)
    if (!entry) return null
    const key = entry.key || loadKey(providerEnvName(entry))
    if (!key) return null
    return {
      baseURL: (ACK_BASE || entry.baseURL || '').replace(/\/$/, ''),
      model: ACK_MODEL || modelId,
      key,
    }
  } catch (err) {
    return null
  }
}

/**
 * 让模型即兴应一句，而不是从模板里挑。
 * 独立于主回合：一个几十 token 的小请求，1~2 秒回来；失败就干脆不发。
 */
async function quickAck(userText) {
  const chat = currentChat()
  if (!chat || !chat.baseURL) return ''
  const key = chat.key
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const response = await fetch(chat.baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: chat.model,
        messages: [
          {
            role: 'system',
            content:
              '你在 QQ 上和人聊天。对方刚发来一条消息，你还在弄，需要先应一声。' +
              '只回一句极短的应答（不超过 10 个字），像随口应的那种。' +
              '不要客套、不要解释、不要"收到/好的"这种模板感的词，每次都不一样。' +
              '只输出那句话本身。',
          },
          { role: 'user', content: userText },
        ],
        max_tokens: 512,
        reasoning_effort: 'low',
        temperature: 1.25,
      }),
      signal: controller.signal,
    })
    if (!response.ok) return ''
    const data = await response.json()
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '')
      : ''
    return content.trim().replace(/^["「『]|["」』]$/g, '').slice(0, 40)
  } catch (err) {
    return ''
  } finally {
    clearTimeout(timer)
  }
}
const MAX_PARALLEL = Number(env('QQPB_MAX_PARALLEL')) || 1
/* 同一个人连发多条时，先攒一下再一起处理——真人不会把"你能做到吗"当独立问题 */
const MERGE_MS = Number(env('QQPB_MERGE_MS')) || 3500

const LOG = path.join(DIR, 'bridge.log')
/**
 * 写日志。topic 给了就额外写一份分组件日志（awake.log / jobs.log / model.log），
 * 主日志 bridge.log 仍然全收——排障时按组件翻更省事。
 */
let lastEventAt = 0
let lastPrivateAt = 0

function log(line, topic) {
  /* 用本机时区，别用 UTC——不然页面上的时间会差 8 小时 */
  const now = new Date()
  const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
  const text = '[' + stamp + '] ' + line
  console.log(text)
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 256 * 1024) fs.writeFileSync(LOG, '')
    fs.appendFileSync(LOG, text + '\n', 'utf8')
    if (topic) {
      const file = path.join(DIR, topic + '.log')
      if (fs.existsSync(file) && fs.statSync(file).size > 128 * 1024) fs.writeFileSync(file, '')
      fs.appendFileSync(file, text + '\n', 'utf8')
    }
  } catch (err) { /* 日志失败不影响主流程 */ }
}

/* ---------- 电脑能力开关 ---------- */
const PERM_FILE = path.join(DIR, 'permissions.json')
const PROFILE_PATH = resolveTool(config.dshProfile) || path.join(HOME, '.dsh', 'profiles', 'headless', 'cordis.patch.yml')
const TOOL_MARK_START = '# >>> qqpb:tools:start'
const TOOL_MARK_END = '# <<< qqpb:tools:end'

function computerAllowed() {
  try {
    const data = JSON.parse(fs.readFileSync(PERM_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return data.computer !== false
  } catch (err) {
    return true
  }
}

/**
 * 按开关改写 profile 里的工具段。
 * 关掉时禁用 shell 插件：她还能看图、说话，但跑不了命令。
 * headless 每轮重读 profile，所以改完立刻生效，不用重启桥。
 */
function applyComputerPermission(allowed) {
  try {
    const text = fs.readFileSync(PROFILE_PATH, 'utf8').replace(/^\uFEFF/, '')
    const start = text.indexOf(TOOL_MARK_START)
    const end = text.indexOf(TOOL_MARK_END)
    if (start < 0 || end < 0) return false

    const head = text.slice(0, start)
    const tail = text.slice(end + TOOL_MARK_END.length).replace(/^\n+/, '\n')
    const body = allowed
      ? TOOL_MARK_START + '\n# computer capability: ON\n' + TOOL_MARK_END
      : TOOL_MARK_START + '\n# computer capability: OFF (shell plugins disabled)\n' +
        '- id: tool-pwsh\n  disabled: true\n- id: tool-bash\n  disabled: true\n' + TOOL_MARK_END

    const next = head + body + '\n' + tail
    if (next !== text) fs.writeFileSync(PROFILE_PATH, next, 'utf8')
    return true
  } catch (err) {
    log('改工具开关失败：' + String((err && err.message) || err))
    return false
  }
}

/* ---------- 她自己定的提醒 ---------- */
const REMINDERS_FILE = path.join(DIR, 'reminders.json')

function loadReminders() {
  try {
    const list = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return Array.isArray(list) ? list : []
  } catch (err) {
    return []
  }
}

function saveReminders(list) {
  try {
    fs.writeFileSync(REMINDERS_FILE, JSON.stringify(list, null, 2), 'utf8')
  } catch (err) { /* 忽略 */ }
}

/**
 * 她说的时间 → 毫秒时间戳。支持三种写法：
 *   +30m / +2h / +1d      相对
 *   明天9点 / 今天21:30 / 后天 8:00   绝对（没写日期就是今天）
 * 认不出来返回 0，由她去问清楚。
 */
function parseReminderTime(spec, nowMs) {
  const s = String(spec || '').trim()
  if (!s) return 0

  const rel = s.match(/^\+(\d+)\s*(m|min|分钟|h|小时|d|天)$/i)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2].toLowerCase()
    if (unit.startsWith('m')) return nowMs + n * 60000
    if (unit.startsWith('h') || unit === '小时') return nowMs + n * 3600000
    return nowMs + n * 86400000
  }

  const abs = s.match(/^(今天|明天|后天)?\s*(\d{1,2})\s*[:：点]\s*(\d{1,2})?/)
  if (abs) {
    const dayWord = abs[1] || '今天'
    const hour = Number(abs[2])
    const minute = Number(abs[3] || 0)
    if (hour > 23 || minute > 59) return 0
    const when = new Date(nowMs)
    const offset = dayWord === '明天' ? 1 : dayWord === '后天' ? 2 : 0
    when.setDate(when.getDate() + offset)
    when.setHours(hour, minute, 0, 0)
    let ms = when.getTime()
    if (!abs[1] && ms < nowMs) ms += 86400000   /* 只说时间又过了点，就当下一个今天 */
    return ms
  }
  return 0
}

/** 从她的回复里抠出 [提醒] 行，存下来 */
function takeReminders(replyText) {
  const list = []
  const re = /^[ \t]*\[提醒\][ \t]*(.+)$/gm
  let m
  const now = Date.now()
  while ((m = re.exec(String(replyText || ''))) !== null) {
    const body = m[1].trim()
    /* 形如：明天9点 交表   /   +2h 喝水
       从最短的前缀开始试，否则"明天9点 交表格"会被整段当成时间、备注变空 */
    const parts = body.split(/\s+/)
    let at = 0
    let note = ''
    for (let i = 1; i <= parts.length; i++) {
      const head = parts.slice(0, i).join(' ')
      const parsed = parseReminderTime(head, now)
      if (parsed) {
        at = parsed
        note = parts.slice(i).join(' ').trim()
        break
      }
    }
    if (!at || !note) {
      log('提醒没看懂：' + body.slice(0, 40))
      continue
    }
    list.push({ id: 'r-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 6), at, note })
  }
  if (list.length) {
    const all = loadReminders().concat(list)
    saveReminders(all)
    for (const item of list) {
      const when = new Date(item.at).toLocaleString('zh-CN')
      log('记下提醒：' + when + ' — ' + item.note.slice(0, 30))
    }
  }
  return list.length
}

/** 到点就把提醒发出去：让她自己那句话说出来，不是系统通知 */
async function fireDueReminders() {
  const list = loadReminders()
  if (!list.length) return
  const now = Date.now()
  const due = list.filter((item) => Number(item.at) <= now)
  if (!due.length) return
  saveReminders(list.filter((item) => Number(item.at) > now))

  for (const item of due) {
    const late = Math.round((now - Number(item.at)) / 60000)
    if (late > 180) { log('提醒过期太久，跳过：' + item.note.slice(0, 30)); continue }
    try {
      const result = await askModel(
        '（现在是你之前自己定的提醒时间到点了。要提醒他的事：' + item.note +
        '）\n自然地说一句提醒他，一两句，不要写"提醒"两个字当标题，别解释怎么来的。'
      )
      const userId = loadAllow()[0]
      if (result.ok && result.text && userId) {
        const said = result.text.replace(/^[ \t]*\[提醒\][ \t]*.*$/gm, '').trim()
        await sendHuman(userId, detemplate(said || result.text))
        log('提醒已发：' + (said || result.text).slice(0, 30))
        appendTranscript('（到点提醒：' + item.note + '）', displayAssistantText(result.text), result.thinking)
      }
    } catch (err) {
      log('发提醒失败：' + String((err && err.message) || err))
    }
  }
}

function loadKey(name) {
  if (process.env[name]) return process.env[name]
  try {
    const yaml = fs.readFileSync(path.join(HOME, '.dsh', '.credentials.yaml'), 'utf8')
    for (const candidate of [name, legacyKeyName(name)]) {
      const m = yaml.match(new RegExp('^\\s*' + candidate + ':\\s*(\\S+)', 'm'))
      if (m) return m[1]
    }
    return ''
  } catch (err) {
    return ''
  }
}

/* ---------- 白名单：只有名单内的账号才会收到回复 ---------- */
/*
 * 结构参考 kuliantnt/qq-maid-bot 的 /ops 白名单，规矩照抄两条：
 *   · 只认稳定 ID，不认昵称
 *   · 空名单 = 谁都不理，不是"全部允许"
 *
 * 另外加一个 owner：她是唯一会主动发消息的对象。
 * 老格式 allow.json（{qq:[...]}）第一次启动时自动迁移。
 */
const WHITELIST_FILE = path.join(DIR, 'whitelist.json')

function normalizeWhitelist(raw) {
  const entries = []
  const seen = new Set()
  for (const item of Array.isArray(raw && raw.entries) ? raw.entries : []) {
    const id = String(item && item.id ? item.id : '').trim()
    if (!/^\d{5,12}$/.test(id)) continue
    const type = item.type === 'group' ? 'group' : 'private'
    const key = type + ':' + id
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      id,
      type,
      name: String(item.name || '').trim().slice(0, 24),
      reply: item.reply !== false,
    })
  }
  const owner = String((raw && raw.owner) || '').trim()
  return { owner: /^\d{5,12}$/.test(owner) ? owner : '', entries }
}

function loadWhitelist() {
  try {
    const raw = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return normalizeWhitelist(raw)
  } catch (err) {
    /* 没有就试老格式 */
  }
  try {
    const old = JSON.parse(fs.readFileSync(path.join(DIR, 'allow.json'), 'utf8'))
    const qqs = Array.isArray(old && old.qq) ? old.qq : []
    const entries = qqs
      .map((id) => String(id).trim())
      .filter((id) => /^\d{5,12}$/.test(id))
      .map((id) => ({ id, type: 'private', name: '', reply: true }))
    const migrated = { owner: entries[0] ? entries[0].id : '', entries }
    if (entries.length) {
      log('白名单：从 allow.json 迁移了 ' + entries.length + ' 条')
      saveWhitelist(migrated)
    }
    return migrated
  } catch (err) {
    return { owner: '', entries: [] }
  }
}

function saveWhitelist(list) {
  try {
    const clean = normalizeWhitelist(list)
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(clean, null, 2), 'utf8')
    return clean
  } catch (err) {
    log('白名单写不进去：' + String((err && err.message) || err))
    return null
  }
}

/** 私聊：这个号在名单里、且没被静音 */
function isAllowedPrivate(userId) {
  const list = loadWhitelist()
  return list.entries.some((e) => e.type === 'private' && e.id === String(userId) && e.reply !== false)
}

/** 群聊：这个群在名单里、且没被静音 */
function isAllowedGroup(groupId) {
  const list = loadWhitelist()
  return list.entries.some((e) => e.type === 'group' && e.id === String(groupId) && e.reply !== false)
}

/** 他在提示词里是谁：owner / 朋友 / 群 */
function identityOf(userId, groupId) {
  const list = loadWhitelist()
  const uid = String(userId || '')
  const gid = String(groupId || '')
  if (gid) {
    const group = list.entries.find((e) => e.type === 'group' && e.id === gid)
    const isOwner = uid && uid === list.owner
    return {
      kind: 'group',
      groupName: group ? group.name || '这个群' : '这个群',
      isOwner,
      label: isOwner
        ? 'owner 在群里说话（' + (group && group.name ? group.name : '群') + '）'
        : '别人在群里说话（' + (group && group.name ? group.name : '群') + '）',
    }
  }
  return {
    kind: 'private',
    isOwner: uid === list.owner,
    label: uid === list.owner ? 'owner 本人私聊你' : '别人私聊你（不是 owner）',
  }
}

function loadAllow() {
  /* 兼容层：老的调用点都在问「owner 是谁」，所以这里返回 owner ID。
     白名单本身用 isAllowedPrivate / isAllowedGroup 判。 */
  const wl = loadWhitelist()
  return wl.owner ? [wl.owner] : []
}

function loadAllowLegacy() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DIR, 'allow.json'), 'utf8'))
    return Array.isArray(parsed.qq) ? parsed.qq.map(String) : []
  } catch (err) {
    return []
  }
}

function textOf(message) {
  if (typeof message === 'string') return message.trim()
  if (!Array.isArray(message)) return ''
  return message
    .filter((seg) => seg && seg.type === 'text')
    .map((seg) => (seg.data && typeof seg.data.text === 'string' ? seg.data.text : ''))
    .join('')
    .trim()
}

/* 每个对话对象一条历史（只服务一个人，但按 user_id 分开不亏） */
const histories = new Map()
const HIST_FILE = path.join(DIR, 'chat-history.json')

/** 桥重启后把最近几轮读回来，别一重启就当没见过他 */
function loadHistories() {
  try {
    const raw = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8').replace(/^\uFEFF/, ''))
    let count = 0
    for (const [id, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue
      histories.set(id, list.slice(-HISTORY_TURNS * 2))
      count += 1
    }
    if (count) log('已恢复 ' + count + ' 个会话的历史')
  } catch (err) { /* 第一次跑没有这个文件，正常 */ }
}

function saveHistories() {
  try {
    const out = {}
    for (const [id, list] of histories) out[id] = list.slice(-HISTORY_TURNS * 2)
    fs.writeFileSync(HIST_FILE, JSON.stringify(out, null, 2), 'utf8')
  } catch (err) {
    log('存对话历史失败：' + String((err && err.message) || err))
  }
}

/* 正在攒的连发消息：userId -> { texts, timer } */
const merged = new Map()
function historyFor(userId) {
  if (!histories.has(userId)) histories.set(userId, [])
  return histories.get(userId)
}

function stampNow() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0')
}

/* ---------- 表达方式学习（从真实对话里学，不是靠我写规则） ---------- */
const VOICE_FILE = path.join(DIR, 'voice.json')

function loadVoice() {
  try {
    const data = JSON.parse(fs.readFileSync(VOICE_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return data && typeof data === 'object' ? data : {}
  } catch (err) {
    return {}
  }
}

/** 他说话的样子 + 她说得像人的几句，拼进 prompt 的一小段 */
function voiceBlock() {
  const v = loadVoice()
  const parts = []
  if (v.userStyle) parts.push('他说话的样子：' + v.userStyle)
  if (Array.isArray(v.goodReplies) && v.goodReplies.length) {
    parts.push('你自己说过的、像人的几句（照这个节奏，别照抄）：' + v.goodReplies.slice(0, 6).join(' / '))
  }
  return parts.length ? '（' + parts.join('\n') + '）\n\n' : ''
}

/**
 * 从最近的对话里提炼"表达方式"：他怎么说、她哪几句像人。
 * 一天最多跑一次；和记忆蒸馏分开——这里学的是腔调，不是事实。
 */
async function updateVoiceProfile(force) {
  try {
    const chat = currentChat()
    if (!chat || !chat.baseURL || !chat.key) return
    const v = loadVoice()
    const hours = (Date.now() - (Number(v.updatedAt) || 0)) / 3600000
    if (!force && hours < 24) return

    const list = loadTranscript().slice(-60)
    if (list.length < 6) return

    const convo = list.map((item) => '他：' + item.user + '\n你：' + item.assistant).join('\n')
    const response = await fetch(chat.baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + chat.key },
      body: JSON.stringify({
        model: chat.model,
        messages: [
          {
            role: 'system',
            content: [
              '看一段 QQ 私聊，做两件事，只输出 JSON：',
              '1) userStyle：用一两句话描述"他"说话的习惯——句子长短、有没有标点、用不用表情、爱不爱接话。写具体，别写"简洁自然"这种空话。',
              '2) goodReplies：从"你"的回复里挑 3-5 句最像真人的（短、具体、不端着），原样摘出来，不要改写。',
              'JSON 形状：{"userStyle":"...","goodReplies":["...","..."]}',
            ].join('\n'),
          },
          { role: 'user', content: convo.slice(-5000) },
        ],
        max_tokens: 500,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const data = await response.json()
    const raw = String(data?.choices?.[0]?.message?.content || '')
    const json = raw.match(/\{[\s\S]*\}/)
    if (!json) throw new Error('返回不是 JSON')
    const parsed = JSON.parse(json[0])
    const userStyle = String(parsed.userStyle || '').trim().slice(0, 200)
    const goodReplies = (parsed.goodReplies || []).map((x) => String(x).trim()).filter((x) => x && x.length <= 40).slice(0, 6)
    if (!userStyle && !goodReplies.length) throw new Error('没提炼出东西')

    fs.writeFileSync(VOICE_FILE, JSON.stringify({
      updatedAt: Date.now(),
      userStyle,
      goodReplies,
    }, null, 2), 'utf8')
    log('表达方式已更新：' + userStyle.slice(0, 40) + '（样本 ' + goodReplies.length + ' 句）', 'model')
  } catch (err) {
    log('表达方式更新失败：' + String((err && err.message) || err), 'model')
  }
}

/* ---------- 她改自己：受控自改通道 ---------- */
/*
 * 只允许改白名单里的几个"她自己的"文件。流程：
 *   备份 → 校验 → 写临时文件 → 原子替换 → 失败回滚
 * 桥自己跑的代码（bridge.mjs）、权限开关、白名单一律不在可改范围。
 */
const SELF_DIR = DIR
const SELF_BACKUP = path.join(DIR, 'self-edit-backups')
const SELF_FILES = {
  style: { file: path.join(SELF_DIR, 'persona-extra.md'), max: 6000, kind: 'text', desc: '她自己的风格补充，会拼在每次提示词里' },
  caps: { file: path.join(SELF_DIR, 'capabilities.json'), max: 4000, kind: 'json', desc: '它自己想具备的能力清单' },
  log: { file: path.join(SELF_DIR, 'improvements.md'), max: 12000, kind: 'text', desc: '它自己做过的改动日志' },
}

function selfRead(key) {
  const spec = SELF_FILES[key]
  if (!spec) return { ok: false, reason: '没有这个文件：' + key }
  try {
    const content = fs.readFileSync(spec.file, 'utf8')
    return { ok: true, key, content, desc: spec.desc }
  } catch (err) {
    return { ok: true, key, content: '', desc: spec.desc }
  }
}

function selfWrite(key, content) {
  const spec = SELF_FILES[key]
  if (!spec) return { ok: false, reason: '没有这个文件：' + key }
  const text = String(content == null ? '' : content)
  if (text.length > spec.max) return { ok: false, reason: '太长了（上限 ' + spec.max + ' 字）' }

  /* 校验：json 必须能解析 */
  if (spec.kind === 'json') {
    try { JSON.parse(text) } catch (err) {
      return { ok: false, reason: 'JSON 不合法：' + String((err && err.message) || err) }
    }
  }

  try {
    fs.mkdirSync(SELF_BACKUP, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      fs.copyFileSync(spec.file, path.join(SELF_BACKUP, key + '-' + stamp + '.bak'))
    } catch (err) { /* 原来没有就算了 */ }

    /* 原子写：先写临时文件再改名，避免写一半断电留下半个文件 */
    const tmp = spec.file + '.tmp-' + Date.now()
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, spec.file)
    log('她改了自己：' + key + '（' + text.length + ' 字）', 'model')
    return { ok: true, key, length: text.length }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
}

/** 她自己写的那段风格补充，拼进每次提示词 */
/**
 * 人设从 persona-extra.md 读，不再写死在 profile 的 personaPrefix 里。
 * 这样人设工坊切换人设只需写这个文件，下一句话就生效，不用重启。
 * 上限 7000 字：生成出来的人设卡大约 2000-2500 字，留够空间。
 */
function personaExtraBlock() {
  try {
    const text = fs.readFileSync(SELF_FILES.style.file, 'utf8').trim()
    if (!text) return ''
    return '（你是谁、怎么说话、怎么表达情绪，全部按下面这段来——这是你本身，不是附加说明）\n' + text.slice(0, 7000) + '\n\n'
  } catch (err) {
    return ''
  }
}

/* 心声（*（……）*）别每句都冒：上一条冒过，这条就去掉 */
let lastHadOs = false

function limitInnerVoice(text) {
  const has = /\*（[^）]*）\*/.test(text)
  if (has && lastHadOs) {
    const stripped = text.replace(/\*（[^）]*）\*\s*/g, '').trim()
    if (stripped.length >= 2) {
      log('上一条已经冒过心声，这条去掉')
      lastHadOs = false
      return stripped
    }
  }
  lastHadOs = has
  return text
}
/* ---------- 自主唤醒状态：读和调 ---------- */
const AWAKE_STATE_FILE = path.join(DIR, 'awake-state.json')

function readAwakeState() {
  try {
    const raw = JSON.parse(fs.readFileSync(AWAKE_STATE_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return { ok: true, state: raw }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
}

function writeAwakeState(patch) {
  const cur = readAwakeState()
  if (!cur.ok) return { ok: false, reason: cur.reason }
  const state = cur.state
  if (patch.drives) {
    for (const key of ['miss', 'curious', 'share', 'tired']) {
      if (patch.drives[key] !== undefined) {
        const v = Number(patch.drives[key])
        if (!Number.isFinite(v)) return { ok: false, reason: key + ' 不是数字' }
        state.drives[key] = Math.max(0, Math.min(1, v))
      }
    }
  }
  if (patch.unanswered !== undefined) {
    const v = Number(patch.unanswered)
    if (!Number.isFinite(v) || v < 0) return { ok: false, reason: 'unanswered 得是非负数' }
    state.unanswered = v
  }
  if (patch.mode !== undefined) {
    const m = String(patch.mode)
    if (!['followup', 'initiative'].includes(m)) return { ok: false, reason: 'mode 只能是 followup 或 initiative' }
    state.mode = m
  }
  if (patch.wakeNow) state.nextWakeAt = 0
  try {
    fs.writeFileSync(AWAKE_STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
    return { ok: true, state }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
}
/**
 * 她自己的话会一遍遍进上下文，于是同一个梗能说五六遍——
 * 上午一句"借肩膀"，晚上还在"肩膀留着下次借"。真人不会这样。
 *
 * 这里从她最近几条回复里找出反复出现的词，明确告诉她这次别再用。
 * 不靠模型自觉，因为它看到历史里的自己就会被带着重复。
 */
const NOISE_WORDS = new Set([
  '我们','你们','他们','这个','那个','什么','怎么','可以','已经','还是','就是',
  '不是','没有','知道','现在','时候','一个','这样','那样','真的','其实','所以',
  '因为','但是','而且','然后','如果','应该','不会','不要','觉得','可能','应该',
])

function overusedPhrases(history, minReplies = 3, window = 10) {
  const replies = (history || [])
    .filter((h) => h.role === 'assistant')
    .slice(-window)
    .map((h) => String(h.text || ''))
  if (replies.length < minReplies) return []

  const where = new Map()
  replies.forEach((text, idx) => {
    const seen = new Set()
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= text.length; i++) {
        const g = text.slice(i, i + n)
        if (!/^[\u4e00-\u9fa5]{2,3}$/.test(g)) continue
        if (NOISE_WORDS.has(g)) continue
        if (seen.has(g)) continue
        seen.add(g)
        if (!where.has(g)) where.set(g, new Set())
        where.get(g).add(idx)
      }
    }
  })

  const hits = [...where.entries()]
    .filter(([, set]) => set.size >= minReplies)
    .map(([g, set]) => ({ g, n: set.size }))
    .sort((a, b) => b.n - a.n || b.g.length - a.g.length)

  /* 去掉被更长词组包含的短词：说"肩膀"就够了，别再列"肩" */
  const picked = []
  for (const { g } of hits) {
    if (picked.some((p) => p.includes(g) || g.includes(p))) continue
    picked.push(g)
    if (picked.length >= 3) break
  }
  return picked
}

/**
 * 环境变量统一用 Q QPB_ 前缀。
 */
function env(name, fallback = '') {
  const suffix = name.replace(/^QQPB_/, '')
  return process.env['QQPB_' + suffix] || fallback
}

/* ---------- 记忆检索（SQLite 服务，8790） ---------- */
const MEM_URL = env('QQPB_MEM_URL') || 'http://127.0.0.1:8790'

/**
 * 按当前这句话去记忆库里捞相关的事。
 *
 * 超时只给 800ms：记忆是锦上添花，不能因为服务卡住就让她不回消息。
 * 服务没起来就返回空，一切照常——只写不读是现状，接了之后至少能读。
 */
/**
 * 记忆库里同一个事实常有五六种说法（她每次遇到同样的感受就又记一条），
 * 检索会把它们一起捞出来——结果提示词里五条都在说"借肩膀"，
 * 反而把"别重复同一个梗"变成了"重复五次"。
 *
 * 这里按字面相似度去重：两条有 40% 以上重合就只留一条。
 */
function bigrams(text) {
  const s = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
  const set = new Set()
  for (let i = 0; i + 2 <= s.length; i++) set.add(s.slice(i, i + 2))
  return set
}

function trigrams(text) {
  const s = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
  const set = new Set()
  for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3))
  return set
}

/**
 * 判断两条记忆是不是"同一件事"。
 *
 * 只比二元组不够：同一件事换种说法，共享的词只有"累""肩膀"这种两字，
 * 占总词数不到两成，判不出重复。三元组"借肩膀""肩膀靠"才是有辨识度的。
 * 只要共享一个三元组就当同一件事——宁可少给一条，也别三句话都在提同一件事。
 */
function similar(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size && B.size) {
    let hit = 0
    for (const g of A) if (B.has(g)) hit++
    if (hit / Math.min(A.size, B.size) >= 0.4) return true
  }
  const C = trigrams(a)
  const D = trigrams(b)
  for (const g of C) if (D.has(g)) return true
  return false
}

function dedupeBlock(block) {
  const lines = String(block || '').split('\n')
  const header = lines[0] || ''
  let footer = ''
  const items = []
  for (const line of lines.slice(1)) {
    const s = line.trim()
    if (s.startsWith('- ')) items.push(s)
    else if (s) footer = s
  }
  const kept = []
  for (const item of items) {
    if (kept.some((k) => similar(k, item))) continue
    kept.push(item)
    if (kept.length >= 3) break
  }
  return { header, kept, footer }
}

async function recallBlock(query) {
  const q = String(query || '').trim()
  if (!q) return ''
  try {
    const r = await fetch(MEM_URL + '/context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: q.slice(0, 200), k: 5, max_chars: 600 }),
      signal: AbortSignal.timeout(800),
    })
    if (!r.ok) return ''
    const j = await r.json()
    const block = String(j.block || '').trim()
    /* 服务自己会带表头表尾，但空块会只剩表头，要判一下 */
    if (block.length < 30) return ''
    const { header, kept, footer } = dedupeBlock(block)
    if (!kept.length) return ''
    log('记忆命中 ' + kept.length + ' 条（原始 ' + (j.hits ? j.hits.length : kept.length) + '）', 'mem')
    return header + '\n' + kept.join('\n') + (footer ? '\n' + footer : '')
  } catch (err) {
    return ''
  }
}

function buildPrompt(userId, text) {
  return buildPromptAsync(userId, text)
}

/**
 * 提示词组装改成异步：要先查记忆再拼。
 * 记忆放在人设之后、对话历史之前——它是"背景"，
 * 放太前会盖过人设，放最后会盖过当前这句话。
 */
async function buildPromptAsync(userId, text) {
  const memory = await recallBlock(text)
  const history = historyFor(userId)
  if (!history.length) {
    return '现在 ' + stampNow() + '。\n\n' + personaExtraBlock() + (memory ? memory + '\n\n' : '') + voiceBlock() + text
  }
  const lines = history.slice(-HISTORY_TURNS * 2).map((item) => {
    return (item.role === 'user' ? '用户：' : '你：') + item.text
  })
  const reused = overusedPhrases(history)
  const reuseWarn = reused.length
    ? '【别重复自己】你最近几条反复提到「' + reused.join('」「') + '」。这次别再用这些词，也别绕回去讲同一个事。\n' +
      '同一个梗用第二遍就不像人了，第一次是好笑，第六次是机械。\n\n'
    : ''
  return '现在 ' + stampNow() + '。\n\n' + personaExtraBlock() + (memory ? memory + '\n\n' : '') +
    voiceBlock() + reuseWarn +
    '以下是你们在 QQ 上最近的对话（保持连贯，但不要复述它）：\n' +
    lines.join('\n') + '\n\n用户现在说：' + text
}

/**
 * 她自己发呆时想到的、值得留的事，写进记忆库。
 * 这样它是"她记住的"，不是我在提示词里提醒她的。
 */
function rememberFromThought(text, kind, tags) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 300)
  if (clean.length < 6) return false

  /* 主路：SQLite 记忆服务——那有去重、衰减、概念分组，而且能被检索回来。
     只有服务挂了才退回 JSON，不同时写两边（会漂移、会长出重复条目）。 */
  serviceWrite(clean, kind, tags)
  return true
}

function serviceWrite(clean, kind, tags) {
  fetch(MEM_URL + '/write', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: clean, source: 'chat', pinned: false }),
    signal: AbortSignal.timeout(3000),
  })
    .then((r) => {
      if (r.ok) {
        log('记下一条（' + (kind || 'person') + '）：' + clean.slice(0, 40), 'model')
      } else {
        jsonWriteFallback(clean, kind, tags)
      }
    })
    .catch(() => jsonWriteFallback(clean, kind, tags))
}

function jsonWriteFallback(clean, kind, tags) {
  try {
    const file = path.join(HOME, '.dsh', 'agent-memory.json')
    const store = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const entries = Array.isArray(store.entries) ? store.entries : []
    /* 近似重复就不记了：看前 15 个字 */
    const head = clean.slice(0, 15)
    if (entries.some((entry) => String(entry.text || '').includes(head))) return false
    const now = Date.now()
    entries.unshift({
      id: 'm-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      text: clean,
      tags: Array.isArray(tags) && tags.length ? tags : ['自主念头'],
      pinned: false,
      createdAt: now,
      updatedAt: now,
      hits: 0,
      kind: kind || 'person',
      lastUsedAt: now,
    })
    store.entries = entries.slice(0, 400)
    fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8')
    log('记下一条（' + (kind || 'person') + '）：' + clean.slice(0, 40), 'model')
    return true
  } catch (err) {
    log('写记忆失败：' + String((err && err.message) || err))
    return false
  }
}

/* ---------- 对话蒸馏：把聊天变成记忆 ---------- */
const TRANSCRIPT = path.join(DIR, 'transcript.json')
const DISTILL_STATE = path.join(DIR, 'distill-state.json')

function loadTranscript() {
  try {
    const list = JSON.parse(fs.readFileSync(TRANSCRIPT, 'utf8').replace(/^\uFEFF/, ''))
    return Array.isArray(list) ? list : []
  } catch (err) {
    return []
  }
}

function appendTranscript(userText, assistantText, thinking) {
  try {
    const list = loadTranscript()
    list.push({ at: Date.now(), user: String(userText || ''), assistant: String(assistantText || ''), thinking: String(thinking || '') })
    fs.writeFileSync(TRANSCRIPT, JSON.stringify(list.slice(-300), null, 2), 'utf8')
  } catch (err) { /* 忽略 */ }
}

/**
 * 攒够几轮、或过了一段时间，就把这段时间的对话提炼成记忆。
 * 只记关于"他这个人"的：偏好、习惯、在意的事、约定。
 * 技术细节走 memory_save，不在这里记。
 */
async function distillIfDue(force) {
  try {
    const chat = currentChat()
    if (!chat || !chat.baseURL || !chat.key) return
    let state = {}
    try {
      state = JSON.parse(fs.readFileSync(DISTILL_STATE, 'utf8').replace(/^\uFEFF/, ''))
    } catch (err) { state = {} }

    const since = Number(state.lastDistilledAt) || 0
    const list = loadTranscript().filter((item) => item.at > since)
    if (!list.length) {
      if (force) log('蒸馏：没有新对话')
      return
    }
    const hoursSince = (Date.now() - since) / 3600000
    if (!force && list.length < 8 && hoursSince < 12) return

    const convo = list.slice(-40).map((item) => '他：' + item.user + '\n你：' + item.assistant).join('\n')
    const response = await fetch(chat.baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + chat.key },
      body: JSON.stringify({
        model: chat.model,
        messages: [
          {
            role: 'system',
            content: [
              '从下面这段 QQ 对话里，提炼关于"这个人"的长期有效信息：他的偏好、习惯、在意的事、你们之间的约定、他明确表达过的好恶。',
              '不要写寒暄、不要写技术细节、不要写"这次聊了什么"。要写能长期用的。',
              '一条一句话，最多 3 条；确实没有就给空数组。',
              '只输出 JSON：{"facts":["...","..."]}',
            ].join('\n'),
          },
          { role: 'user', content: convo.slice(-6000) },
        ],
        max_tokens: 600,
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(90000),
    })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const data = await response.json()
    const text = String(data?.choices?.[0]?.message?.content || '')
    const json = text.match(/\{[\s\S]*\}/)
    if (!json) throw new Error('返回不是 JSON')
    const facts = (JSON.parse(json[0]).facts || []).map((f) => String(f)).filter(Boolean).slice(0, 3)

    let written = 0
    for (const fact of facts) {
      if (rememberFromThought(fact, 'person', ['对话蒸馏'])) written += 1
    }
    fs.writeFileSync(
      DISTILL_STATE,
      JSON.stringify({ lastDistilledAt: Date.now(), scanned: list.length, facts: facts.length, written }, null, 2),
      'utf8'
    )
    log('对话蒸馏：看了 ' + list.length + ' 轮，提炼 ' + facts.length + ' 条，写入 ' + written + ' 条')
  } catch (err) {
    log('蒸馏失败：' + String((err && err.message) || err))
  }
}

/** 从 stderr 里抽出她的思考过程（dsh 会把它打在 reasoning: 后面） */
function extractReasoning(stderrText) {
  const raw = String(stderrText || '')
  const mark = raw.indexOf('dsh: reasoning:')
  if (mark < 0) return ''
  let body = raw.slice(mark + 'dsh: reasoning:'.length)
  const next = body.indexOf('\ndsh: ')
  if (next >= 0) body = body.slice(0, next)
  return body.replace(/\r/g, '').trim()
}
/** 存进对话记录时用的展示文本：不要把路径和提示词指令塞进去 */
function displayUserText(rawText, imageCount, stickerCount) {
  const parts = []
  const say = String(rawText || '').trim()
  if (say) parts.push(say)
  if (stickerCount > 0) parts.push('（发了个表情包）')
  else if (imageCount > 0) parts.push('（发了 ' + imageCount + ' 张图）')
  return parts.join(' ')
}

/** 她发出去的东西，[图片]/[表情包] 换成一句人话 */
function displayAssistantText(text) {
  let out = String(text || '')
  const hadSticker = /\[表情包\]/.test(out)
  out = out.replace(/^[ \t]*\[表情包\][^\n]*$/gm, '').trim()
  out = out.replace(/^[ \t]*\[图片\][^\n]*$/gm, '').trim()
  const extra = []
  if (hadSticker) extra.push('（回了你的表情包）')
  if (!out) return extra.join(' ') || '（没说话）'
  return out + (extra.length ? ' ' + extra.join(' ') : '')
}
/**
 * 问模型。
 *
 * 默认走 DSH（功能最全：工具、人设注入、图片识别）。
 * 但 DSH 不是必须的 —— 一个能"收下 prompt、吐出文字"的后端就够了。
 * 换成任何 OpenAI 兼容 API（官方、硅基流动、本地 Ollama、vLLM）都可以，
 * 只是那些工具能力会没有，剩下对话本身。
 *
 * 后端在 config.json 里用 llmProvider 选：dsh / openai / cli
 */
function askModel(prompt) {
  const kind = String(config.llmProvider || 'dsh').toLowerCase()
  if (kind === 'openai') return askOpenAI(prompt)
  if (kind === 'cli') return askCli(prompt)
  return askDsh(prompt)
}

/**
 * OpenAI 兼容后端。
 *
 * 只做一件事：把 prompt 发给 /chat/completions，取回文本。
 * 没有工具调用 —— 所以她不能自己看图片、跑命令。
 * 图片和 OCR 那些能力依赖 DSH，换后端就只剩对话。
 */
async function askOpenAI(prompt) {
  const base = String(config.llmBase || '').replace(/\/+$/, '')
  const model = String(config.llmModel || '')
  if (!base || !model) {
    return { ok: false, text: '我这边没配好模型地址，得先在 config.json 里填 llmBase 和 llmModel' }
  }
  const key = config.llmKey || process.env.QQPB_LLM_KEY || process.env.OPENAI_API_KEY || ''

  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: 'Bearer ' + key } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: Number(config.llmTemperature ?? 1.0),
        max_tokens: Number(config.llmMaxTokens ?? 2000),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    const raw = await res.text()
    if (!res.ok) {
      return { ok: false, text: friendlyFailure(raw || ('HTTP ' + res.status)) }
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      return { ok: false, text: friendlyFailure(raw) }
    }

    const msg = parsed.choices && parsed.choices[0] && parsed.choices[0].message
    const text = String((msg && msg.content) || '').trim()
    /* 推理模型（deepseek-r1 这类）会把思考放在 reasoning_content */
    const thinking = String((msg && (msg.reasoning_content || msg.reasoning)) || '').trim()
    if (!text) {
      return { ok: false, text: friendlyFailure(raw) }
    }
    return { ok: true, text, thinking }
  } catch (err) {
    return { ok: false, text: friendlyFailure(err && err.message ? err.message : String(err)) }
  }
}

/**
 * 任意命令行程序当后端。
 *
 * prompt 从 stdin 进去，答案从 stdout 出来 —— 这样能接任何
 * "读标准输入、写标准输出"的工具（本地 llama.cpp、ollama run、shell 脚本）。
 */
function askCli(prompt) {
  return new Promise((resolve) => {
    const cmd = String(config.llmCliCmd || '')
    if (!cmd) {
      return resolve({ ok: false, text: '我这边没配好命令，得先在 config.json 里填 llmCliCmd' })
    }
    let settled = false
    const child = spawn('cmd', ['/c', cmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: resolveTool(config.dshCwd) || undefined,
    })

    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.stderr.on('data', (c) => { err += c.toString('utf8') })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch (e) { /* 忽略 */ }
      resolve({ ok: false, text: '这条我弄太久了，先停下。重说一次我换个办法。' })
    }, TIMEOUT_MS)

    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, text: '我这边起不来：' + e.message })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const answer = String(out || '').trim()
      if (code === 0 && answer) return resolve({ ok: true, text: answer, thinking: '' })
      resolve({ ok: false, text: friendlyFailure((err || out || '').trim() || ('退出码 ' + code)) })
    })

    try {
      child.stdin.end(String(prompt || ''), 'utf8')
    } catch (e) { /* 进程可能已经退出 */ }
  })
}

function askDsh(prompt) {
  return new Promise((resolve) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', QQPB_MODE: 'qq' }
    /* 页面上添加的 API，key 存在 providers.json 里；
       没填 key 的（tokenav/wdapi 这类）从 ~/.dsh/.credentials.yaml 按环境变量名取 */
    try {
      for (const entry of readProviders()) {
        const envName = providerEnvName(entry)
        const value = entry.key || loadKey(envName)
        if (value) env[envName] = value
      }
    } catch (err) { /* 读不到就用原有环境 */ }

    let settled = false
    /* 每轮都按开关对齐一次：改完下一条消息就生效 */
    const allowComputer = computerAllowed()
    applyComputerPermission(allowComputer)
    if (!allowComputer) env.DSH_PERMISSION_MODE = 'read-only'
    const child = spawn(DSH_EXE, ['--expose-internals', DSH_CLI, 'headless', '--json', prompt], {
      env,
      cwd: resolveTool(config.dshCwd) || undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8') })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      } catch (e) { /* 忽略 */ }
      resolve({ ok: false, text: '这条我弄太久了，先停下。重说一次我换个办法。' })
    }, TIMEOUT_MS)

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, text: '我这边起不来：' + error.message })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      /* --json 是一行一个事件：thinking 是完整思考，final 是最终回答 */
      let thinking = ''
      let finalText = ''
      for (const line of String(out || '').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        try {
          const event = JSON.parse(trimmed)
          if (event.type === 'thinking' && event.text) thinking += event.text
          else if (event.type === 'final' && event.text) finalText = String(event.text)
        } catch (err) { /* 不是事件行 */ }
      }

      /* 老格式兜底：stdout 直接是答案 */
      const answer = (finalText || String(out || '').replace(/^\{.*\}$/gm, '')).trim()
      if (code === 0 && answer) {
        return resolve({ ok: true, text: answer, thinking: thinking.trim() || extractReasoning(err) })
      }
      const reason = (err || out || '').trim().split('\n').filter(Boolean).pop() || ('退出码 ' + code)
      resolve({ ok: false, text: friendlyFailure(reason) })
    })
  })
}

/**
 * 把技术错误翻成人话。
 * QQ 那边不该看到 "dsh: AUTH: 403 SUBSCRIPTION_NOT_FOUND" 这种东西。
 */
function friendlyFailure(reason) {
  let text = String(reason || '')
  /* --json 模式下失败可能是一行 JSON，先取里面的 message */
  if (text.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(text.trim())
      text = String(parsed.message || (parsed.error && parsed.error.message) || text)
    } catch (err) { /* 保持原样 */ }
  }
  if (/SUBSCRIPTION_NOT_FOUND|AUTH: 40[13]|insufficient_quota|额度不足|余额不足/i.test(text)) {
    return '我这边模型额度用完了，得换一个才能继续'
  }
  if (/cpu overloaded|SERVER: 50[234]|服务不可用|temporarily unavailable/i.test(text)) {
    return '对面服务器忙不过来，等会儿再试'
  }
  if (/rate.?limit|429/i.test(text)) {
    return '被限流了，过几分钟再说'
  }
  if (/ECONNREFUSED|ETIMEDOUT|fetch failed|socket hang up|网络/i.test(text)) {
    return '我连不上外网，等会儿再试'
  }
  if (/timeout|超时/i.test(text)) {
    return '这条太久了，先停下'
  }
  return '这条没跑成：' + text.slice(0, 120)
}

/** 这类失败重试有意义；额度用完、认证失败重试也没用 */
function isRetryable(text) {
  return /cpu overloaded|SERVER: 50[234]|temporarily unavailable|rate.?limit|429|ECONNRESET|socket hang up|fetch failed/i.test(String(text || ''))
}

/**
 * 干得久了报一声进度，别让人对着屏幕猜。
 * 和 quickAck 一样是独立小请求，失败就不发。
 */
async function progressLine(userText, seconds) {
  const chat = currentChat()
  if (!chat || !chat.baseURL) return ''
  const key = chat.key
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const response = await fetch(chat.baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: chat.model,
        messages: [
          {
            role: 'system',
            content:
              '你在 QQ 上帮人做事，已经忙了 ' + seconds + ' 秒还没完。说清你此刻在做什么，不要承诺马上完成。' +
              '回一句极短的进度（不超过 12 个字），像随口说的，不要客套、不要模板、不要编号。' +
              '只输出这句话本身。',
          },
          { role: 'user', content: userText },
        ],
        max_tokens: 512,
        reasoning_effort: 'low',
        temperature: 1.2,
      }),
      signal: controller.signal,
    })
    if (!response.ok) return ''
    const data = await response.json()
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '')
      : ''
    return content.trim().replace(/^["「『]|["」』]$/g, '').slice(0, 40)
  } catch (err) {
    return ''
  } finally {
    clearTimeout(timer)
  }
}
/* ---------- NapCat ---------- */
let socket = null

function send(userId, text) {
  if (!socket || socket.readyState !== 1) {
    log('WS 未连接，消息没发出去：' + String(text).slice(0, 40))
    return false
  }
  socket.send(JSON.stringify({
    action: 'send_private_msg',
    params: { user_id: Number(userId), message: [{ type: 'text', data: { text } }] },
    echo: 'qqpb-' + Date.now(),
  }))
  return true
}

/* ---------- 主动调用 NapCat 接口（拉历史等） ---------- */
const pendingActions = new Map()

function callAction(action, params, timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (!socket || socket.readyState !== 1) return resolve({ ok: false, reason: 'WS 未连接' })
    const echo = 'qqpb-act-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
    const timer = setTimeout(() => {
      pendingActions.delete(echo)
      resolve({ ok: false, reason: '接口超时' })
    }, timeoutMs)
    pendingActions.set(echo, { resolve, timer })
    socket.send(JSON.stringify({ action, params, echo }))
  })
}

function sendImage(userId, file) {
  if (!socket || socket.readyState !== 1) {
    log('WS 未连接，图片没发出去：' + file)
    return false
  }
  const normalized = path.resolve(file).replace(/\\/g, '/')
  socket.send(JSON.stringify({
    action: 'send_private_msg',
    params: {
      user_id: Number(userId),
      message: [{ type: 'image', data: { file: 'file:///' + normalized } }],
    },
    echo: 'qqpb-img-' + Date.now(),
  }))
  log('已发图：' + path.basename(file))
  return true
}

/* ---------- 后台任务：长活不占回合，桥自己跑 ---------- */
const JOBS_DIR = path.join(DIR, 'jobs')
const OUT_DIR = path.join(DIR, 'out')

/**
 * 异步跑一个 node 脚本。
 * 必须用 spawn 而不是 spawnSync：spawnSync 会把事件循环整个卡住，
 * 期间收不到 QQ 消息、HTTP 接口也不响应——生一张图 30 秒，桥就等于死 30 秒。
 */
function runScript(scriptArgs, timeoutMs, cwd) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, scriptArgs, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: cwd || undefined,
      })
    } catch (err) {
      return resolve({ status: -1, stdout: '', stderr: String((err && err.message) || err) })
    }

    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch (err) { /* 忽略 */ }
      finish({ status: -1, stdout, stderr: stderr + '\n超时' })
    }, timeoutMs)

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (err) => finish({ status: -1, stdout, stderr: String((err && err.message) || err) }))
    child.on('close', (code) => finish({ status: code, stdout, stderr }))
  })
}
const GEN_IMAGE = resolveTool(config.genImageTool)

async function executeJob(job) {
  const userId = String(job.qq || (loadAllow()[0] || ''))
  if (!userId) return

  if (job.type === 'gen-image') {
    const count = Math.min(Math.max(Number(job.count) || 1, 1), 6)
    const prompt = String(job.prompt || '').slice(0, 800)
    const size = Number(job.size) || 512
    log('任务：生成 ' + count + ' 张 —— ' + prompt.slice(0, 40))
    fs.mkdirSync(OUT_DIR, { recursive: true })
    let sentCount = 0
    for (let index = 0; index < count; index += 1) {
      const out = path.join(OUT_DIR, 'gen-' + Date.now() + '-' + index + '.png')
      const run = await runScript([GEN_IMAGE, prompt, out, '--size', String(size)], 180000)
      /* 脚本会打印 "PATH: 实际路径"——扩展名可能被改成 .jpg */
      const printed = String(run.stdout || '')
      const pathLine = printed.match(/^PATH:\s*(.+)$/m)
      const produced = pathLine && fs.existsSync(pathLine[1].trim())
        ? pathLine[1].trim()
        : fs.existsSync(out) ? out : ''
      if (produced) {
        sendImage(userId, produced)
        sentCount += 1
      } else {
        const why = String(run.stderr || run.stdout || '').trim().split('\n').filter(Boolean).slice(-1)[0] || ('退出码 ' + run.status)
        log('生成失败：' + why.slice(0, 200))
        if (count > 1) send(userId, '第 ' + (index + 1) + ' 张没出来')
      }
      await new Promise((resolve) => setTimeout(resolve, 1200))
    }
    /* 图本身就是结果，不再补一句"都发你了"——那种话是我加的，不是她说的。
       只有一张都没出来时才开口，而且只说一句。 */
    if (sentCount === 0) {
      send(userId, '没生成出来，等会儿再试')
    } else if (sentCount < count) {
      send(userId, '只出来 ' + sentCount + ' 张')
    }
    log('任务完成：gen-image ×' + sentCount + '/' + count)
    return
  }

  send(userId, '（不认识的任务类型：' + String(job.type) + '）')
}

function pollJobs() {
  try {
    if (!fs.existsSync(JOBS_DIR)) return
    const files = fs.readdirSync(JOBS_DIR).filter((name) => name.endsWith('.json'))
    for (const name of files) {
      const full = path.join(JOBS_DIR, name)
      let job = null
      try {
        /* 去掉可能的 UTF-8 BOM：Windows 上写文件常常带上 */
        const raw = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '')
        job = JSON.parse(raw)
      } catch (err) {
        log('任务文件读不了，跳过：' + name + '（' + String((err && err.message) || err) + '）')
      }
      /* 先删掉再执行，避免下一轮重复跑 */
      try { fs.rmSync(full, { force: true }) } catch (err) { /* 忽略 */ }
      if (job) executeJob(job).catch((err) => log('任务失败：' + String((err && err.message) || err)))
    }
  } catch (err) {
    log('扫描任务目录失败：' + String((err && err.message) || err))
  }
}

/* 他可能一句话分几条发：正在跑回合时又来了新消息，就把这次回答作废，合并重来 */
const runningTask = new Map()
const pendingExtra = new Map()
let running = 0
/* 同一个人串行，保证回答不插队；不同人之间才并行 */
const userChains = new Map()

function dispatch(task) {
  const previous = userChains.get(task.userId) || Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      while (running >= MAX_PARALLEL) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      running += 1
      try {
        await runTask(task)
      } finally {
        running -= 1
      }
    })
  userChains.set(task.userId, next)
}

/* ---------- QQ 内置表情：她写 [表情] 呲牙，桥翻译成 face 段 ---------- */
const FACES_FILE = path.join(DIR, 'faces.json')
let FACES = {}

function loadFaces() {
  try {
    FACES = JSON.parse(fs.readFileSync(FACES_FILE, 'utf8').replace(/^\uFEFF/, ''))
    log('已加载 ' + Object.keys(FACES).length + ' 个表情')
  } catch (err) {
    FACES = {}
  }
}

/**
 * 把一句话拆成 OneBot 段。自带表情和表情包图片混在一条里也行：
 *   "好啊[表情] 呲牙[表情包] happy" → [文字, face, image]
 */
/* ---------- 实时语音合成（Breeze 常驻服务器） ---------- */
const TTS_URL = 'http://127.0.0.1:8137'
const VOICE_OUT = path.join(DIR, 'voice-out')

/**
 * 把这段文字用当前人设的音色合成出来，当语音发出去。
 *
 * 为什么用常驻服务器而不是 CLI：CLI 每次都要重新加载 3.17 GB 模型（约 15 秒），
 * 服务器只加载一次，之后每次只算推理。这台机器是核显，一条短句仍要 8-10 秒，
 * 所以语音没法做到秒回——但它说的是她自己那句话，不是预录的固定台词。
 */
/* TTS 服务器 --parallel 1：同时来两个请求第二个会 409。
   所以桥接这边排成队，一条一条来，而不是并发撞墙。 */
let ttsChain = Promise.resolve()

async function speakAsVoice(userId, text) {
  const run = () => speakAsVoiceNow(userId, text)
  const next = ttsChain.then(run, run)
  /* 链路不能因为一次失败就断掉 */
  ttsChain = next.then(() => {}, () => {})
  return next
}

async function speakAsVoiceNow(userId, text) {
  const s = globalThis.__qqpbStudio
  const id = s && s.activeId()
  const clean = String(text || '').replace(/\[[^\]]*\]/g, '').trim().slice(0, 60)
  if (!id || !clean) return false
  if (!socket || socket.readyState !== 1) return false

  const started = Date.now()
  try {
    const r = await fetch(TTS_URL + '/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'tts-1',
        input: clean,
        voice: { id },
        response_format: 'wav',
      }),
      signal: AbortSignal.timeout(120000),
    })
    if (!r.ok) {
      log('语音合成失败：HTTP ' + r.status)
      return false
    }
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 1000) {
      log('语音合成返回空音频')
      return false
    }
    fs.mkdirSync(VOICE_OUT, { recursive: true })
    const file = path.join(VOICE_OUT, Date.now() + '.wav')
    fs.writeFileSync(file, buf)
    socket.send(JSON.stringify({
      action: 'send_private_msg',
      params: {
        user_id: Number(userId),
        message: [{ type: 'record', data: { file: 'file:///' + file.replace(/\\/g, '/') } }],
      },
      echo: 'qqpb-voice-' + Date.now(),
    }))
    log('语音发出（' + clean.slice(0, 18) + '，' + ((Date.now() - started) / 1000).toFixed(1) + 's）')
    return true
  } catch (err) {
    log('语音合成失败：' + String((err && err.message) || err))
    return false
  }
}

function ttsHealthy() {
  return fetch(TTS_URL + '/health', { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false)
}

/* ---------- 人设的语音台词与表达保底 ---------- */
const EXPR_FILE = path.join(DIR, 'expression-state.json')

function personaVoiceFile(key) {
  try {
    const s = globalThis.__qqpbStudio
    const id = s && s.activeId()
    if (!id) return ''
    const k = String(key || '').replace(/[^a-zA-Z0-9_-]/g, '')
    if (!k) return ''
    const file = path.join(s.dirOf(id), 'lines', k + '.wav')
    return fs.existsSync(file) ? file : ''
  } catch (err) {
    return ''
  }
}

function activeExpression() {
  try {
    const s = globalThis.__qqpbStudio
    const id = s && s.activeId()
    if (!id) return {}
    const meta = s.get(id)
    return (meta && meta.expression) || {}
  } catch (err) {
    return {}
  }
}

function exprState() {
  try {
    return JSON.parse(fs.readFileSync(EXPR_FILE, 'utf8'))
  } catch (err) {
    return { sinceSticker: 0, sinceVoice: 0, total: 0 }
  }
}

function exprSave(s) {
  try {
    fs.writeFileSync(EXPR_FILE, JSON.stringify(s), 'utf8')
  } catch (err) { /* 忽略 */ }
}

/**
 * 保底：人设说"她大概每 7 条会甩个表情"，但模型不一定照着来。
 * 计数到了还没有，就替她补一个——表情和语音都没有"永远不发"这个选项。
 */
function applyExpressionFloor(text) {
  const st = exprState()
  st.total = (st.total || 0) + 1
  const pol = activeExpression()
  const hasSticker = /\[表情包\]|\[表情\]/.test(text)
  const hasVoice = /\[语音\]/.test(text)
  st.sinceSticker = hasSticker ? 0 : (st.sinceSticker || 0) + 1
  st.sinceVoice = hasVoice ? 0 : (st.sinceVoice || 0) + 1

  let out = String(text || '')
  const minS = Number(pol.stickerMinEvery) || 0
  const minV = Number(pol.voiceMinEvery) || 0

  if (!hasSticker && minS > 0 && st.sinceSticker >= minS) {
    out = out.trim() + ' [表情包]'
    st.sinceSticker = 0
    log('表情保底：连着 ' + minS + ' 条没发，补一个')
  }

  if (!hasVoice && minV > 0 && st.sinceVoice >= minV) {
    const s = globalThis.__qqpbStudio
    const id = s && s.activeId()
    const meta = id ? s.get(id) : null
    /* 保底发的是实时语音（她这句话本身），不是预录台词 */
    if (out.trim() && globalThis.__ttsReady !== false) {
      out = out.trim() + ' [语音]'
      st.sinceVoice = 0
      log('语音保底：连着 ' + minV + ' 条没发，补一条')
    }
  }

  exprSave(st)
  return out
}

function buildMessageSegments(text) {
  const segments = []
  const pattern = /\[表情\]\s*([^\s，。、,!！?？\[\]]+)|\[表情包\]\s*([^\s，。、,!！?？\[\]]*)|\[语音\]\s*([a-zA-Z0-9_-]+)/g
  let last = 0
  let match
  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(last, match.index).trim()
    if (before) segments.push({ type: 'text', data: { text: before } })

    if (match[1] !== undefined) {
      /* QQ 自带表情 */
      const name = match[1]
      const id = FACES[name]
      if (id !== undefined) segments.push({ type: 'face', data: { id: String(id) } })
      else segments.push({ type: 'text', data: { text: name } })
    } else if (match[2] !== undefined) {
      /* 外部表情包图片 */
      const tag = match[2]
      const file = pickDafeiyuSticker(tag) || pickSticker(tag)
      if (file) segments.push({ type: 'image', data: { file: 'file:///' + String(file).replace(/\\/g, '/') } })
      else if (tag) segments.push({ type: 'text', data: { text: tag } })
    } else if (match[3] !== undefined) {
      /* 旧写法 [语音] key：兼容保留，从台词库取现成文件。
         新写法是光写 [语音]，走实时合成，见 speakAsVoice。 */
      const voiceFile = personaVoiceFile(match[3])
      if (voiceFile) segments.push({ type: 'record', data: { file: 'file:///' + String(voiceFile).replace(/\\/g, '/') } })
      else log('台词库里没有 ' + match[3] + '，这条跳过')
    }
    last = match.index + match[0].length
  }
  const rest = text.slice(last).trim()
  if (rest) segments.push({ type: 'text', data: { text: rest } })
  return segments
}

/* 一分钟内最多发 6 条：防止她连着刷屏（AstrBot 那套的 reply_density_max_replies） */
const sentStamps = []
const RATE_WINDOW = 60000
const RATE_MAX = 6

function rateLimited() {
  const now = Date.now()
  while (sentStamps.length && now - sentStamps[0] > RATE_WINDOW) sentStamps.shift()
  return sentStamps.length >= RATE_MAX
}
function sendRich(userId, text, opts) {
  if (!socket || socket.readyState !== 1) {
    log('WS 未连接，消息没发出去：' + String(text).slice(0, 40))
    return false
  }
  if (rateLimited()) {
    log('一分钟内发太多了，这条先压住')
    return false
  }
  /* raw：已经在外面算过保底了，别再算一遍（拆气泡时会逐条调用） */
  const prepared = opts && opts.raw ? String(text) : applyExpressionFloor(text)
  const segments = buildMessageSegments(prepared)
  if (!segments.length) return false
  sentStamps.push(Date.now())
  socket.send(JSON.stringify({
    action: 'send_private_msg',
    params: { user_id: Number(userId), message: segments },
    echo: 'qqpb-rich-' + Date.now(),
  }))
  return true
}

/* 像人一样发：拆成 1~3 条，中间停一下 */
async function sendHuman(userId, text) {
  /* 保底按"一条回复"算一次，不能按气泡算——否则拆 3 条就数 3 次 */
  const prepared = applyExpressionFloor(text)

  /* [语音] 不带 key = 把这句话本身合成成语音发出去（实时 TTS，不是预录台词） */
  const voiceOnly = /\[语音\](?!\s*[a-zA-Z0-9_-]+)/.test(prepared)
  if (voiceOnly) {
    const spoken = prepared.replace(/\[语音\]\s*/g, ' ').replace(/\[表情包\]|\[表情\]\s*[^\s，。,!！?？]*/g, '').trim()
    if (spoken && (await speakAsVoice(userId, spoken))) return
    log('语音没发出去，退回打字')
  }

  const bubbles = toBubbles(detemplate(prepared.replace(/\[语音\]\s*[a-zA-Z0-9_-]*/g, '')))
  if (!bubbles.length) return
  for (let index = 0; index < bubbles.length; index += 1) {
    if (index > 0) {
      /* 按上一条的字数估打字时间：短句快、长句慢，像真人在敲 */
      const prev = String(bubbles[index - 1] || '')
      const typing = Math.min(1200 + prev.length * 30 + Math.random() * 600, 3500)
      await new Promise((resolve) => setTimeout(resolve, typing))
    }
    sendRich(userId, bubbles[index], { raw: true })
  }
}

async function runTask(task) {
  const { userId, text, display } = task
  runningTask.set(userId, task)
  /* 计时从真正开始跑算起：排队时间不算，否则还在队里就开始报进度 */
  const startedAt = Date.now()
  const prompt = await buildPrompt(userId, text)

  /* 不再强制她"说一句等着"：默认一句话都不垫，答完直接说。
     想要回旧的应声/进度，启动桥时设 QQPB_ACK=on。 */
  if (ACK_ON) {
    const line = await quickAck(text)
    if (line && !task.finished) send(userId, line)
  }

  let pinging = false
  let pings = 0
  const pinger = ACK_ON
    ? setInterval(async () => {
        if (task.finished || pinging || pings >= 5) return
        pings += 1
        pinging = true
        try {
          const line = await progressLine(text, Math.round((Date.now() - startedAt) / 1000))
          if (line && !task.finished) send(userId, line)
        } catch (err) {
          /* 进度只是锦上添花 */
        } finally {
          pinging = false
        }
      }, PROGRESS_MS)
    : null
  let result = await askModel(prompt)
  /* 上游过载/限流这类失败，隔一会儿重试一次；额度用完重试也没用 */
  if (!result.ok && isRetryable(result.text)) {
    log('上游过载，8 秒后重试一次')
    await new Promise((resolve) => setTimeout(resolve, 8000))
    if (!task.finished) result = await askModel(prompt)
  }
  if (pinger) clearInterval(pinger)

  /* 他这会儿还在打字：这次回答作废，把他的话攒起来一起答 */
  if (pendingExtra.has(userId)) {
    const extra = pendingExtra.get(userId) || []
    pendingExtra.delete(userId)
    runningTask.delete(userId)
    const mergedText = [text].concat(extra).join('\n')
    log('他还没说完，这次回答不发了；合并后重新想')
    dispatch({ userId, text: mergedText, display: (display || text), startedAt: Date.now(), finished: false })
    return
  }
  runningTask.delete(userId)

  /* 把混进正文的心里话切掉，再往下走 */
  const cleaned = limitInnerVoice(stripLeakedThinking(result.text))
  if (cleaned !== String(result.text || '').trim()) {
    log('正文里混了心里话，已切掉')
    result.text = cleaned
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  log((result.ok ? '完成' : '失败') + '（' + seconds + 's）：' + result.text.slice(0, 60))
  if (result.thinking) log('她的想法：' + result.thinking.replace(/\s+/g, ' ').slice(0, 140))
  task.finished = true

  /* 她可以选择不回：输出 [不回] 就什么都不发 */
  if (/^\[?不回\]?[。.！!]?$/.test(result.text.trim())) {
    log('她决定这条不回')
    runningTask.delete(userId)
    appendTranscript(display || text, '（没回）', result.thinking)
    return
  }

  /* 回答里写了 [图片] 路径 就把图发出去，文字里去掉这一行 */
  let answerText = result.text
  const imageLines = [...result.text.matchAll(/^[ \t]*\[图片\][ \t]*(.+?)[ \t]*$/gm)]
  for (const match of imageLines) {
    const file = match[1].trim()
    if (fs.existsSync(file)) {
      sendImage(userId, file)
      answerText = answerText.replace(match[0], '')
    } else {
      log('要发的图不存在：' + file)
    }
  }

  /* [表情包] 的标记要留着给 buildMessageSegments——它会把标记换成图片段，
     这样自带表情和表情包图片能混在同一条消息里。 */
  const stickerTags = [...result.text.matchAll(/\[表情包\][ \t]*([^\n]*)/g)]
  let sentSticker = false
  for (const match of stickerTags) {
    const tag = String(match[1] || '').trim()
    if (pickDafeiyuSticker(tag) || pickSticker(tag)) sentSticker = true
  }
  /* 她自己定的提醒：存下来，标记行不念给他听 */
  if (/^[ \t]*\[提醒\]/m.test(result.text)) {
    takeReminders(result.text)
    answerText = answerText.replace(/^[ \t]*\[提醒\][ \t]*.*\n?/gm, '').trim()
  }
  answerText = answerText.trim()
  const fallback = (imageLines.length || sentSticker) ? '' : result.text
  await sendHuman(userId, answerText || fallback)
  const history = historyFor(userId)
  history.push({ role: 'user', text })
  history.push({ role: 'assistant', text: result.text })
  while (history.length > HISTORY_TURNS * 2) history.shift()
  saveHistories()
  appendTranscript(display || text, displayAssistantText(result.text), result.thinking)

  /* 聊完了：过一分多钟她自己会想一次"接下来要说什么" */
  try { awakening?.scheduleSoon(75000) } catch (err) { /* 忽略 */ }
  runningTask.delete(userId)
}

/* 引用回复：图在被引用的那条消息里，得回查一次 get_msg */
function replyIdsOf(message) {
  if (!Array.isArray(message)) return []
  return message
    .filter((seg) => seg && seg.type === 'reply')
    .map((seg) => String((seg.data && seg.data.id) || ''))
    .filter(Boolean)
}

async function quotedImageUrls(message) {
  const urls = []
  for (const id of replyIdsOf(message).slice(0, 1)) {
    try {
      const result = await callAction('get_msg', { message_id: Number(id) })
      const quoted = result && result.ok && result.data && result.data.data
      if (quoted && Array.isArray(quoted.message)) {
        const found = imageUrlsOf(quoted.message)
        if (found.length) {
          log('从引用里找到 ' + found.length + ' 张图')
          urls.push(...found)
        }
      }
    } catch (err) { /* 取不到就当没有 */ }
  }
  return urls
}

/* ---------- 表情包收藏：他发过的表情存下来，之后能还给他 ---------- */
const STICKER_DIR = path.join(DIR, 'stickers')
const STICKER_INDEX = path.join(DIR, 'stickers.json')

function loadStickers() {
  try {
    const list = JSON.parse(fs.readFileSync(STICKER_INDEX, 'utf8').replace(/^\uFEFF/, ''))
    return Array.isArray(list) ? list : []
  } catch (err) {
    return []
  }
}

function saveSticker(file) {
  try {
    fs.mkdirSync(STICKER_DIR, { recursive: true })
    const ext = path.extname(file) || '.jpg'
    const target = path.join(STICKER_DIR, 'sticker-' + Date.now() + ext)
    fs.copyFileSync(file, target)
    const list = loadStickers()
    list.push({ file: target, addedAt: new Date().toISOString() })
    fs.writeFileSync(STICKER_INDEX, JSON.stringify(list.slice(-200), null, 2), 'utf8')
    log('收下一个表情包（共 ' + Math.min(list.length, 200) + ' 个）')
    return target
  } catch (err) {
    log('存表情包失败：' + String((err && err.message) || err))
    return ''
  }
}

/**
 * 挑一张表情包。只认"刚才那张"——也就是他上一条发的那张。
 * 不再随机挑：随机挑出来的表情跟当下的情绪没关系，那是掷骰子，不是人设。
 */
/* 表情包库：按情绪分的 15 类（来自 blue-fat-fish-meme-pack） */
const STICKER_TAGS = ['happy', 'angry', 'confused', 'sad', 'surprised', 'shy', 'sleep',
  'food', 'money', 'greeting', 'work', 'entertainment', 'teasing', 'reply', 'affection']

function pickDafeiyuSticker(tag) {
  try {
    const dir = path.join(DIR, 'stickers', 'dafeiyu')
    const all = fs.readdirSync(dir).filter((f) => /\.(gif|png|jpe?g|webp)$/i.test(f))
    if (!all.length) return ''
    const matched = tag ? all.filter((f) => f.startsWith(tag + '-')) : []
    const pool = matched.length ? matched : all
    return path.join(dir, pool[Math.floor(Math.random() * pool.length)])
  } catch (err) {
    return ''
  }
}
function pickSticker(keyword) {
  const list = loadStickers()
  if (!list.length) return ''
  const key = String(keyword || '').trim()
  /* 先看是不是 15 个情绪标签之一 */
  if (STICKER_TAGS.includes(key)) {
    const packed = pickDafeiyuSticker(key)
    if (packed) return packed
  }
  if (key === '刚才' || key === '最近' || key === '') return list[list.length - 1].file
  if (/^(随机|随便|任意|挑一张|任意一张)$/.test(key)) return list[Math.floor(Math.random() * list.length)].file
  const num = Number(key)
  if (Number.isInteger(num) && num >= 1 && num <= list.length) return list[num - 1].file
  const hit = list.find((item) => path.basename(item.file).includes(key))
  return hit ? hit.file : list[Math.floor(Math.random() * list.length)].file
}

/** 哪些图片是"表情包"（NapCat 用 summary/sub_type 标出来） */
function stickerUrlSet(message) {
  const set = new Set()
  if (!Array.isArray(message)) return set
  for (const seg of message) {
    if (!seg || seg.type !== 'image') continue
    const data = seg.data || {}
    const isSticker = String(data.summary || '').includes('动画表情') || Number(data.sub_type) === 1
    if (isSticker && typeof data.url === 'string') set.add(data.url)
  }
  return set
}
/* 把消息里的图片段落挑出来。NapCat 一般给 url（可直接下）和 file（本地缓存名）。 */
function imageUrlsOf(message) {
  if (!Array.isArray(message)) return []
  const urls = []
  for (const seg of message) {
    if (!seg || seg.type !== 'image') continue
    const data = seg.data || {}
    const url = typeof data.url === 'string' ? data.url : ''
    if (url.startsWith('http')) urls.push(url)
    else if (typeof data.file === 'string' && fs.existsSync(data.file)) urls.push('file://' + data.file)
  }
  return urls.slice(0, 3)
}

async function downloadImage(url, userId) {
  try {
    const dir = path.join(DIR, 'inbox')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 6)
    if (url.startsWith('file://')) {
      const source = url.slice(7)
      const ext = path.extname(source) || '.png'
      const target = path.join(dir, userId + '-' + stamp + ext)
      fs.copyFileSync(source, target)
      return target
    }
    const response = await fetch(url)
    if (!response.ok) return ''
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length || buffer.length > 8 * 1024 * 1024) return ''
    /* 保留真实格式：动图要按 .gif 存，后面才知道要抽帧 */
    const type = String(response.headers.get('content-type') || '')
    const ext = type.includes('gif') ? '.gif' : type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg'
    const target = path.join(dir, userId + '-' + stamp + ext)
    fs.writeFileSync(target, buffer)
    return target
  } catch (err) {
    log('图片下载失败：' + String((err && err.message) || err))
    return ''
  }
}

/* 动图抽帧：直接复用 tools/gif-frames.mjs，输出每帧绝对路径 */
async function gifFrames(file) {
  try {
    const script = resolveTool(config.gifFramesTool)
    const result = await runScript([script, file, '--fps', '3', '--width', '640'], 90000, DIR)
    const frames = String(result.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /\.png$/i.test(line) && fs.existsSync(line))
    if (frames.length) log('动图抽帧：' + frames.length + ' 帧')
    return frames
  } catch (err) {
    log('抽帧失败：' + String((err && err.message) || err))
    return []
  }
}

/* ---------- OCR：桥不在沙箱里，可以正常起子进程 ---------- */
const OCR_ENGINE = 'D:\\Tools\\Umi-OCR\\app\\Umi-OCR_Paddle_v2.1.5\\UmiOCR-data\\plugins\\win7_x64_PaddleOCR-json'

function ocrImage(file) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(path.join(OCR_ENGINE, 'PaddleOCR-json.exe'), [], {
        cwd: OCR_ENGINE,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      })
    } catch (err) {
      return resolve('')
    }

    let buffer = ''
    let sent = false
    let settled = false
    const finish = (text) => {
      if (settled) return
      settled = true
      try { child.kill() } catch (err) { /* 已退出 */ }
      resolve(text)
    }
    /* OCR 只是锦上添花：8 秒没结果就跳过，别让它拖住收消息 */
    const timer = setTimeout(() => { log('OCR 超时，跳过'); finish('') }, 8000)

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (!sent && buffer.includes('OCR init completed.')) {
        sent = true
        buffer = buffer.slice(buffer.indexOf('OCR init completed.') + 'OCR init completed.'.length)
        child.stdin.write(JSON.stringify({ image_path: file }) + '\n')
      }
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('{')) {
          try {
            const parsed = JSON.parse(line)
            if (parsed.code === 100) {
              clearTimeout(timer)
              return finish((parsed.data || []).map((item) => item.text).filter(Boolean).join('\n'))
            }
          } catch (err) { /* 不是结果行 */ }
        }
        newline = buffer.indexOf('\n')
      }
    })
    child.on('error', () => finish(''))
    child.on('exit', () => finish(''))
  })
}

/* ---------- 自主唤醒：想不想找他说话，由状态决定，不由钟点决定 ---------- */
const AWAKE_ON = String(env('QQPB_AWAKE') || 'on').toLowerCase() !== 'off'
let awakening = null

function recentLines() {
  const allow = loadAllow()
  const userId = allow[0] || ''
  const list = histories.get(userId) || []
  const body = list.slice(-8).map((item) => (item.role === 'user' ? '他：' : '你：') + item.text).join('\n')
  /* 主动开口时更容易翻旧账：她看不到新话题，就会把上午的事再拿出来说一遍 */
  const reused = overusedPhrases(list)
  const warn = reused.length
    ? '\n\n（你自己注意：最近反复提到「' + reused.join('」「') + '」，这次别提它们，也别绕回同一个事）'
    : ''
  return body + warn
}

function startAwakening() {
  try {
    awakening = createAwakening({
      dir: DIR,
      log: (line) => log(line, 'awake'),
      chat: currentChat(),
      recent: recentLines,
      onRemember: rememberFromThought,
      /* 主动开口时用什么去检索记忆：他最后说的那句话 */
      memories: () => {
        const allow = loadAllow()
        const uid = allow[0] || ''
        const list = histories.get(uid) || []
        const lastUser = [...list].reverse().find((x) => x.role === 'user')
        return recallBlock(lastUser ? lastUser.text : '')
      },
      send: (text) => {
        const allow = loadAllow()
        const userId = allow[0] || ''
        return userId ? sendRich(userId, text) : false
      },
    })
    /* 人设工坊：生成 / 切换 / 音色 / 台词库 */
    const studio = createStudio({
      dir: DIR,
      log: (line) => log(line),
      chat: () => currentChat(),
    })
    globalThis.__qqpbStudio = studio
    /* 记忆服务：和 TTS 一样是常驻的，没在跑就拉起来。
       它挂了不影响对话（recallBlock 会返回空），但记忆就读不到了。 */
    fetch(MEM_URL + '/health', { signal: AbortSignal.timeout(2500) })
      .then((r) => log(r.ok ? '记忆服务就绪' : '记忆服务异常'))
      .catch(() => {
        log('记忆服务没在跑，正在拉起')
        try {
          spawn('cmd', ['/c', 'start', '', resolveTool(config.memoryStartCmd)], {
            detached: true, stdio: 'ignore', windowsHide: true,
          }).unref()
        } catch (err) {
          log('拉起记忆服务失败：' + String((err && err.message) || err))
        }
      })

    /* TTS 服务器：常驻一次，之后每条语音只算推理不再加载模型。
       没在跑就悄悄拉起来（启动要 70 秒，这段时间她会先用文字）。 */
    ttsHealthy().then((ok) => {
      if (ok) {
        log('TTS 服务器就绪（实时语音可用）')
        globalThis.__ttsReady = true
      } else {
        globalThis.__ttsReady = false
        log('TTS 服务器没在跑，正在拉起（约 70 秒，期间语音会退回文字）')
        try {
          spawn('cmd', ['/c', 'start', '', path.join(DIR, 'start-tts.bat')], {
            detached: true, stdio: 'ignore', windowsHide: true,
          }).unref()
        } catch (err) {
          log('拉起 TTS 失败：' + String((err && err.message) || err))
        }
        setTimeout(() => {
          ttsHealthy().then((up) => {
            globalThis.__ttsReady = up
            log(up ? 'TTS 服务器已就绪' : 'TTS 服务器还是没起来，语音会退回文字')
          })
        }, 90000)
      }
    })

    const activePersona = studio.activeId()
    if (activePersona && studio.applyPersona(activePersona)) {
      log('当前人设：' + activePersona + '（已写入 persona-extra.md）')
    } else {
      log('没有激活的人设，走 profile 里的 personaPrefix')
    }

    setInterval(() => {
      try { awakening.loop() } catch (err) { /* 忽略 */ }
      distillIfDue().catch(() => {})
      fireDueReminders().catch(() => {})
      updateVoiceProfile().catch(() => {})
    }, 60000)
    log('自主唤醒已开启（' + JSON.stringify(awakening.status().drives) + '）')
  } catch (err) {
    log('自主唤醒启动失败：' + String((err && err.message) || err))
  }
}
function connect() {
  log('连接 NapCat：' + NAPCAT_WS)
  socket = new WebSocket(NAPCAT_WS)

  socket.addEventListener('open', () => log('已连上 NapCat，等待私信'))

  socket.addEventListener('message', async (event) => {
    let payload
    try {
      payload = JSON.parse(String(event.data))
    } catch (err) {
      return
    }
    if (payload.post_type === 'message') {
      lastEventAt = Date.now()
      if (payload.message_type === 'private') lastPrivateAt = Date.now()
    }

    /* 先看是不是我们在等的那条接口回包 */
    if (payload.echo && pendingActions.has(payload.echo)) {
      const pending = pendingActions.get(payload.echo)
      pendingActions.delete(payload.echo)
      clearTimeout(pending.timer)
      return pending.resolve({ ok: true, data: payload })
    }
    if (payload.post_type !== 'message' || payload.message_type !== 'private') return
    if (String(payload.user_id) === String(payload.self_id)) return

    const userId = String(payload.user_id)
    const rawText = textOf(payload.message)
    const imageUrls = imageUrlsOf(payload.message)
    imageUrls.push(...(await quotedImageUrls(payload.message)))

    /* 图片：先落到本地，再把路径写进问题里，让 headless 自己 read_image */
    const saved = []
    const ocrTexts = []
    const framePaths = []
    const stickerFiles = []
    const stickerUrls = stickerUrlSet(payload.message)
    for (const url of imageUrls) {
      const file = await downloadImage(url, userId)
      if (!file) continue
      const sticker = stickerUrls.has(url)
      if (sticker) { saveSticker(file); stickerFiles.push(file) }
      saved.push(file)
      /* 沙箱里她自己起不了子进程，所以 OCR 和抽帧都由桥来做 */
      /* 表情包不用 OCR（它没文字） */
      if (!sticker) {
        const got = await ocrImage(file)
        if (got.trim()) ocrTexts.push(got.trim().slice(0, 2000))
      }
      /* 动图一律抽帧，表情包也一样——她想看动作就看，不想看就只看首帧 */
      if (/\.(gif|webp)$/i.test(file)) framePaths.push(...(await gifFrames(file)))
    }

    const text = [
      rawText,
      saved.length ? '（用户发了图片：' + saved.join('、') + '）' : '',
      stickerFiles.length ? '（他发的是表情包，文件在 ' + stickerFiles.join('、') + '。想看内容就 read_image；想发回去就写 [图片] 路径；想说话就说话。怎么回你自己定）' : '',
      ocrTexts.length ? '（图片文字，OCR 结果）：\n' + ocrTexts.join('\n---\n') : '',
      framePaths.length
        ? '（这是动图，桥按时间顺序抽了 ' + framePaths.length + ' 帧，逐帧 read_image 看变化）：\n' +
          framePaths.join('\n')
        : '',
      saved.length ? '要读字用上面的 OCR 结果就够了；要看画面内容再 read_image。' : '',
    ]
      .filter(Boolean)
      .join('\n')

    if (!text) return

    if (!isAllowedPrivate(userId)) {
      log('忽略非白名单私信：' + userId)
      return
    }

    log('收到 ' + userId + '：' + text.slice(0, 60))
    try { awakening?.noteUserMessage() } catch (err) { /* 忽略 */ }

    /* 攒一小会儿：连发的几句合成一次提问 */
    const entry = merged.get(userId) || { texts: [], displays: [], timer: null }
    entry.texts.push(text)
    entry.displays.push(displayUserText(rawText, saved.length, stickerFiles.length))
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      merged.delete(userId)
      const combined = entry.texts.join('\n')
      /* 存给页面看的版本：只有他的话，没有路径和指令 */
      const displayCombined = entry.displays.filter(Boolean).join(' ')

      /* 他还在说话的样子：不打断当前回合，先攒着 */
      if (runningTask.has(userId)) {
        const extra = pendingExtra.get(userId) || []
        extra.push(combined)
        pendingExtra.set(userId, extra)
        log('他接着说了一句，先攒着（当前回合跑完再一起答）')
        return
      }

      log('合并成一条（' + entry.texts.length + ' 句）：' + displayCombined.slice(0, 60))
      const task = { userId, text: combined, display: displayCombined, startedAt: Date.now(), finished: false }
      /* 注意：这里不再应声。排队时就说"嗯"是骗人——应答挪到真正开始跑的时候。 */
      dispatch(task)
    }, MERGE_MS)
    merged.set(userId, entry)
  })

  socket.addEventListener('close', () => {
    log('NapCat 断开，5 秒后重连')
    setTimeout(connect, 5000)
  })

  socket.addEventListener('error', () => {
    /* 端口没监听时也会走到这里，别让它看起来像"连上又断开" */
    log('连不上 NapCat（它可能没启动，端口 ' + NAPCAT_WS + '）')
  })
}

/* ---------- NapCat 登录：取二维码 / 查状态 / 拉起进程 ---------- */
/* 2026-11-02：QQ 现在跑在 Docker 容器里，NapCat 的配置和二维码都在 <napcat-data> 里。
   原来指向另一套 Windows 版，已经没有在用了。 */
const NAPCAT_WEBUI = resolveTool(config.napcatWebuiConfig)
const NAPCAT_WEBUI_PORT = 6099
/* NapCat 把当前二维码写在这里，两分钟一换 */
const NAPCAT_QR_FILE = resolveTool(config.napcatQrFile)
const NAPCAT_BAT = resolveTool(config.napcatStartCmd)

function readWebui() {
  try {
    const cfg = JSON.parse(fs.readFileSync(NAPCAT_WEBUI, 'utf8'))
    /* 容器内部的 6099 映射到宿主 16088，别直接用 cfg.port */
    return { base: 'http://127.0.0.1:' + NAPCAT_WEBUI_PORT, token: cfg.token || '' }
  } catch (err) {
    return null
  }
}

async function napcatApi(route) {
  const ui = readWebui()
  if (!ui) return { ok: false, reason: '读不到 NapCat webui.json' }
  try {
    const response = await fetch(ui.base + '/api' + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ui.token },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) return { ok: false, reason: 'NapCat 返回 HTTP ' + response.status }
    return { ok: true, data: await response.json() }
  } catch (err) {
    return { ok: false, reason: '连不上 NapCat WebUI（' + String((err && err.message) || err) + '）' }
  }
}

/* 用 VBS 包一层启动：NapCat 会自己开控制台窗口，直接 spawn 藏不住。
   VBS 的 Run(..., 0, False) 是唯一稳定不弹窗的办法。 */
const NAPCAT_VBS = resolveTool(config.napcatStartVbs)

/* 拉起 Windows 版 NapCat（隐藏窗口）。用 VBS 包一层是因为 NapCat 会自己开控制台窗口。 */
function startNapCat() {
  try {
    const child = spawn('wscript.exe', ['//nologo', NAPCAT_VBS], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: resolveTool(config.napcatWorkDir) || undefined,
    })
    child.unref()
    log('已尝试启动 NapCat（隐藏窗口）')
    return true
  } catch (err) {
    log('启动 NapCat 失败：' + String((err && err.message) || err))
    return false
  }
}

/* 2026-11-02 切回 Windows 版 NapCat：
   - 登录态持久化，重启不用重新扫码
   - 不依赖 Docker Desktop（它今天自己停了两次）
   代价：小号以隐藏进程形式跑在这台电脑上。 */

function napcatUp() {
  return new Promise((resolve) => {
    const sock = net.connect({ port: 36199, host: '127.0.0.1' })
    let done = false
    const fin = (v) => { if (done) return; done = true; try { sock.destroy() } catch (e) {} resolve(v) }
    sock.setTimeout(1500)
    sock.once('connect', () => fin(true))
    sock.once('timeout', () => fin(false))
    sock.once('error', () => fin(false))
  })
}

async function napcatState() {
  return (await napcatUp()) ? 'running' : 'stopped'
}

/* ---------- 看门狗：NapCat 掉了自己拉，拉不起来就通知他 ---------- */
const NAPCAT_PORT = 36199
const WATCHDOG = {
  /* 2026-11-02 关闭：QQ 现在跑在 Docker 容器里（NapCat），
     容器由 --restart unless-stopped 自己保活。
     看门狗会去拉起 Windows 版 NapCat，
     两个 NapCat 抢同一个 QQ 号会互相顶号，导致两边都掉线。
     要恢复旧行为就改回 true，并同时停掉 Docker 容器。 */
  enabled: true,
  downStreak: 0,
  lastCheckAt: 0,
  lastStartAt: 0,
  lastNotifyAt: 0,
  restarts: 0,
  note: '',
}

function portOpen(port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      try { sock.destroy() } catch (err) { /* 忽略 */ }
      resolve(v)
    }
    sock.setTimeout(timeoutMs || 1500)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

/** 拉不起来时给他发一条 QQ —— 扫码这种事只能他来 */
function notifyNapcatDown() {
  const now = Date.now()
  if (now - WATCHDOG.lastNotifyAt < 30 * 60 * 1000) return
  WATCHDOG.lastNotifyAt = now
  const allow = loadAllow()
  const target = allow[0]
  if (!target) return
  try {
    sendRich(target, 'NapCat 掉了，自动重启也没起来。要你在电脑上扫一次码才能恢复。')
    WATCHDOG.note = '已通知他扫码'
    log('看门狗：已通知他 NapCat 掉线需要扫码')
  } catch (err) {
    log('看门狗：通知失败 ' + String((err && err.message) || err))
  }
}

async function watchdogTick() {
  if (!WATCHDOG.enabled) return
  WATCHDOG.lastCheckAt = Date.now()
  const up = await portOpen(NAPCAT_PORT)
  if (up) {
    if (WATCHDOG.downStreak >= 3) log('看门狗：NapCat 已恢复')
    WATCHDOG.downStreak = 0
    WATCHDOG.note = ''
    return
  }

  WATCHDOG.downStreak += 1
  /* 连续三次检查（约 1 分钟）都不通，才认为真掉了 */
  if (WATCHDOG.downStreak < 3) return

  const sinceStart = Date.now() - WATCHDOG.lastStartAt
  if (sinceStart < 4 * 60 * 1000) {
    /* 刚拉过，先给它时间起来；三分钟还没起就通知 */
    WATCHDOG.note = '已自动拉起，等待登录'
    if (sinceStart > 3 * 60 * 1000) notifyNapcatDown()
    return
  }

  WATCHDOG.lastStartAt = Date.now()
  WATCHDOG.restarts += 1
  WATCHDOG.note = 'NapCat 掉线，正在自动拉起'
  log('看门狗：NapCat 掉线（连续 ' + WATCHDOG.downStreak + ' 次检查），自动拉起（第 ' + WATCHDOG.restarts + ' 次）')
  startNapCat()
}

function watchdogStatus() {
  return {
    enabled: WATCHDOG.enabled,
    downStreak: WATCHDOG.downStreak,
    restarts: WATCHDOG.restarts,
    note: WATCHDOG.note || '',
    lastCheckSec: WATCHDOG.lastCheckAt ? Math.round((Date.now() - WATCHDOG.lastCheckAt) / 1000) : -1,
    lastStartSec: WATCHDOG.lastStartAt ? Math.round((Date.now() - WATCHDOG.lastStartAt) / 1000) : -1,
  }
}

/* ---------- 模型切换：只改 profile 里那一行 ---------- */
const MODELS_FILE = path.join(DIR, 'models.json')
const PROFILE_FILE = resolveTool(config.dshProfile)
const PROVIDERS_FILE = path.join(DIR, 'providers.json')

function readProviders() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    return []
  }
}

function writeProviders(list) {
  try {
    fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(list, null, 2), 'utf8')
    return true
  } catch (err) {
    log('写 providers.json 失败：' + String((err && err.message) || err))
    return false
  }
}

function providerEnvName(entry) {
  return entry.keyEnv || 'QQPB_KEY_' + String(entry.id || '').toUpperCase()
}

/**
 * 找 API key。
 *
 * 环境变量优先；没有就去 ~/.dsh/.credentials.yaml 里翻。
 * 老的 AYAN_KEY_XXX 也要认 —— 项目早期用过那个前缀，
 * 直接砍掉会让别人已经配好的 key 静默失效（读不到，报的是额度不足，
 * 跟 key 没关系，很难查）。
 */
function legacyKeyName(name) {
  return name.replace(/^QQPB_/, 'AYAN_')
}

/** 由 providers.json 生成 YAML，替换 profile 里两个标记之间的内容。 */
function regenerateProviders(list) {
  try {
    const text = fs.readFileSync(PROFILE_FILE, 'utf8')
    const pattern = /(          # >>> qqpb:providers:start\n)[\s\S]*?(          # <<< qqpb:providers:end)/
    if (!pattern.test(text)) {
      log('profile 里没有 providers 标记，跳过重建')
      return false
    }
    const lines = ['          # >>> qqpb:providers:start']
    for (const entry of list) {
      lines.push('          ' + entry.id + ':')
      lines.push('            displayName: ' + JSON.stringify(entry.name || entry.id))
      lines.push('            apiKeyEnv: ' + providerEnvName(entry))
      lines.push('            api: openai-completions')
      lines.push('            baseURL: ' + JSON.stringify(entry.baseURL))
      lines.push('            models:')
      lines.push('              - id: ' + JSON.stringify(entry.model))
      lines.push('                name: ' + JSON.stringify(entry.model))
      if (entry.vision !== false) {
        lines.push('                input:')
        lines.push('                  - text')
        lines.push('                  - image')
      }
      if (entry.reasoning) {
        lines.push('                reasoningEfforts:')
        lines.push('                  off: null')
        lines.push('                  low: low')
        lines.push('                  medium: medium')
        lines.push('                  high: high')
        lines.push('                  xhigh: xhigh')
        lines.push('                  max: max')
      }
      if (entry.contextWindow) lines.push('                contextWindow: ' + entry.contextWindow)
      if (entry.maxTokens) lines.push('                maxTokens: ' + entry.maxTokens)
    }
    lines.push('          # <<< qqpb:providers:end')
    fs.copyFileSync(PROFILE_FILE, PROFILE_FILE + '.bak-' + Date.now())
    fs.writeFileSync(PROFILE_FILE, text.replace(pattern, lines.join('\n')), 'utf8')
    log('已按 providers.json 重建 providers 段（' + list.length + ' 个）')
    return true
  } catch (err) {
    log('重建 providers 失败：' + String((err && err.message) || err))
    return false
  }
}

const DEFAULT_MODELS = {
  current: { provider: 'tokenav', model: 'deepseek-v4.1-flash-1017' },
  options: [
    { provider: 'tokenav', model: 'deepseek-v4.1-flash-1017', label: '77AI · deepseek-v4.1-flash-1017（支持看图）' },
    { provider: 'wdapi', model: 'deepseek-v4.1-flash', label: 'wdapi · deepseek-v4.1-flash（支持看图）' },
    { provider: 'keketoken', model: 'deepseek-v4.1-flash', label: 'new api · deepseek-v4.1-flash' },
  ],
}

function readModels() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'))
    if (parsed && parsed.current && Array.isArray(parsed.options) && parsed.options.length) return parsed
    return DEFAULT_MODELS
  } catch (err) {
    return DEFAULT_MODELS
  }
}

function writeModels(data) {
  try {
    fs.writeFileSync(MODELS_FILE, JSON.stringify(data, null, 2), 'utf8')
  } catch (err) {
    log('写 models.json 失败：' + String((err && err.message) || err))
  }
}

function applyModel(provider, model) {
  try {
    const text = fs.readFileSync(PROFILE_FILE, 'utf8')
    const pattern = /(- id: agent-default-model\r?\n  config:\r?\n    provider: )([^\r\n]+)(\r?\n    model: )([^\r\n]+)/
    if (!pattern.test(text)) {
      log('没找到 agent-default-model 块，切换失败')
      return false
    }
    fs.copyFileSync(PROFILE_FILE, PROFILE_FILE + '.bak-' + Date.now())
    const next = text.replace(pattern, (whole, head, _p, mid, _m) => head + provider + mid + JSON.stringify(model))
    fs.writeFileSync(PROFILE_FILE, next, 'utf8')
    log('模型已切到 ' + provider + ' / ' + model)
    return true
  } catch (err) {
    log('切换模型失败：' + String((err && err.message) || err))
    return false
  }
}

function renderPage() {
  const data = readModels()
  const rows = data.options
    .map((option) => {
      const value = option.provider + '|' + option.model
      const selected =
        option.provider === data.current.provider && option.model === data.current.model ? ' selected' : ''
      return '<option value="' + value + '"' + selected + '>' + option.label + '</option>'
    })
    .join('')
  return (
    '<!doctype html><html lang="zh"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>模型选择</title><style>' +
    'body{font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif;background:#f6f6f7;color:#1c1c1e;margin:0;padding:40px 20px}' +
    '.card{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e5ea;border-radius:14px;padding:24px}' +
    'h1{font-size:17px;margin:0 0 4px}p.sub{margin:0 0 20px;color:#8e8e93;font-size:13px}' +
    'select,input{width:100%;box-sizing:border-box;padding:11px;border:1px solid #d1d1d6;border-radius:9px;font:inherit;background:#fff}' +
    'input{margin-top:10px}' +
    'button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:9px;background:#0a84ff;color:#fff;font:inherit;font-weight:600}' +
    '#msg{margin-top:12px;font-size:13px;color:#8e8e93;min-height:20px}' +
    '</style></head><body><div class="card">' +
    '<h1>用哪个模型</h1>' +
    '<p class="sub">改完对下一条 QQ 消息生效，不用重启。</p>' +
    '<select id="pick">' + rows + '</select>' +
    '<button id="save">保存</button><div id="msg"></div>' +
    '<hr style="margin:22px 0;border:0;border-top:1px solid #eee">' +
    '<h1 style="font-size:15px">添加一个 API</h1>' +
    '<p class="sub">填完保存，它会出现在上面的下拉框里。</p>' +
    '<input id="pName" placeholder="名字，例如 某某 API">' +
    '<input id="pBase" placeholder="baseURL，例如 https://api.xxx.com/v1">' +
    '<input id="pModel" placeholder="模型 id，例如 deepseek-v4.1-flash">' +
    '<input id="pKey" placeholder="API Key" type="password">' +
    '<button id="add">添加</button><div id="msg2"></div>' +
    '<hr style="margin:22px 0;border:0;border-top:1px solid #eee">' +
    '<h1 style="font-size:15px">QQ 登录</h1>' +
    '<p class="sub" id="qqStatus">检查中…</p>' +
    '<div id="qrBox" style="display:none;text-align:center;margin:12px 0">' +
    '<img id="qrImg" style="width:220px;height:220px;border-radius:10px"></div>' +
    '<button id="startBtn" style="background:#34c759">启动 NapCat</button>' +
    '<button id="qrBtn">获取二维码</button>' +
    '<hr style="margin:22px 0;border:0;border-top:1px solid #eee">' +
    '<h1 style="font-size:15px">她在想什么</h1>' +
    '<p class="sub" id="awakeHint">读状态中…</p>' +
    '<div id="awakeDrives"></div>' +
    '<div id="awakeThoughts" style="margin-top:14px"></div>' +
    '<hr style="margin:22px 0;border:0;border-top:1px solid #eee">' +
    '<h1 style="font-size:15px">对话记录</h1>' +
    '<p class="sub">完整原文，不截断；15 秒刷新</p>' +
    '<div id="chatLog" style="max-height:420px;overflow:auto"></div>' +
    '<hr style="margin:22px 0;border:0;border-top:1px solid #eee">' +
    '<h1 style="font-size:15px">运行日志</h1>' +
    '<p class="sub">最近 200 条，按类型上色：蓝=收到　绿=完成　红=失败　紫=自主　橙=任务</p>' +
    '<div id="logBox" style="max-height:380px;overflow:auto;background:#1c1c1e;' +
    'font:12px/1.55 Consolas,monospace;padding:12px;border-radius:10px;margin:0"></div>' +
    '</div><script>' +
    'document.getElementById("save").onclick=async()=>{' +
    'const v=document.getElementById("pick").value.split("|");' +
    'const r=await fetch("/model",{method:"POST",headers:{"content-type":"application/json"},' +
    'body:JSON.stringify({provider:v[0],model:v[1]})});' +
    'const j=await r.json();' +
    'document.getElementById("msg").textContent=j.ok?"已切换，下一条消息生效":"切换失败，看 bridge.log";' +
    '};' +
    'document.getElementById("add").onclick=async()=>{' +
    'const body={name:pName.value,baseURL:pBase.value,model:pModel.value,key:pKey.value};' +
    'const r=await fetch("/provider",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});' +
    'const j=await r.json();' +
    'document.getElementById("msg2").textContent=j.ok?("已添加 "+j.provider+"，正在刷新"):("失败："+(j.reason||"看 bridge.log"));' +
    'if(j.ok) setTimeout(()=>location.reload(),900);' +
    '};' +
    'const qqStatus=document.getElementById("qqStatus");' +
    'const qrBox=document.getElementById("qrBox");' +
    'async function pollLogin(){' +
    'try{const r=await fetch("/login-status");const j=await r.json();' +
    'if(!j.ok){qqStatus.textContent="NapCat 没在跑："+(j.reason||"点下面的启动按钮");return}' +
    'const d=j.data&&j.data.data?j.data.data:{};' +
    'qqStatus.textContent=d.isLogin?("已登录："+(d.uin||"")):"未登录 —— 点“获取二维码”";' +
    '}catch(e){qqStatus.textContent="连不上本地服务"}}' +
    'document.getElementById("startBtn").onclick=async()=>{' +
    'qqStatus.textContent="正在启动 NapCat…（可能要十几秒）";' +
    'await fetch("/start-napcat",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});' +
    'setTimeout(pollLogin,12000);' +
    '};' +
    'document.getElementById("qrBtn").onclick=async()=>{' +
    'qqStatus.textContent="正在取二维码…";' +
    'const r=await fetch("/qr");const j=await r.json();' +
    'if(j.ok){const src=j.qr.startsWith("data:")?j.qr:("data:image/png;base64,"+j.qr);' +
    'document.getElementById("qrImg").src=src;qrBox.style.display="block";qqStatus.textContent="用手机 QQ 扫这个码";}' +
    'else{qqStatus.textContent="拿不到二维码："+(j.reason||"NapCat 没起来")}' +
    '};' +
    'pollLogin();setInterval(pollLogin,5000);' +
    'const LABEL={miss:"思念",curious:"好奇",share:"想分享",tired:"疲惫"};' +
    'function esc(s){return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))}' +
    'async function pollAwake(){' +
    'try{const r=await fetch("/awake");const j=await r.json();' +
    'if(!j.ok){document.getElementById("awakeHint").textContent="自主唤醒没开";return}' +
    'const s=j.status,d=s.drives||{};' +
    'const modeLabel=(s.mode==="followup")?("接话窗口"+(s.followupCount?("（已补 "+s.followupCount+" 次）"):"")):"等待下次主动联系";' +
    'document.getElementById("awakeHint").textContent=modeLabel+"　下次醒来："+s.nextWakeAt+"　上次开口："+s.lastSpokeAt;' +
    'document.getElementById("awakeDrives").innerHTML=Object.keys(LABEL).map(k=>{' +
    'const v=Math.max(0,Math.min(1,Number(d[k])||0));' +
    'return "<div style=\\"margin:5px 0\\"><span style=\\"display:inline-block;width:56px;color:#8e8e93;font-size:12px\\">"+LABEL[k]+"</span>"+' +
    '"<span style=\\"display:inline-block;width:140px;height:6px;background:#eee;border-radius:3px;vertical-align:middle\\">"+' +
    '"<span style=\\"display:block;width:"+Math.round(v*100)+"%;height:6px;background:#0a84ff;border-radius:3px\\"></span></span>"+' +
    '"<span style=\\"margin-left:8px;font-size:12px;color:#8e8e93\\">"+v.toFixed(2)+"</span></div>"}).join("");' +
    'const list=(s.history||[]).slice().reverse();' +
    'function rowHtml(t){' +
    'var dd=t.drives||{};' +
    'var bars="思"+Math.round((dd.miss||0)*100)+" 好"+Math.round((dd.curious||0)*100)+" 说"+Math.round((dd.share||0)*100)+" 累"+Math.round((dd.tired||0)*100);' +
    'var color=t.spoke?"#34c759":"#c7c7cc";' +
    'var verdict=t.spoke?"说了":("没说"+(t.reason?("（"+t.reason+"）"):""));' +
    'var out="<div style=\\"display:flex;gap:10px;padding:9px 0;border-bottom:1px solid #f0f0f2\\">";' +
    'out+="<div style=\\"flex:0 0 42px;color:#8e8e93;font-size:12px;padding-top:2px\\">"+(t.atLocal||String(t.at||"").slice(11,16))+"</div>";' +
    'out+="<div style=\\"flex:1;min-width:0\\">";' +
    'out+="<div style=\\"font-size:12px;color:#8e8e93\\">"+bars+" 冲动 "+(Number(t.urge)||0).toFixed(2)+" <span style=\\"color:"+color+"\\">"+verdict+"</span></div>";' +
    'out+="<div style=\\"font-size:13px;margin-top:2px\\">"+esc(t.thought||"")+"</div>";' +
    'if(t.spoke){out+="<div style=\\"font-size:13px;margin-top:4px;padding:6px 8px;background:#f0f7ff;border-radius:6px\\">发出："+esc(t.message||"")+"</div>";}' +
    'out+="</div></div>";' +
    'return out}' +
    'document.getElementById("awakeThoughts").innerHTML=list.length?list.map(rowHtml).join(""):"（还没有记录 — 她还没醒过）";' +
    '}catch(e){document.getElementById("awakeHint").textContent="读不到状态"}}' +
    'pollAwake();setInterval(pollAwake,10000);' +
    'async function pollChat(){try{' +
    'const r=await fetch("/transcript?limit=20");const j=await r.json();' +
    'const box=document.getElementById("chatLog");' +
    'const atBottom=box.scrollTop+box.clientHeight>=box.scrollHeight-30;' +
    'function msgHtml(m){' +
    'var out="<div style=\\"padding:9px 0;border-bottom:1px solid #f0f0f2\\">";' +
    'out+="<div style=\\"font-size:12px;color:#8e8e93\\">"+esc(m.at)+"</div>";' +
    'out+="<div style=\\"font-size:13px;margin-top:3px\\"><b style=\\"color:#0a84ff\\">他：</b>"+esc(m.user)+"</div>";' +
    'out+="<div style=\\"font-size:13px;margin-top:2px\\"><b style=\\"color:#34c759\\">她：</b>"+esc(m.assistant)+"</div>";' +
    'if(m.thinking){out+="<details style=\\"margin-top:6px\\"><summary style=\\"font-size:12px;color:#8e8e93;cursor:pointer\\">她想了 "+m.thinking.length+" 字，点开看</summary>' +
    '<div style=\\"font-size:12px;color:#666;margin-top:4px;padding:8px;background:#fafafa;border-left:2px solid #d1d1d6;white-space:pre-wrap\\">"+esc(m.thinking)+"</div></details>";}' +
    'out+="</div>";return out}' +
    'const items=(j.list||[]).slice().reverse();' +
    'box.innerHTML=items.length?items.map(msgHtml).join(""):"（还没有记录）";' +
    'if(atBottom){box.scrollTop=0}' +
    '}catch(e){}}' +
    'pollChat();setInterval(pollChat,15000);' +
    'async function pollLog(){try{' +
    'const r=await fetch("/log?lines=200");const j=await r.json();' +
    'const box=document.getElementById("logBox");' +
    'const atBottom=box.scrollTop+box.clientHeight>=box.scrollHeight-30;' +
    'function lineHtml(line){' +
    'var color="#d1d1d6";' +
    'if(line.indexOf("收到")>=0||line.indexOf("合并成")>=0)color="#5ac8fa";' +
    'else if(line.indexOf("完成")>=0)color="#30d158";' +
    'else if(line.indexOf("失败")>=0||line.indexOf("错误")>=0||line.indexOf("连不上")>=0)color="#ff453a";' +
    'else if(line.indexOf("自主")>=0||line.indexOf("醒来")>=0||line.indexOf("念头")>=0)color="#bf5af2";' +
    'else if(line.indexOf("任务")>=0||line.indexOf("发图")>=0)color="#ff9f0a";' +
    'else if(line.indexOf("蒸馏")>=0||line.indexOf("记下")>=0)color="#64d2ff";' +
    'return "<div style=\\"color:"+color+"\\">"+esc(line)+"</div>"}' +
    'box.innerHTML=(j.lines||[]).map(lineHtml).join("");' +
    'if(atBottom){box.scrollTop=box.scrollHeight}' +
    '}catch(e){}}' +
    'pollLog();setInterval(pollLog,10000);' +
    '</script></body></html>'
  )
}

/* ---------- 本地发送口：桌面端的我可以随时往 QQ 推消息 ---------- */
function startSendServer() {
  const server = http.createServer(async (req, res) => {
    const url = req.url || '/'
    if (req.method === 'GET' && (url === '/' || url.startsWith('/?') || url === '/index.html' || url.startsWith('/index.html?'))) {
      /* 界面是独立文件，改它不用重写桥；读不到就退回一句提示 */
      let html = '<!doctype html><meta charset="utf-8"><h1 style="font-family:system-ui">界面文件缺失</h1><p>应该在这里：' + path.join(DIR, 'ui', 'index.html') + '</p>'
      try {
        html = fs.readFileSync(path.join(DIR, 'ui', 'index.html'), 'utf8')
      } catch (err) { /* 用兜底 HTML */ }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(html)
    }

    if (req.method === 'GET' && url.startsWith('/whitelist')) {
      const wl = loadWhitelist()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ ok: true, owner: wl.owner, entries: wl.entries }))
    }

    if (req.method === 'GET' && url.startsWith('/watchdog')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ ok: true, ...watchdogStatus() }))
    }
    if (req.method === 'GET' && url.startsWith('/providers')) {
      /* 不返回 key 本身，只说有没有 */
      const list = readProviders().map((entry) => ({
        id: entry.id,
        name: entry.name || entry.id,
        baseURL: entry.baseURL || '',
        model: entry.model || '',
        hasKey: Boolean(entry.key) || Boolean(loadKey(providerEnvName(entry))),
      }))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ ok: true, list }))
    }
    if (req.method === 'GET' && url.startsWith('/models')) {
      const data = readModels()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ ok: true, current: data.current, options: data.options }))
    }

    if (req.method === 'GET' && url.startsWith('/transcript')) {
      const q = new URL(url, 'http://x').searchParams
      const limit = Math.min(Number(q.get('limit')) || 30, 100)
      const list = loadTranscript().slice(-limit).map((item) => ({
        at: new Date(item.at).toLocaleString('zh-CN'),
        user: String(item.user || ''),
        assistant: String(item.assistant || ''),
        thinking: String(item.thinking || ''),
      }))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ ok: true, list }))
    }

    if (req.method === 'GET' && url.startsWith('/online-status')) {
      const result = await callAction('get_status', {})
      const inner = result && result.ok && result.data && result.data.data ? result.data.data : null
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({
        ok: Boolean(inner),
        online: inner ? Boolean(inner.online) : false,
        reason: inner ? '' : (result && result.reason) || 'NapCat 没回话',
      }))
    }
    if (req.method === 'GET' && url.startsWith('/prompt')) {
      const q = new URL(url, 'http://x').searchParams
      const who = String(q.get('user') || loadAllow()[0] || '')
      const text = String(q.get('text') || '在吗')
      const built = buildPrompt(who, text)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ ok: true, prompt: built }))
    }
    if (req.method === 'GET' && url.startsWith('/self-edit')) {
      const q = new URL(url, 'http://x').searchParams
      const key = q.get('file')
      let data
      if (!key) {
        data = { ok: true, files: Object.keys(SELF_FILES).map((k) => ({ key: k, desc: SELF_FILES[k].desc, max: SELF_FILES[k].max })) }
      } else {
        data = selfRead(key)
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(data))
    }
    if (req.method === 'GET' && url.startsWith('/awake-state')) {
      const result = readAwakeState()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(result))
    }
    if (req.method === 'GET' && url.startsWith('/voice')) {
      if (url.includes('force=1')) await updateVoiceProfile(true)
      const v = loadVoice()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ ok: true, voice: v, prompt: voiceBlock() }))
    }
    if (req.method === 'GET' && url.startsWith('/distill')) {
      const force = url.includes('force=1')
      await distillIfDue(force)
      let info = {}
      try { info = JSON.parse(fs.readFileSync(path.join(DIR, 'distill-state.json'), 'utf8')) } catch (err) { info = {} }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ ok: true, info }))
    }

    if (req.method === 'GET' && url.startsWith('/log')) {
      const q = new URL(url, 'http://x').searchParams;
      const want = Math.min(Number(q.get('lines')) || 120, 400);
      let lines = [];
      try {
        lines = fs.readFileSync(path.join(DIR, 'bridge.log'), 'utf8').trim().split('\n').slice(-want);
      } catch (err) { lines = ['读不到日志']; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, lines }));
    }

    if (req.method === 'GET' && url === '/permission') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ ok: true, computer: computerAllowed() }))
    }

    /* ── 人设工坊 ─────────────────────────────────────── */
    if (req.method === 'GET' && url === '/studio/personas') {
      const s = globalThis.__qqpbStudio
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ ok: true, active: s ? s.activeId() : '', list: s ? s.list() : [] }))
    }

    /* 调试：把某句话拼出来的提示词原样吐出来，用来确认记忆有没有进去 */
    if (req.method === 'GET' && url.startsWith('/debug-prompt')) {
      const q = new URL(url, 'http://127.0.0.1').searchParams
      const allow = loadAllow()
      const uid = q.get('qq') || allow[0] || ''
      const text = q.get('text') || '在吗'
      const prompt = await buildPrompt(uid, text)
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end(prompt)
    }

    if (req.method === 'GET' && url === '/studio/progress') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ ok: true, job: globalThis.__lineJob || null, build: globalThis.__buildJob || null }))
    }

    /* 试听：kind=preview 听音色；kind=line&key=xxx 听某条台词 */
    if (req.method === 'GET' && url.startsWith('/studio/audio')) {
      const q = new URL(url, 'http://127.0.0.1').searchParams
      const s = globalThis.__qqpbStudio
      const id = q.get('id') || ''
      const kind = q.get('kind') || 'preview'
      if (!s || !id) { res.writeHead(400); return res.end('缺少 id') }
      const d = s.dirOf(id)
      const file = kind === 'line'
        ? path.join(d, 'lines', String(q.get('key') || '').replace(/[^a-z0-9_-]/gi, '') + '.wav')
        : path.join(d, 'preview.wav')
      try {
        const buf = fs.readFileSync(file)
        res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' })
        return res.end(buf)
      } catch (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('没有这个音频')
      }
    }

    if (req.method === 'GET' && url === '/status') {
      const chat = currentChat()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({
        ok: true,
        napcat: Boolean(socket && socket.readyState === 1),
        model: chat ? chat.model : '',
        awake: Boolean(awakening),
        computer: computerAllowed(),
        allowed: loadAllow(),
        uptimeSec: Math.round(process.uptime()),
        lastEventSec: lastEventAt ? Math.round((Date.now() - lastEventAt) / 1000) : -1,
        lastPrivateSec: lastPrivateAt ? Math.round((Date.now() - lastPrivateAt) / 1000) : -1,
        watchdog: watchdogStatus(),
        whitelist: { owner: loadWhitelist().owner, count: loadWhitelist().entries.length },
      }))
    }
    if (req.method === 'GET' && url === '/awake') {
      const status = awakening ? awakening.status() : null
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ ok: Boolean(status), status }))
    }

    /* 二维码会两分钟一换，所以给一个会自己刷新的页面，让他对着屏幕扫 */
    if (req.method === 'GET' && url.startsWith('/qr-image')) {
      try {
        const buf = fs.readFileSync(NAPCAT_QR_FILE)
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store, no-cache, must-revalidate',
          'pragma': 'no-cache',
        })
        return res.end(buf)
      } catch (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        return res.end('还没有二维码文件')
      }
    }

    if (req.method === 'GET' && url.startsWith('/qr-status')) {
      let info = { ok: false }
      try {
        const st = fs.statSync(NAPCAT_QR_FILE)
        info = { ok: true, bornAt: st.mtimeMs, ageSec: Math.round((Date.now() - st.mtimeMs) / 1000) }
      } catch (err) { /* 没文件 */ }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(info))
    }
    if (req.method === 'GET' && url.startsWith('/qr-live')) {
      const html = [
        '<!doctype html><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        '<title>NapCat 扫码</title>',
        '<body style="margin:0;background:#f4f5f7;font:15px/1.6 system-ui,sans-serif;',
        'display:flex;align-items:center;justify-content:center;min-height:100vh">',
        '<div style="background:#fff;padding:22px;border-radius:16px;text-align:center;',
        'box-shadow:0 2px 16px rgba(16,24,40,.08)">',
        '<div style="font-weight:600;margin-bottom:12px">手机 QQ 扫码登录</div>',
        '<img id="q" style="width:240px;height:240px;image-rendering:pixelated">',
        '<div id="t" style="color:#8a8f9a;font-size:12.5px;margin-top:10px">加载中…</div>',
        '<div id="left" style="font-size:15px;font-weight:600;margin-top:6px">—</div>',
        '<div style="color:#8a8f9a;font-size:12px;margin-top:6px">二维码只活 2 分钟，过期自动换新</div>',
        '</div>',
        '<script>',
        'function refreshImg(){',
        '  document.getElementById("q").src="/qr-image?t="+Date.now();',
        '}',
        'function tickStatus(){',
        '  fetch("/qr-status?t="+Date.now(),{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){',
        '    if(!j.ok){document.getElementById("left").textContent="还没有二维码";return}',
        '    var left=120-j.ageSec;',
        '    document.getElementById("t").textContent="二维码生成于 "+new Date(j.bornAt).toLocaleTimeString("zh-CN");',
        '    var el=document.getElementById("left");',
        '    if(left>0){el.textContent="还剩 "+left+" 秒，现在就扫";el.style.color=left>30?"#16a34a":"#dc2626"}',
        '    else{el.textContent="已过期，正在换新…";el.style.color="#dc2626";refreshImg()}',
        '  }).catch(function(){})',
        '}',
        '/* 二维码文件一变就换图，别等定时器 */',
        'var lastBorn=0;',
        'setInterval(function(){',
        '  fetch("/qr-status?t="+Date.now(),{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){',
        '    if(j.ok && j.bornAt!==lastBorn){lastBorn=j.bornAt;refreshImg()}',
        '  }).catch(function(){})',
        '},1500);',
        'refreshImg();tickStatus();setInterval(tickStatus,1000);',
        '</script>',
      ].join('')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(html)
    }

    if (req.method === 'GET' && url === '/qr') {
      const result = await napcatApi('/QQLogin/GetQQLoginQrcode')
      const qr = result.ok && result.data && result.data.data ? result.data.data.qrcode : ''
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ ok: Boolean(qr), qr, reason: result.ok ? '' : result.reason }))
    }

    if (req.method === 'GET' && url === '/login-status') {
      const result = await napcatApi('/QQLogin/CheckLoginStatus')
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify(result))
    }

    /* 拉私聊历史：/history?qq=YOUR_QQ&count=20 */
    if (req.method === 'GET' && url.startsWith('/history')) {
      const query = new URL(url, 'http://127.0.0.1').searchParams
      const allow = loadAllow()
      const target = query.get('qq') || allow[0] || ''
      const count = Number(query.get('count')) || 20
      const result = await callAction('get_friend_msg_history', {
        user_id: Number(target),
        count,
        message_seq: 0,
        reverseOrder: false,
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify(result))
    }

    if (req.method !== 'POST' || (url !== '/send' && url !== '/model' && url !== '/provider' && url !== '/start-napcat' && url !== '/reconnect' && url !== '/send-image' && !url.startsWith('/studio/') && url !== '/set-avatar' && url !== '/set-nickname' && url !== '/permission' && url !== '/self-edit' && url !== '/online-status' && url !== '/awake-state' && url !== '/provider-delete' && url !== '/watchdog' && url !== '/whitelist')) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('POST /send {"text":"..."}')
    }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      let payload = {}
      try {
        payload = JSON.parse(body || '{}')
      } catch (err) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('bad json')
      }
      if (url === '/set-avatar') {
        const file = String(payload.file || '').trim()
        if (!file || !fs.existsSync(file)) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ ok: false, reason: '文件不存在：' + file }))
        }
        const normalized = path.resolve(file).replace(/\\/g, '/')
        const result = await callAction('set_qq_avatar', { file: 'file:///' + normalized })
        const ok = Boolean(result.ok && result.data && (result.data.retcode === 0 || result.data.status === 'ok'))
        log('换头像 ' + (ok ? '成功' : '失败') + '：' + path.basename(file))
        res.writeHead(ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok, raw: result.ok ? result.data : result }))
      }

      if (url === '/set-nickname') {
        const nickname = String(payload.nickname || '').trim().slice(0, 20)
        if (!nickname) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ ok: false, reason: '昵称不能为空' }))
        }
        const result = await callAction('set_qq_profile', { nickname })
        const ok = Boolean(result.ok && result.data && (result.data.retcode === 0 || result.data.status === 'ok'))
        log('改昵称 ' + (ok ? '成功' : '失败') + '：' + nickname)
        res.writeHead(ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok, raw: result.ok ? result.data : result }))
      }

      if (url === '/send-image') {
        const file = String(payload.file || '').trim()
        const allow = loadAllow()
        const target = String(payload.qq || allow[0] || '')
        if (!file || !target || !fs.existsSync(file)) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ ok: false, reason: '需要存在的 file 和 qq' }))
        }
        const sent = sendImage(target, file)
        res.writeHead(sent ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok: sent, to: target }))
      }

      if (url === '/start-napcat') {
        const started = startNapCat()
        res.writeHead(started ? 200 : 500, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok: started }))
      }

      /* 一键重连：容器 → OneBot → 登录态 → WS，一条龙跑一遍。
         返回每一步的结果，前端照着显示就行。 */
      if (url === '/reconnect') {
        const steps = []
        let state = await napcatState()
        steps.push({ step: 'NapCat', ok: state === 'running', note: state === 'running' ? '在跑' : '没在跑' })

        if (state !== 'running') {
          steps.push({ step: '启动 NapCat', ok: startNapCat(), note: '隐藏窗口拉起' })
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 3000))
            state = await napcatState()
            if (state === 'running') break
          }
          steps.push({ step: 'NapCat 就绪', ok: state === 'running', note: state })
        }

        /* WS 通道（每 5 秒自己重连，这里只等它连上） */
        let wsOk = false
        for (let i = 0; i < 15; i++) {
          wsOk = Boolean(socket && socket.readyState === 1)
          if (wsOk) break
          await new Promise((r) => setTimeout(r, 2000))
        }
        steps.push({ step: '消息通道', ok: wsOk, note: wsOk ? '已连接' : '连不上（NapCat 可能没起完）' })

        /* 登录态 */
        let online = false
        let info = null
        if (wsOk) {
          for (let i = 0; i < 10; i++) {
            const r = await callAction('get_login_info', {}, 6000).catch(() => null)
            /* callAction 回的是 { ok, data: 完整回包 }，用户信息在 data.data 里 */
            const d = r && r.data && r.data.data
            if (d && d.user_id) { online = true; info = d; break }
            await new Promise((r2) => setTimeout(r2, 2000))
          }
        }
        steps.push({
          step: 'QQ 登录',
          ok: online,
          note: online ? info.nickname + ' (' + info.user_id + ')' : '未登录，需要扫码',
        })

        res.writeHead(online ? 200 : 409, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({
          ok: online, online, needScan: !online && wsOk,
          nickname: info && info.nickname, uin: info && info.user_id, steps,
        }))
      }

      /* ── 人设工坊（POST）────────────────────────────── */
      if (url.startsWith('/studio/')) {
        const s = globalThis.__qqpbStudio
        const reply = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(obj))
        }
        if (!s) return reply(500, { ok: false, error: '人设工坊没初始化' })

        if (url === '/studio/generate') {
          const r = await s.generate(payload.raw, { dialect: payload.dialect })
          return reply(r.ok ? 200 : 400, r)
        }
        /* 一条龙：人设 + 音色 + 台词库。音色跟人设一起出才配套。 */
        if (url === '/studio/build') {
          const r = await s.buildFull(payload.raw, { dialect: payload.dialect }, (p) => {
            globalThis.__buildJob = { ...p, at: Date.now() }
          })
          if (r.ok) globalThis.__buildJob = { stage: '人设与音色已完成', done: true, id: r.id, linesTotal: r.linesTotal }
          return reply(r.ok ? 200 : (r.partial ? 207 : 400), r)
        }
        if (url === '/studio/save') {
          const r = s.save(payload.draft || payload)
          return reply(r.ok ? 200 : 400, r)
        }
        if (url === '/studio/activate') {
          const r = s.activate(payload.id)
          return reply(r.ok ? 200 : 400, r)
        }
        if (url === '/studio/remove') {
          const r = s.remove(payload.id)
          return reply(r.ok ? 200 : 400, r)
        }
        if (url === '/studio/voice') {
          /* 慢：约 40 秒（两次 CLI，每次都要加载 3.17 GB 模型） */
          const meta = s.get(payload.id)
          if (!meta) return reply(400, { ok: false, error: '人设不存在' })
          const desc = payload.description || meta.voice?.description || ''
          const sample = payload.sample || meta.voice?.sample || '在呢，我在听。'
          const r = await s.designVoice(payload.id, desc, sample)
          return reply(r.ok ? 200 : 500, r)
        }
        if (url === '/studio/lines') {
          /* 更慢：每条约 15 秒。放后台跑，立刻返回，前端轮询进度 */
          const meta = s.get(payload.id)
          if (!meta) return reply(400, { ok: false, error: '人设不存在' })
          globalThis.__lineJob = { id: payload.id, done: 0, total: (meta.lines || []).length, finished: false, keys: [] }
          s.synthLines(payload.id, (p) => {
            globalThis.__lineJob.done = p.i
            globalThis.__lineJob.key = p.key
          }).then((r) => {
            globalThis.__lineJob = { id: payload.id, finished: true, ...r }
            log('台词库合成完成：' + r.done + '/' + r.total)
          }).catch((err) => {
            globalThis.__lineJob = { id: payload.id, finished: true, ok: false, error: String(err && err.message) }
          })
          return reply(200, { ok: true, started: true, total: (meta.lines || []).length })
        }
        if (url === '/studio/export') {
          const r = s.exportBundle(payload.id)
          return reply(r.ok ? 200 : 400, r)
        }
        if (url === '/studio/import') {
          const r = s.importBundle(payload.bundle)
          return reply(r.ok ? 200 : 400, r)
        }
        if (url === '/studio/progress') {
          return reply(200, { ok: true, job: globalThis.__lineJob || null })
        }
        return reply(404, { ok: false, error: '未知接口 ' + url })
      }

      if (url === '/whitelist') {
        const incoming = Array.isArray(payload.entries) ? payload.entries : []
        const wantOwner = String(payload.owner || '').trim()
        const list = normalizeWhitelist({ owner: wantOwner, entries: incoming })

        /* owner 必须是一个私聊条目；没在名单里就自动补进去 */
        if (list.owner && !list.entries.some((e) => e.type === 'private' && e.id === list.owner)) {
          list.entries.unshift({ id: list.owner, type: 'private', name: '我', reply: true })
        }
        const saved = saveWhitelist(list)
        if (!saved) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ ok: false, reason: '写不进去' }))
        }
        log('白名单更新：' + saved.entries.length + ' 条，owner ' + (saved.owner || '（未设置）'))
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok: true, owner: saved.owner, entries: saved.entries }))
      }

      if (url === '/watchdog') {
        if (payload.enabled !== undefined) {
          WATCHDOG.enabled = Boolean(payload.enabled)
          log('看门狗：' + (WATCHDOG.enabled ? '已开启' : '已关闭'))
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok: true, ...watchdogStatus() }))
      }
      if (url === '/provider-delete') {
        const id = String(payload.id || '').trim()
        if (!id) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ ok: false, reason: '缺少 id' }))
        }
        const list = readProviders()
        const index = list.findIndex((entry) => entry.id === id)
        if (index < 0) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ ok: false, reason: '没有这个接口：' + id }))
        }
        if (list.length <= 1) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ ok: false, reason: '这是最后一个接口，删了她就没模型可用了' }))
        }
        const removed = list[index]
        list.splice(index, 1)
        const saved = writeProviders(list)
        const rebuilt = saved && regenerateProviders(list)

        /* 模型列表里属于这个接口的选项一并清掉 */
        const models = readModels()
        const before = models.options.length
        models.options = (models.options || []).filter((option) => option.provider !== id)
        /* 正在用的那个被删了，就切到剩下的第一个 */
        let switched = false
        if (models.current && models.current.provider === id) {
          const next = models.options[0]
          if (next) {
            models.current = { provider: next.provider, model: next.model }
            switched = true
          }
        }
        writeModels(models)
        log('删掉接口 ' + id + '（' + removed.name + '），模型选项 ' + before + ' → ' + models.options.length +
          (switched ? '，已切到 ' + models.current.provider : ''))
        res.writeHead(saved && rebuilt ? 200 : 500, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({
          ok: saved && rebuilt,
          removed: id,
          current: models.current,
          switched,
          remaining: list.length,
        }))
      }
      if (url === '/provider') {
        const name = String(payload.name || '').trim()
        const baseURL = String(payload.baseURL || '').trim()
        const model = String(payload.model || '').trim()
        const key = String(payload.key || '').trim()
        if (!name || !baseURL || !model) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ ok: false, reason: '需要名称、baseURL、模型 id' }))
        }
        const id =
          String(payload.id || name)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'custom' + Date.now()
        const list = readProviders()
        const index = list.findIndex((entry) => entry.id === id)
        const previous = index >= 0 ? list[index] : null
        const entry = {
          id,
          name,
          baseURL,
          model,
          /* 更新已有条目时，没填 key 就保留原来的 key 和 keyEnv，别把能用的配置冲掉 */
          key: key || (previous && previous.key) || '',
          keyEnv: (previous && previous.keyEnv) || 'QQPB_KEY_' + id.toUpperCase(),
          vision: true,
          reasoning: previous ? previous.reasoning : false,
          contextWindow: previous ? previous.contextWindow : undefined,
          maxTokens: previous ? previous.maxTokens : undefined,
        }
        if (index >= 0) list[index] = entry
        else list.push(entry)
        const saved = writeProviders(list)
        const rebuilt = saved && regenerateProviders(list)
        const models = readModels()
        if (!models.options.some((option) => option.provider === id && option.model === model)) {
          models.options.push({ provider: id, model, label: name + ' · ' + model })
          writeModels(models)
        }
        res.writeHead(saved && rebuilt ? 200 : 500, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok: saved && rebuilt, provider: id, model }))
      }

      if (url === '/online-status') {
        /* 10 在线 / 30 离开 / 40 勿扰 / 50 忙碌 / 60 隐身 / 70 听歌中（这个版本没有"睡觉"） */
        const allowed = [10, 30, 40, 50, 60, 70]
        const status = Number(payload.status)
        if (!allowed.includes(status)) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ ok: false, reason: '状态只能是 ' + allowed.join('/') }))
        }
        const result = await callAction('set_online_status', { status, ext_status: 0, battery_status: 100 })
        const ok = Boolean(result.ok && result.data && result.data.retcode === 0)
        log('改在线状态：' + status + (ok ? ' 成功' : ' 失败'))
        res.writeHead(ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok, status }))
      }
      if (url === '/awake-state') {
        const result = writeAwakeState(payload)
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify(result))
      }
      if (url === '/self-edit') {
        const result = selfWrite(String(payload.file || '').trim(), payload.content)
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify(result))
      }
      if (url === '/permission') {
        const allowed = payload.computer !== false
        try {
          fs.writeFileSync(PERM_FILE, JSON.stringify({ computer: allowed }, null, 2), 'utf8')
        } catch (err) { /* 忽略 */ }
        const done = applyComputerPermission(allowed)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok: done, computer: allowed }))
      }

      if (url === '/model') {
        const provider = String(payload.provider || '').trim()
        const model = String(payload.model || '').trim()
        if (!provider || !model) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ ok: false, reason: 'need provider and model' }))
        }
        const switched = applyModel(provider, model)
        if (switched) {
          const data = readModels()
          data.current = { provider, model }
          writeModels(data)
        }
        res.writeHead(switched ? 200 : 500, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok: switched, current: { provider, model } }))
      }

      const allow = loadAllow()
      const target = String(payload.qq || allow[0] || '')
      const text = String(payload.text || '').slice(0, 4000)
      if (!target || !text) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('need qq and text')
      }
      /* 走 sendHuman 而不是 sendRich：这样本地发送口和真实回复是同一条路，
         [语音]、[表情包]、拆气泡、保底都一致——否则测试结果和线上不一样。 */
      log('发出去（' + target + '）：' + text.slice(0, 40))
      sendHuman(target, text).catch((err) => log('本地发送失败：' + String((err && err.message) || err)))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, to: target }))
    })
  })
  server.on('error', (err) => {
    /* 单实例锁：两个桥会同时连 NapCat，还会抢同一份会话存储，互相卡死 */
    if (err.code === 'EADDRINUSE') {
      log('已经有一个桥在跑（3002 被占用），这个实例退出')
      process.exit(0)
    }
    log('发送口启不来：' + err.message)
  })
  setInterval(() => { watchdogTick().catch(() => {}) }, 20000)

  server.listen(SEND_PORT, '127.0.0.1', () => log('本地发送口：http://127.0.0.1:' + SEND_PORT + '/send'))
}

/* 一个异常不该让整条通道死掉 */
process.on('uncaughtException', (error) => log('未捕获异常：' + String((error && error.message) || error)))
process.on('unhandledRejection', (error) => log('未处理拒绝：' + String((error && error.message) || error)))

/* 上一次桥被杀时，它拉起的 headless 会变成孤儿继续跑，越积越多互相拖慢。
   每次启动先扫一遍：此刻还在跑的 headless 一定是上一轮留下的。 */
function sweepOrphans() {
  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | Where-Object { $_.CommandLine -like '*headless*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ], { stdio: 'ignore', windowsHide: true, timeout: 20000 })
    log('已清扫上一轮残留的 headless')
  } catch (err) {
    log('清扫残留失败（不影响使用）：' + String((err && err.message) || err))
  }
}
log('桥启动 · 白名单 ' + (loadAllow().join(',') || '（空：接受所有私聊）'))

if (process.argv.includes('--self-test')) {
  askModel('用五个字回答：自检通过').then((result) => {
    log('自检结果：' + (result.ok ? 'OK ' : 'FAIL ') + result.text)
    process.exit(result.ok ? 0 : 1)
  })
} else {
  sweepOrphans()
  loadHistories()
  loadFaces()
  if (AWAKE_ON) startAwakening()
  try { fs.mkdirSync(JOBS_DIR, { recursive: true }) } catch (err) { /* 忽略 */ }
  startSendServer()
  connect()
  /* 每 5 秒看一次任务目录：模型丢进来的长活在这里跑，不占对话回合 */
  setInterval(pollJobs, 5000)
  log('任务目录：' + JOBS_DIR)
}
