# 人设工坊

让任何人写一段描述，就能得到一个能直接在这套架构里跑的角色。

## 为什么需要它

这套桥接有很多硬约束：句子会被自动拆成 1-3 条气泡、她可以完全不回（`[不回]`）、
只有三种富媒体写法、不能编造自己没经历过的事。

自由写出来的「设定文档」放进这套架构会处处违和——句子太长被拆碎、
语气变成客服腔、编出"我刚刷到"这种一追问就露馅的话。

所以生成器不是"让模型写个设定"，而是**把这些约束编码进提示词**，
产出天生适配架构的人设卡。

## 用法

打开 http://127.0.0.1:3002/ → 「人设」页

1. **写描述** — 不用写设定文档，像介绍一个人那样写
   > 一个二十八岁的女生，夜班护士，说话慢，耐心但有点丧，喜欢在下班路上买关东煮。

2. **生成人设** — 约 30 秒，产出一张完整的人设卡 + 音色描述 + 台词库

3. **保存并启用** — 下一句话就是她。切换不需要重启。

4. **生成音色**（可选，20-40 秒）— 本地 Breeze TTS，Vulkan 加速

> 音色随人设一起生成，不需要单独点。

## 生成器遵守的规则

| 规则 | 原因 |
|---|---|
| 多数句子 ≤10 字 | 会被拆成气泡，长句被拆碎 |
| 保留 `[不回]` 退出 | 她可以选择不开口，这是真实选项 |
| 只有 `[表情]` `[表情包]` `[图片]` `[语音]` 四种富媒体写法 | 桥接只认这四种 |
| 禁止"我刚刷到""我查了查" | 她没有在外面生活过，一追问就露馅 |
| 不客服腔、不解说自己、不抛三选项 | 这些是 AI 味的来源 |
| 给出真实的对话样本 | 「他：今天累死了 → 你：吃饭没。」比形容词有用 |

## 语音是实时的，不是预录的

她在回复末尾写 `[语音]`，系统就**把这句话本身**用她的音色合成出来发出去。
不是从固定台词库里挑一条——说什么由她自己决定。

底层是 `breeze-server` 常驻服务（路径在 config.json 的 `ttsCli`）。
模型只加载一次，之后每次只算推理。

```
启动参数  breeze-server <model.gguf> --port 8137 --voices-dir <voices-dir>
健康检查  GET http://127.0.0.1:8137/health
合成      POST http://127.0.0.1:8137/v1/audio/speech
```

桥接启动时会自动检查，没在跑就拉起（启动约 70 秒，期间语音退回文字）。
TTS 请求在桥接侧串行排队——服务器是 `--parallel 1`，并发会返回 409。

### 这台机器上的实际速度

```
breeze-server 私有内存   3.8 GB
系统可用内存             0.6 GB   ← 模型会被换页，每次合成都要换回来
短句（10 字内）          9-14 秒
中句（20 字）            13-15 秒
```

核显（Intel UHD 2GB）装不下 3.2 GB 模型，只能走 CPU 混合推理；
再加上内存不足导致换页，所以比官方标称的「2 倍实时」慢很多。
换独显 + 加内存能到 2 倍实时（一句话不到 1 秒）。

想在现有机器上提速的两个办法：

1. 换 q4_k 量化（约 1.9 GB，内存和显存都装得下），从 HuggingFace 下
   `HoppouAI/Breeze-TTS-2.cpp` 的 `breeze-tts-2-q4_k.gguf`
2. 关掉一些常驻程序（Chrome、桌面 DSH 实例）腾内存

### 旧的台词库还在，但不再用于语音

`lines` 和 `lines/*.wav` 保留着，`[语音] key` 这种老写法仍能取到预录文件。
新写的一律走实时合成。台词库现在只在 TTS 不可用时当兜底。

## 表情与语音的保底

人设卡里可以写倾向（`stickerWhen` / `voiceWhen`）和保底频率：

```json
{
  "stickerMinEvery": 7,     // 最多连着 7 条没发表情，第 7 条强制补一个
  "voiceMinEvery": 30      // 最多连着 30 条没发语音，第 30 条强制补一条
}
```

保底在桥接侧执行，不依赖模型自觉。计数按"一条回复"算，不按气泡算。

## 目录结构

```
personas/
  <id>\
    meta.json          人设卡 + 音色描述 + 台词库 + 表达倾向
    persona.md         纯人设卡（方便查看）
    <id>.breeze        音色文件（Breeze 格式）
    preview.wav        音色试听
    lines\             台词 wav
  <id>.bundle.json     可分发的包（人设 + 元数据）
  <id>\                 一个人设一个目录
```

## 分享给别人

`POST /studio/export {"id":"xxx"}` 会生成 `personas/xxx.bundle.json`。

对方把文件放进自己的 `personas/` 目录，或者调
`POST /studio/import {"bundle": {...}}` 导入。

音色和台词 wav 不在 bundle 里（太大），但 `hasVoice` / `hasLines` 字段会标明
对方是否需要重新生成。

## 接口

```
GET  /studio/personas              列所有人设
GET  /studio/progress              台词库合成进度
GET  /studio/audio?id=&kind=       试听（kind=preview | line&key=）
POST /studio/generate  {raw}       描述 → 人设草稿
POST /studio/save      {draft}     保存草稿
POST /studio/activate  {id}        切换（下一句生效，不需重启）
POST /studio/remove    {id}        删除
POST /studio/voice     {id}        生成音色
POST /studio/lines     {id}        生成台词库（后台跑）
POST /studio/export    {id}        导出 bundle
POST /studio/import    {bundle}    导入 bundle
```

## 运行时人设在哪

人设存在 `persona-extra.md`，桥接**每条消息都重读这个文件**，
所以切换人设下一句就生效，不需要重启任何东西。

`~/.dsh/profiles/headless/cordis.patch.yml` 里的 `personaPrefix` 现在是中性说明，
只讲"你是谁见下面的人设卡"，具体人设全靠这个文件注入。

## 依赖

```
Breeze TTS   <breeze-dir>/breeze-cli.exe
模型          <model>.gguf  (约 3.2 GB, Vulkan)
```

没装 Breeze 也能用人设功能——只是不能生成音色和语音。