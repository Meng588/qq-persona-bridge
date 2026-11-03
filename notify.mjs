/**
 * 给看门狗用的"发一句话"小工具。
 * 用法：node notify.mjs restarted|napcat-down|ok
 * 把代码翻成一句人话，POST 到桥的本地发送口。桥没起来就静默失败。
 */
const PORT = Number(process.env.QQPB_SEND_PORT) || 3002

const MESSAGES = {
  restarted: '（看门狗：刚才桥断了，我把它拉起来了）',
  'napcat-down': '（看门狗：NapCat 掉了，QQ 现在连不上，需要你看一眼）',
  'killed-zombie': '（看门狗：有一条卡死的任务被我掐了）',
  ok: '（看门狗：检查正常）',
}

const code = process.argv[2] || 'ok'
const text = MESSAGES[code] || MESSAGES.ok

try {
  const response = await fetch('http://127.0.0.1:' + PORT + '/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!response.ok) process.exit(1)
} catch (err) {
  process.exit(1)
}
