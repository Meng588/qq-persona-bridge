/**
 * 把写死的本机路径收进一个配置文件。
 *
 * 原先是散在各个文件里的绝对路径（运行时、QQ 客户端、OCR 工具各在各处），
 * 换台机器就全跑不了。这里统一从 config.json 读，缺项走环境变量，
 * 再缺就用平台默认值——别人 clone 下来改一个文件就能跑。
 */
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

function readConfig() {
  const candidates = [
    process.env.QQPB_CONFIG,
    path.join(DIR, 'config.json'),
    path.join(DIR, 'config.example.json'),
  ].filter(Boolean)
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue
      const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      return { ...raw, __source: file }
    } catch (err) {
      /* 配错了就往下试 */
    }
  }
  return { __source: '(none)' }
}

const CFG = readConfig()

/**
 * 取配置值，优先级：环境变量 > config.json > 内置默认。
 *
 * 环境变量统一用 Q QPB_ 前缀。
 */
function pick(key, envName, fallback) {
  if (envName) {
    const suffix = envName.replace(/^QQPB_/, '')
    const modern = process.env['QQPB_' + suffix]
    if (modern) return modern
  }
  const v = CFG[key]
  if (v !== undefined && v !== null && v !== '') return v
  return fallback
}

/** 把 ~ 和相对路径展开成绝对路径 */
function expand(p, base) {
  if (!p) return p
  let s = String(p)
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    s = path.join(require$homedir(), s.slice(1))
  }
  s = s.replace(/\\/g, path.sep)
  if (path.isAbsolute(s)) return s
  return path.resolve(base || DIR, s)
}

function require$homedir() {
  return process.env.USERPROFILE || process.env.HOME || DIR
}

export const config = {
  source: CFG.__source,

  /* ── 用哪个「脑」────────────────────────────────
     dsh    = 默认，功能最全（工具、人设注入、看图）
     openai = 任何 OpenAI 兼容接口，只要对话
     cli    = 任意"读 stdin 写 stdout"的命令行程序  */
  llmProvider: String(pick('llmProvider', 'QQPB_LLM', 'dsh')).toLowerCase(),
  llmBase: pick('llmBase', 'QQPB_LLM_BASE', ''),
  llmModel: pick('llmModel', 'QQPB_LLM_MODEL', ''),
  llmKey: pick('llmKey', 'QQPB_LLM_KEY', ''),
  llmTemperature: pick('llmTemperature', 'QQPB_LLM_TEMP', 1.0),
  llmMaxTokens: pick('llmMaxTokens', 'QQPB_LLM_MAX_TOKENS', 2000),
  llmCliCmd: pick('llmCliCmd', 'QQPB_LLM_CMD', ''),

  /* ── 模型运行时（DSH）──────────────────────────── */
  dshExe: pick('dshExe', 'QQPB_DSH', 'DeepSeek Harness.exe'),
  dshCli: pick(
    'dshCli',
    'QQPB_CLI',
    'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
  ),
  dshCwd: pick('dshCwd', 'QQPB_CWD', ''),
  dshProfile: pick('dshProfile', 'QQPB_PROFILE', ''),

  /* ── NapCat ──────────────────────────────────── */
  napcatWs: pick('napcatWs', 'QQPB_WS', 'ws://127.0.0.1:36199'),
  napcatWebuiConfig: pick('napcatWebuiConfig', 'QQPB_NAPCAT_WEBUI', ''),
  napcatQrFile: pick('napcatQrFile', 'QQPB_NAPCAT_QR', ''),
  napcatStartCmd: pick('napcatStartCmd', 'QQPB_NAPCAT_BAT', ''),
  napcatStartVbs: pick('napcatStartVbs', 'QQPB_NAPCAT_VBS', ''),
  napcatWorkDir: pick('napcatWorkDir', 'QQPB_NAPCAT_DIR', ''),

  /* ── 记忆服务 ─────────────────────────────────── */
  memoryUrl: pick('memoryUrl', 'QQPB_MEM_URL', 'http://127.0.0.1:8790'),
  memoryStartCmd: pick('memoryStartCmd', 'QQPB_MEM_START', ''),

  /* ── 语音（TTS）───────────────────────────────── */
  ttsUrl: pick('ttsUrl', 'QQPB_TTS_URL', 'http://127.0.0.1:8137'),
  ttsCli: pick('ttsCli', 'QQPB_TTS_CLI', ''),
  ttsModel: pick('ttsModel', 'QQPB_TTS_MODEL', ''),
  ttsVoicesDir: pick('ttsVoicesDir', 'QQPB_TTS_VOICES', ''),

  /* ── 可选工具 ─────────────────────────────────── */
  genImageTool: pick('genImageTool', 'QQPB_GEN_IMAGE', ''),
  gifFramesTool: pick('gifFramesTool', 'QQPB_GIF_FRAMES', ''),
  ocrEngine: pick('ocrEngine', 'QQPB_OCR', ''),
}

export function expandPath(p, base) {
  return expand(p, base)
}

/** 启动用：把配置的相对路径变成绝对 */
export function resolveTool(p, fallback = '') {
  const v = p || fallback
  if (!v) return ''
  return expand(v, CFG.__source && CFG.__source !== '(none)' ? path.dirname(CFG.__source) : DIR)
}
