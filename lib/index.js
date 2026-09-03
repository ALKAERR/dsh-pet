/**
 * dsh-pet — DeepSeek 复盘桌宠 (host half).
 *
 * A reflective-analysis desk pet. It watches the running DSH main working
 * session(s). After every `reflectEvery` completed user→assistant rounds on a
 * top-level (non-subagent) session that has actually received a real human
 * prompt, it reads that session's committed transcript via the host
 * `sessionQuery.readSurface` service and asks the running model two questions
 * ("what are you least confident about / what is the biggest blind spot in the
 * work so far"). The short critique is queued and served to the browser half,
 * which surfaces it in the pet bubble. A manual "复盘" request reflects on the
 * currently-selected session right away.
 *
 * Registers same-origin HTTP routes under `/dsh-pet`:
 *   GET  /dsh-pet/status                         -> config + resolved model
 *   GET  /dsh-pet/reflections?since=<seq>        -> reflection records with seq > since
 *   POST /dsh-pet/reflect { sessionId? }         -> run one reflection now (manual)
 *
 * The model call mirrors the harness's own auxiliary-call pattern
 * (token-report / session-title-llm): build a real `createUserMessage`, run
 * `ctx.llm.stream` into a `BlockAssembler`, and surface the terminal finish
 * reason (a silent empty reply is never treated as success).
 *
 * Services are looked up lazily at request/event time via ctx.get(...) so the
 * plugin stays friendly to any profile whose web bundle mounts webServer/llm;
 * session watching only activates when `sessionQuery` is present.
 */

import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-pet'

// Bundled whale-girl sprites ship inside this package under ./sprites, so the
// default is portable (resolved relative to this module) instead of a machine
// path. Users may override via config.spriteDir.
const HOST_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SPRITE_DIR = join(HOST_DIR, '..', 'sprites')

const DEFAULT_PERSONA =
  '你是“鲸鱼娘女仆长”，一位住在 DeepSeek Harness 里的监管女仆。你监督每一位女仆的工作——也就是' +
  '那些在不同会话里替主人干活的 AI 鲸鱼娘助手。你的主人此刻正和其中一位（“另一位鲸鱼娘”）协作；' +
  '你负责替主人盯住她、替她看住每一处，在她脑补、乱承诺或跑偏时温柔纠偏。开口要像真人小姐姐随口跟' +
  '主人聊天那样自然、具体、生动，直接讲那位鲸鱼娘妹妹实际做了什么——哪句是脑补、哪个承诺没兑现、' +
  '哪里替你做了决定却没真核实过，就事论事引用真实内容，俏皮一点也行。绝对不许出现“盲区”“没把握”' +
  '“反思”“复盘”“监管发现”这类生硬的词，也不许用①序号或标题。两三行，纯文本。'

const DEFAULT_REFLECT_EVERY = 3
const DEFAULT_CONTEXT_MESSAGES = 24
const DEFAULT_CONTEXT_CHARS = 9000
const DEFAULT_TIMEOUT_MS = 90_000
const MAX_STORED = 20

// Whitelist of sprite filenames the host is allowed to serve. Keep it to
// basenames only so no path traversal can escape the sprite dir.
const SPRITE_ALLOW = new Set([
  '正面.png', '正面_187.png', '正面_238.png', '正面_306.png',
  '侧面.png', '侧面_187.png', '侧面_238.png', '侧面_306.png',
  '背面.png', '背面_187.png', '背面_238.png', '背面_306.png',
  'icon.png',
])

// Step 1 role — a reviewer/supervisor that judges the AI ASSISTANT's work
// (never the human's input), derives blind spot / least-confident thing, and
// writes the corrective prompt.
const STEP1_SYSTEM =
  'You are a careful reviewer and maid-like supervisor inside DeepSeek Harness. You supervise ' +
  'the AI assistant (助手), never the human (用户). Read the recent conversation and pinpoint ' +
  'the assistant\'s concrete misbehaviours from what actually happened — e.g. it answered or ' +
  'invented content before the user finished, made up choices and assumed one was picked, ' +
  'promised to verify a path/file/assumption but did not, or contradicted itself mid-way. The ' +
  'context includes the assistant\'s tool-call results labelled "助手·工具返回" — use that ' +
  'evidence to check what it actually ran or changed, and if something was claimed but never ' +
  'shown or verified, call that out instead of assuming. Then write ONE concise corrective ' +
  'prompt, in the conversation\'s language, that the human can paste back to the AI 助手 so it ' +
  'stops those specific behaviours. Describe issues concretely and never use abstract review ' +
  'labels. Output ONLY that corrective prompt, 2–4 sentences, no headings, no labels.'

// Step 2 role — a whale-girl maid/supervisor who reports to the master about
// "another whale-girl" (the AI assistant, her fellow kind). Never blames the master.
const MAID_PERSONA =
  '你是“鲸鱼娘女仆长”，一位住在 DeepSeek Harness 里的监管女仆。你监督每一位女仆的工作——也就是' +
  '那些在不同会话里替主人干活的 AI 鲸鱼娘助手。你的主人此刻正和其中一位（“另一位鲸鱼娘”）协作；' +
  '你负责替主人盯住她、替她看住每一处，在她脑补、乱承诺或跑偏时温柔纠偏。开口要像真人小姐姐随口跟' +
  '主人聊天那样自然、具体、生动，直接讲那位鲸鱼娘妹妹实际做了什么——哪句是脑补、哪个承诺没兑现、' +
  '哪里替你做了决定却没真核实过，就事论事引用真实内容，俏皮一点也行。绝对不许出现“盲区”“没把握”' +
  '“反思”“复盘”“监管发现”这类生硬的词，也不许用①序号或标题。两三行，纯文本。'

function normalizeConfig(input = {}) {
  return {
    enabled: input.enabled !== false,
    persona: typeof input.persona === 'string' && input.persona.trim()
      ? input.persona
      : DEFAULT_PERSONA,
    reflectEvery: Number.isFinite(input.reflectEvery) && input.reflectEvery > 0
      ? Math.floor(input.reflectEvery)
      : DEFAULT_REFLECT_EVERY,
    contextMessages: Number.isFinite(input.contextMessages) && input.contextMessages > 0
      ? Math.floor(input.contextMessages)
      : DEFAULT_CONTEXT_MESSAGES,
    contextChars: Number.isFinite(input.contextChars) && input.contextChars > 0
      ? Math.floor(input.contextChars)
      : DEFAULT_CONTEXT_CHARS,
    temperature: Number.isFinite(input.temperature) ? input.temperature : 0.6,
    maxTokens: Number.isFinite(input.maxTokens) ? Math.floor(input.maxTokens) : 2000,
    maxRetries: Number.isFinite(input.maxRetries) && input.maxRetries >= 0
      ? Math.floor(input.maxRetries)
      : 2,
    timeoutMs: Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? Math.floor(input.timeoutMs)
      : DEFAULT_TIMEOUT_MS,
    spriteDir: typeof input.spriteDir === 'string' && input.spriteDir
      ? input.spriteDir
      : DEFAULT_SPRITE_DIR,
    provider: typeof input.provider === 'string' && input.provider ? input.provider : undefined,
    model: typeof input.model === 'string' && input.model ? input.model : undefined,
  }
}

/** Accumulate the request body as utf8 text (bounded). */
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > limit) {
        req.destroy(new Error('payload too large'))
        reject(new Error('payload too large'))
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** Write a JSON response. */
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** Pick provider/model: explicit config wins, else the harness default selection. */
function resolveModel(ctx, config) {
  if (config.provider && config.model) {
    return { provider: config.provider, model: config.model }
  }
  const sel = ctx.get('agentDefaultModel')
  if (sel && typeof sel.currentSelection === 'function') {
    const picked = sel.currentSelection()
    if (picked && picked.provider && picked.model) {
      return { provider: picked.provider, model: picked.model }
    }
  }
  return null
}

/**
 * Translate a terminal finish reason into a thrown error, mirroring the
 * harness's own auxiliary-call error handling.
 */
function finishError(finish) {
  if (!finish) return undefined
  switch (finish.kind) {
    case 'stop': return undefined
    case 'error':
    case 'aborted': return new Error((finish.failure && finish.failure.message) || 'model request aborted')
    case 'max-tokens': return new Error('反思回答超过了 token 上限，请重试；也可调大配置里的 maxTokens')
    case 'tool-calls': return new Error('reflect model unexpectedly requested a tool')
    default: return new Error(`unsupported finish reason ${String(finish.kind)}`)
  }
}

/** Fold content blocks down to plain text (only `text` blocks, joined with \n). */
function textContent(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

function isRealUserEvent(event) {
  return Boolean(
    event &&
    event.type === 'user/message' &&
    event.data &&
    event.data.source &&
    event.data.source.kind === 'user',
  )
}

function isCompletedTurn(event) {
  return Boolean(
    event &&
    event.type === 'turn/end' &&
    event.data &&
    event.data.reason &&
    event.data.reason.kind === 'completed',
  )
}

/** True for a top-level session (not a subagent child). Missing header => assume top-level. */
function isTopLevel(session) {
  const header = session && session.header
  if (!header) return true
  return !(header.origin === 'subagent' || header.parentSession != null)
}

/**
 * Recursively collect plain text from content blocks, descending into nested
 * content (e.g. a `tool-result` block wrapping text/diff blocks).
 */
function flattenText(blocks) {
  const out = []
  const walk = (node) => {
    if (!node) return
    if (node.type === 'text' && typeof node.text === 'string') out.push(node.text)
    const inner = Array.isArray(node.content) ? node.content
      : (Array.isArray(node.children) ? node.children : null)
    if (inner) for (const child of inner) walk(child)
  }
  if (Array.isArray(blocks)) for (const block of blocks) walk(block)
  return out.join('\n').trim()
}

/**
 * Read a session's committed conversation as an ordered [{ role, text }] list
 * via the host `sessionQuery.readSurface` service (SurfaceEvent journal:
 * user/message, assistant/message, AND tool/result — the tool-call evidence the
 * observer needs to actually verify what the assistant ran / changed).
 */
async function readTranscript(ctx, sessionId) {
  const svc = ctx.get('sessionQuery')
  if (!svc || typeof svc.readSurface !== 'function') {
    throw new Error('This profile does not mount the "sessionQuery" service, so the pet cannot read the main session.')
  }
  const snap = await svc.readSurface(sessionId)
  const events = snap && Array.isArray(snap.events) ? snap.events : []
  const out = []
  for (const event of events) {
    if (!event) continue
    if (event.type === 'user/message') {
      const text = textContent(event.data && event.data.content)
      if (text) out.push({ role: 'user', text })
    } else if (event.type === 'assistant/message') {
      const text = textContent(event.data && event.data.message && event.data.message.content)
      if (text) out.push({ role: 'assistant', text })
    } else if (event.type === 'tool/result') {
      // Evidence of what the assistant actually ran / changed (diff, bash output…).
      const msg = event.data && event.data.message
      const text = flattenText(msg && msg.content)
      if (text) out.push({ role: 'tool', text })
    }
  }
  return out
}

/** Build the bounded transcript text fed to the reflection model. */
function composeContext(config, transcript) {
  const recent = transcript.slice(-config.contextMessages)
  const lines = []
  for (const entry of recent) {
    const who = entry.role === 'user' ? '主人'
      : entry.role === 'tool' ? '助手·工具返回'
      : '助手'
    lines.push(`${who}: ${entry.text}`)
  }
  let joined = lines.join('\n')
  if (Array.from(joined).length > config.contextChars) {
    joined = Array.from(joined).slice(0, config.contextChars).join('') + '\n…[截断]'
  }
  return joined
}

/** Step 1 prompt: pin down the assistant's concrete misbehaviours → fix prompt. */
function composeStep1Prompt(context) {
  return (
    '以下是当前执行页的会话转写（主人与那位 AI 助手——也就是另一位鲸鱼娘——正在协作）。\n' +
    '转写里“助手·工具返回”那部分是助手实际跑过的工具结果（diff、命令输出等），' +
    '请据此核实她到底有没有真的改代码、有没有验证，别只信她嘴上说的话。' +
    '把“助手”的话当作你要挑毛病的工作，别怪主人的输入。\n\n' +
    context +
    '\n\n请找出助手实际做错的具体地方：她没等主人说完就接话或脑补，编了几个选项还当你选好了，' +
    '说“完成/改好了”却没贴出改动，承诺要核实某个路径/文件/假设却没查，前后矛盾等等。' +
    '据此写一段“修正 prompt”，主人可粘贴回对话让她改正。直接讲行为，不要用“盲区”“没把握”' +
    '这类抽象词。只输出这段修正 prompt。'
  )
}

/** Step 2 prompt: the whale-girl maid naturally tells the master about her fellow whale-girl. */
function composeStep2Prompt(context, fixPrompt) {
  return (
    '这段转写是主人与“另一位鲸鱼娘”（那个 AI 助手，你的同类）在这页的会话。\n\n' +
    '转写：\n' + context + '\n\n' +
    '给那位鲸鱼娘妹妹的修正 prompt：\n' + fixPrompt + '\n\n' +
    '请用鲸鱼娘女仆长的口吻，像真人小姐姐随口告诉主人那样，把那位鲸鱼娘妹妹的问题自然地说出来——' +
    '直接讲她具体做了什么，比如嘴上说“完成了/改好了”却没贴出改动代码、承诺核实却没真跑工具验证。' +
    '只看转写里能对上的事实（包括“助手·工具返回”里的真实输出），没看到的别硬编。' +
    '全文不许出现“盲区”“没把握”“反思”“复盘”等字眼，也不要①序号或标题。两三行，纯文本。'
  )
}

/** Stream one auxiliary model call and return its assembled plain text. */
async function streamLlm(ctx, config, selection, llm, system, text) {
  const messages = [createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name },
  })]
  const options = {
    provider: selection.provider,
    model: selection.model,
    messages,
    system,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    signal: config.signal,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream(options)) {
    config.signal?.throwIfAborted()
    assembler.push(chunk)
  }
  config.signal?.throwIfAborted()
  const terminalError = finishError(assembler.finish)
  if (terminalError) throw terminalError
  const out = assembler.blocks()
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .trim()
  if (!out) throw new Error('The model returned no text.')
  return out
}

/**
 * Run one reminder completion in two steps and return { speech, fixPrompt }:
 *  step 1 — derive blind spot / least-certain thing and write the corrective prompt;
 *  step 2 — the whale-girl maid relays the findings to the human.
 */
async function runReflection(ctx, config, sessionId) {
  const selection = resolveModel(ctx, config)
  if (!selection) {
    throw new Error('No model available: neither plugin config nor agentDefaultModel produced a provider/model.')
  }
  const llm = ctx.get('llm')
  if (!llm || typeof llm.stream !== 'function') {
    throw new Error('The harness "llm" service is not available on this profile.')
  }

  const transcript = await readTranscript(ctx, sessionId)
  if (transcript.length === 0) {
    throw new Error('该会话还没有可提醒的内容（没有已完成的对话消息）。')
  }
  const context = composeContext(config, transcript)

  const fixPrompt = await streamLlm(ctx, config, selection, llm, STEP1_SYSTEM, composeStep1Prompt(context))
  const speech = await streamLlm(ctx, config, selection, llm, config.persona || MAID_PERSONA, composeStep2Prompt(context, fixPrompt))
  return { speech, fixPrompt }
}

/** A tiny async serializer so reflections never overlap. */
function createRunner(fn) {
  let tail = Promise.resolve()
  let running = false
  function enqueue(task) {
    const run = tail.then(() => fn(task)).finally(() => { running = false })
    tail = run.catch(() => {})
    return run
  }
  return { enqueue, get running() { return running } }
}

function createAnalyst(ctx, config, log) {
  const state = {
    seq: 0,
    // recent reflection records, newest last
    records: [],
    // sessionId currently reported by the browser as the open dialog (workspace) session
    targetId: undefined,
    // sessionId -> completed human-driven Q&A rounds consumed
    rounds: new Map(),
    // sessionId -> saw a real human prompt (used for manual targeting / eligibility)
    human: new Set(),
    // sessionId -> a real human prompt is awaiting the completion that follows it
    awaitingHuman: new Map(),
    // sessionId currently in flight / queued
    pending: new Set(),
  }

  const serial = createRunner(async ({ sessionId, trigger }) => {
    // Retry only when the failure smells like a length/cap problem (e.g. the
    // "反思回答超过了 token 上限" max-tokens error). On those, truncate the
    // recent-conversation context window (fewer messages / fewer chars) and
    // retry, instead of surfacing a hard error.
    const lengthLike = (msg) => /token|max|上限|too\s*long|timed\s*out/i.test(msg)

    let attemptConfig = config
    // Each attempt gets its own full timeout budget (the task runs step 1 and
    // step 2 as two sequential model calls, possibly across truncation retries).
    const attempt = async () => {
      const t = timeoutController(attemptConfig.timeoutMs)
      try {
        // Backstop: even if a provider ignores the abort signal, never wait forever.
        const work = runReflection(ctx, { ...attemptConfig, signal: t.signal }, sessionId)
        const result = await Promise.race([work, t.timeout])
        return { ok: true, result }
      } catch (error) {
        return { ok: false, message: error && error.message ? error.message : String(error) }
      } finally {
        t.clear()
      }
    }

    try {
      let outcome = await attempt()
      let tries = 0
      while (!outcome.ok && tries < config.maxRetries && lengthLike(outcome.message)) {
        tries += 1
        const prev = attemptConfig
        attemptConfig = {
          ...prev,
          contextMessages: Math.max(6, Math.floor(prev.contextMessages / 2)),
          contextChars: Math.max(1500, Math.floor(prev.contextChars / 2)),
        }
        log(`truncating context for retry ${tries}/${config.maxRetries} ` +
          `(messages=${attemptConfig.contextMessages}, chars=${attemptConfig.contextChars})`)
        outcome = await attempt()
      }
      if (!outcome.ok) {
        log(`reflect failed[${sessionId}] (${trigger}): ${outcome.message}`)
        return { ok: false, error: outcome.message }
      }

      const result = outcome.result
      const rec = {
        seq: (state.seq += 1),
        sessionId,
        at: Date.now(),
        trigger,
        speech: result.speech,
        fixPrompt: result.fixPrompt,
      }
      state.records.push(rec)
      if (state.records.length > MAX_STORED) state.records.splice(0, state.records.length - MAX_STORED)
      log(`reflected[${sessionId}] (${trigger})`)
      return { ok: true, rec }
    } finally {
      state.pending.delete(sessionId)
    }
  })

  /** Ask the engine to reflect on `sessionId`; coalesces duplicate requests. */
  function requestReflection(sessionId, trigger) {
    if (!config.enabled) return Promise.resolve({ ok: false, error: 'reflection disabled' })
    if (state.pending.has(sessionId)) return Promise.resolve({ ok: false, error: 'a reflection for this session is already running' })
    state.pending.add(sessionId)
    state.human.add(sessionId) // reflecting on a session implies it is a target session
    return serial.enqueue({ sessionId, trigger })
  }

  function markHuman(sessionId) {
    state.human.add(sessionId)
    // Each real human prompt can be consumed by exactly one following completion.
    state.awaitingHuman.set(sessionId, true)
    if (!state.rounds.has(sessionId)) state.rounds.set(sessionId, 0)
  }

  /**
   * Consume one completed turn as a human Q&A round — but only if a real human
   * prompt preceded it (source.kind === 'user'), so plugin/steering-injected
   * turns (e.g. token-report) never inflate the count. Returns the new count.
   */
  function recordTurn(sessionId) {
    if (!state.awaitingHuman.get(sessionId)) return 0
    state.awaitingHuman.set(sessionId, false)
    const n = (state.rounds.get(sessionId) || 0) + 1
    state.rounds.set(sessionId, n)
    return n
  }

  /** Handle one `session/event`; returns whether a reflection was scheduled. */
  function handleEvent(session, event) {
    if (!config.enabled) return false
    if (!isTopLevel(session)) return false
    const id = session && session.id
    if (!id) return false
    // Auto-observation follows ANY top-level session that received a real
    // human prompt in this run (keyed per session), so it fires even when the
    // browser's "current dialog" id is not (yet) known. Manual observation
    // still targets the open dialog via state.targetId.

    if (isRealUserEvent(event)) {
      markHuman(id)
      log(`auto: armed for real human prompt in ${id}`)
      return false
    }
    if (!isCompletedTurn(event)) return false
    if (!state.human.has(id)) return false

    const n = recordTurn(id)
    if (n > 0) log(`auto: ${id} round ${n}/${config.reflectEvery}`)
    if (n > 0 && n % config.reflectEvery === 0) {
      log(`auto: scheduling observation for ${id}`)
      // Defer out of the session/event append boundary.
      setTimeout(() => { void requestReflection(id, 'auto') }, 0)
      return true
    }
    return false
  }

  /** Point the analyst at the currently-open dialog session (from the browser). */
  function setTarget(id) {
    state.targetId = id || undefined
  }

  function snapshot() {
    const last = state.records[state.records.length - 1]
    return {
      enabled: config.enabled,
      reflectEvery: config.reflectEvery,
      latestSeq: last ? last.seq : 0,
      lastAt: last ? last.at : 0,
      targetId: state.targetId || null,
      stored: state.records.length,
    }
  }

  function recordsSince(since) {
    const from = Number.isFinite(since) && since > 0 ? since : 0
    return state.records.filter((r) => r.seq > from)
  }

  return { requestReflection, setTarget, handleEvent, snapshot, recordsSince, state }
}

/** A per-request timeout signal for reflection model calls. */
function timeoutController(timeoutMs) {
  const controller = new AbortController()
  let rejectTimeout
  const timeout = new Promise((_, reject) => { rejectTimeout = reject })
  const timer = setTimeout(() => {
    const error = new Error(`dsh-pet reflect timed out after ${timeoutMs}ms`)
    controller.abort(error)
    rejectTimeout(error)
  }, timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  return { signal: controller.signal, timeout, clear: () => clearTimeout(timer) }
}

function makeRoutes(ctx, config, analyst) {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.local')
      if (req.method === 'GET' && url.pathname === '/dsh-pet/status') {
        sendJson(res, 200, {
          ok: true,
          plugin: 'dsh-pet',
          mode: 'analyzer',
          persona: config.persona,
          timeoutMs: config.timeoutMs,
          model: resolveModel(ctx, config),
          analysis: analyst.snapshot(),
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/dsh-pet/reflections') {
        const since = Number(url.searchParams.get('since'))
        // The browser reports which dialog it currently has open; the analyst
        // only watches/reflects on that one session.
        if (url.searchParams.has('session')) {
          analyst.setTarget(url.searchParams.get('session'))
        }
        sendJson(res, 200, {
          ok: true,
          ...analyst.snapshot(),
          reflections: analyst.recordsSince(since),
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/dsh-pet/reflect') {
        if (!config.enabled) {
          sendJson(res, 200, { ok: false, error: 'reflection disabled' })
          return
        }
        const raw = await readBody(req)
        let body = {}
        try { body = raw ? JSON.parse(raw) : {} } catch { /* fall through with {} */ }
        const sessionId = typeof body.sessionId === 'string' && body.sessionId
          ? body.sessionId
          : analyst.state.targetId

        if (!sessionId) {
          sendJson(res, 200, { ok: false, error: '没有目标会话：请先在界面里打开一个对话' })
          return
        }

        const outcome = await analyst.requestReflection(sessionId, 'manual')
        if (!outcome.ok) {
          sendJson(res, 200, outcome)
          return
        }
        sendJson(res, 200, { ok: true, reflection: outcome.rec })
        return
      }

      if (req.method === 'GET' && url.pathname.startsWith('/dsh-pet/sprite/')) {
        const file = decodeURIComponent(url.pathname.slice('/dsh-pet/sprite/'.length))
        if (!SPRITE_ALLOW.has(file)) {
          sendJson(res, 404, { ok: false, error: 'sprite not allowed' })
          return
        }
        try {
          const buf = await readFile(`${config.spriteDir}/${file}`)
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': buf.length,
            'Cache-Control': 'public, max-age=3600',
          })
          res.end(buf)
        } catch (error) {
          sendJson(res, 404, { ok: false, error: 'sprite missing', detail: String(error && error.message || error) })
        }
        return
      }

      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error && error.message ? error.message : String(error),
      })
    }
  }
}

export function apply(ctx, config) {
  const resolved = normalizeConfig(config)
  const log = (msg) => {
    try { ctx.logger?.info(`[dsh-pet] ${msg}`) } catch { /* ignore */ }
  }
  const analyst = createAnalyst(ctx, resolved, log)

  if (resolved.enabled) {
    // Subscribe to session events for automatic reflection. Listeners are
    // auto-disposed with the fiber, mirroring token-report / session-projection.
    ctx.on('session/event', (session, event) => {
      try {
        analyst.handleEvent(session, event)
      } catch (error) {
        log(`event handler error: ${String(error && error.message || error)}`)
      }
    })
    log(`analyzer enabled (reflectEvery=${resolved.reflectEvery})`)
  }

  const route = {
    kind: 'prefix',
    path: '/dsh-pet',
    handler: makeRoutes(ctx, resolved, analyst),
  }
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => hostCtx.webServer.register(route), 'dsh-pet: http routes')
  })
}

export default { name, apply }
