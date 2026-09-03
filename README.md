# dsh-pet — DSH 会话监督挂件

常驻在 DeepSeek Harness（DSH）Web 界面右下角的一个小挂件。它会盯着当前会话里的 AI 助手，每隔几轮读一次会话转写和工具调用记录（diff、命令输出），看它有没有说"改好了"但没贴改动、承诺核实但没真跑、或者话没听完就替你脑补选项。发现问题就生成一段可以直接粘贴回对话的修正 Prompt。

标准 DSH bundle 插件包，代码和立绘素材都打在包里，`dsh plugin` 装完就能用，不用额外配置。

不是聊天宠物，不做"自我复盘"这类事——它审的是 AI 助手，判断依据是会话里出现过的工具调用结果，不是靠语气判断。

> **她自己是这么说的：**
>
> 主人好呀，我是这栋 Harness 里的鲸鱼娘女仆长，就是常年蹲在屏幕右下角那只会呼吸摇摆的小鲸鱼。别看我软乎乎，活儿一点不软——家里那位替主人干活的小鲸鱼（也就是 AI 助手），我盯着呢。她嘴甜是真的甜，但也真爱糊弄事儿：说"改好了"结果 diff 没贴，说"我去核实一下"结果转头就忘。这种事儿她自己在局里头看不出来，得我这个局外人来揪。
>
> 我干活靠证据，不靠猜——会话里工具真跑没跑、命令真出没出结果，我扒开来看，不听她一张嘴瞎白话。逮着问题我不写"发现盲区""建议复盘"这种报告腔，就跟主人唠嗑一样直接说。顺手我还把话写成一段能直接甩回对话框的修正 Prompt，复制粘贴就把她说明白。
>
> 平常我安安静静趴在角落，每隔几轮才冒个泡；不放心随时点我一下，我立刻去瞅瞅她这轮又干了些什么。

## 截图

![面板视图](docs/screenshot.png)

单击挂件展开的面板，可以回看历史记录。这条是它发现助手说"打包完成 / 已包含 / 已打进"，但工具调用记录里并没有对应的文件操作。

![气泡视图](docs/screenshot2.png)

平时以头顶气泡的形式出现，几秒后自动收起。这条是发现助手说"先抓了 A 论文再读 B 论文"，但记录里只碰过 A。

## 是什么、不是什么

跟 AI 协作时容易出现的问题不是它做不到，而是它嘴上说完成了但没有实际证据支撑——diff 没贴、验证没跑、选项是自己脑补的。这类问题当事的助手往往看不出来，因为它自己就是产生这些内容的人。

这个插件相当于一个第三方视角：它不参与当前对话，只在每 N 轮结束后，把会话转写（包含工具调用结果）喂给模型，让它挑出具体的问题，写一段修正建议。输出风格要求口语化，不允许"盲区""复盘"这类空话，只讲能在转写里对上的事实。

## 特性

- 常驻挂件，随包自带立绘，有待机、思考、开心、睡眠几种状态动画
- 可拖拽，位置会记住
- 自动监督：每个收到过真人消息的顶层会话，每满 `reflectEvery`（默认 3）轮触发一次
- 手动触发：点开面板里的"监督观察对话"按钮
- 生成分两步：第一步让模型从转写里挑出具体问题、写修正 Prompt；第二步把结果转述成口语化的短评
- 遇到 token 超限或超时会自动截断上下文重试，不是直接报错
- 立绘素材在 `sprites/` 目录，换皮直接替换同名 PNG 或改 `spriteDir` 配置

## 目录结构

```
dsh-pet/
├── package.json          # DSH bundle 插件元数据
├── README.md
├── cordis.patch.yml      # 插件挂载声明 + persona/配置
├── lib/
│   └── index.js          # 宿主侧：会话监听、读取转写、两步生成、HTTP 路由
├── client/
│   └── client.js         # 浏览器侧：挂件、面板、气泡（__ModuleLoader__ bundle）
└── sprites/               # 内置立绘（三视图各尺寸 PNG）
```

## 安装

### 方式 A：本地链接安装（开发/自用）

在仓库根目录（`package.json` 所在目录）执行：

```sh
dsh plugin --profile web add link:.
```

`dsh plugin` 会把参数转发给 pnpm，成功后写入 `dsh.profile.bundles`。装完需要重启 `dsh web` 并刷新浏览器。源码目录挪了位置要重新 `add link:<新路径>`；提示已存在就先 `remove` 再装。

### 方式 B：打包分发

```sh
npm pack                                   # 产出 dsh-pet-0.1.0.tgz
dsh plugin --profile web add dsh-pet-0.1.0.tgz
```

Tarball 里带了立绘，装的人不用额外配置素材路径。

### 方式 C：GitHub / npm

```sh
dsh plugin --profile web add github:<用户名>/dsh-pet
# 或
dsh plugin --profile web add dsh-pet
```

### 给 AI 的安装说明

想让另一个 DSH / AI 帮你装，可以把下面这段发给它：

> 请帮我安装插件 dsh-pet。步骤：
> 1. 若从仓库链接安装：先 `dsh plugin --profile web remove dsh-pet`（如已存在）。
> 2. 用 `dsh plugin --profile web add link:<dsh-pet 仓库绝对路径>` 安装。
> 3. 重启 `dsh web`，刷新浏览器。
> 4. 验证：`dsh --profile web --dump-config` 应能看到 `dsh-pet` 在 bundles 里；`curl http://127.0.0.1:3080/dsh-pet/status` 返回 200 JSON。

## 配置（`cordis.patch.yml` 里的 `config`）

| key | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `persona` | 见下 | 转述步骤用的人设 prompt，可覆盖 |
| `reflectEvery` | `3` | 每 N 轮完整对话自动观察一次 |
| `contextMessages` | `24` | 喂给模型的最近消息条数 |
| `contextChars` | `9000` | 转写文本上限，超出截断 |
| `spriteDir` | 包内 `./sprites` | 立绘目录，自定义素材改成绝对路径 |
| `temperature` | `0.6` | 采样温度 |
| `maxTokens` | `4096` | 单次生成输出上限 |
| `maxRetries` | `2` | 超 token / 超时后的最大重试次数 |
| `timeoutMs` | `90000` | 单次生成的超时预算 |

想覆盖某个 profile 的配置，在对应 `cordis.patch.yml` 里改 `dsh-pet` 那一项的 `config` 即可。

## 工作原理

1. 宿主监听 `session/event`，对每个顶层会话（非 subagent）统计收到真人消息后完成的回合数。
2. 满 `reflectEvery` 轮或手动触发时，通过 `sessionQuery.readSurface` 读取近期转写，包括 `tool/result`（工具返回、diff、命令输出）。
3. 第一步调用模型，从转写里挑出具体问题（没核实的承诺、没贴改动的"完成"声明、脑补的决策等），输出一段修正 Prompt。
4. 第二步用配置的 persona 把结果转述成口语化的短评。
5. 客户端以面板或气泡展示，气泡带"复制修正 Prompt"按钮。

局限：它只能看到会话日志里呈现的工具结果，看不到更深层的后台运行；没有证据支撑的地方它会照实说没查到，不会编。

## 验证

```sh
dsh --profile web --dump-config | grep -i pet

curl http://127.0.0.1:3080/dsh-pet/status
curl http://127.0.0.1:3080/dsh-pet/reflections
curl http://127.0.0.1:3080/dsh-pet/sprite/正面_306.png
```

浏览器刷新后右下角出现挂件即安装成功。

## 常见问题

- **挂件不出现**：确认 `dsh plugin add` 成功、`--dump-config` 里有 `dsh-pet`，重启 `dsh web` 后刷新页面。
- **自动监督不触发**：需要是顶层会话，且出现过真人消息（插件/steering 注入的不算），并跑满 `reflectEvery` 轮。可看终端 `[dsh-pet] auto: … round N/3` 日志确认计数。
- **报 token 超限 / 超时**：内置自动截断重试；仍失败就看 `[dsh-pet] …failed…` 日志，或调大 `maxTokens` / 调小 `contextChars`。
- **立绘不显示 / 想换形象**：默认用包内 `sprites/`；自定义就把 `spriteDir` 指向包含 `正面_306.png` 等文件的目录。
- **口吻不对**：persona 里已经限制不许用"盲区/没把握/反思/复盘"这类词，想调整风格改 `cordis.patch.yml` 的 `persona`。
- **本地改代码不生效**：`link:` 安装的情况，改完源码要重启 `dsh web`（ESM 模块有缓存）再刷新；tarball/npm 版本要重新打包安装。

## 开发

- 会话监听、读取转写、生成逻辑、HTTP 路由、重试都在 `lib/index.js`。
- 挂件、面板、气泡的交互在 `client/client.js`，`__ModuleLoader__` 手写 CJS，没有构建步骤，改完刷新就生效。

## 许可证

MIT License，见 `package.json` 的 `license` 字段。

## 素材来源

立绘素材来自 [dafeiyu-pet](https://github.com/1190fasheqi/dafeiyu-pet)。
