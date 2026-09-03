/**
 * dsh-pet — DeepSeek 复盘桌宠 (browser half).
 *
 * A self-contained client bundle artifact. It mounts one floating whale over the
 * whole app through the `shell.overlay` slot. The whale is a pure reflective
 * ANALYZER (no chat): the host watches the main DSH working session and after
 * every N completed user→assistant rounds produces a short self-critique
 * ("what are you least confident about / what is the biggest blind spot"). This
 * half polls the host `/dsh-pet/reflections` queue, auto-opens the bubble when a
 * new reflection lands, and offers a "立即复盘" button for a manual one.
 *
 * Plain React is required from the loader module table; the module exports the
 * standard `{ inject, apply }` client-plugin face.
 *
 * Hand-authored as the loader's lazy-CJS factory artifact (no JSX build step):
 * the module defines and registers the component via React.createElement.
 */

window.__ModuleLoader__.load({
  id: 'dsh-pet',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const { useState, useEffect, useRef, useCallback } = react
    const h = react.createElement

    const NS = 'dsh-pet'
    const STYLE_ID = 'dsh-pet-css'
    const LS_POS = 'dsh-pet:pos'
    const HOST_STATUS = '/dsh-pet/status'
    const HOST_REFLECTIONS = '/dsh-pet/reflections'
    const HOST_REFLECT = '/dsh-pet/reflect'
    const SPRITE = {
      front: '/dsh-pet/sprite/正面_306.png',
      side: '/dsh-pet/sprite/侧面_306.png',
      back: '/dsh-pet/sprite/背面_306.png',
    }
    const POLL_MS = 3500
    const MAX_KEEP = 12

    // Latest GUI-selected session id, set by the apply() tracking effect.
    const currentSession = { id: undefined }

    // ---------- styles -----------------------------------------------------
    const CSS = `
.dshpet-root{position:fixed;z-index:2147483000;pointer-events:none;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.dshpet-pet{pointer-events:auto;width:118px;height:124px;cursor:pointer;user-select:none;touch-action:none;-webkit-user-select:none;display:flex;flex-direction:column;align-items:center;justify-content:flex-end}
.dshpet-pet .tag{pointer-events:none;font-size:9px;color:#0b1220;background:rgba(255,255,255,.85);border:1px solid #dfe5ee;border-radius:8px;padding:1px 5px;margin-top:-2px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.08)}
.dshpet-bob{animation:dshpet-bob 3.2s ease-in-out infinite}
.dshpet-bob.thinking{animation:dshpet-bob .7s ease-in-out infinite}
.dshpet-bob.happy{animation:dshpet-wiggle .6s ease-in-out 3}
.dshpet-bob.sleep{animation:dshpet-bob 5s ease-in-out infinite;opacity:.94}
@keyframes dshpet-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@keyframes dshpet-wiggle{0%,100%{transform:rotate(0)}25%{transform:rotate(-4deg)}75%{transform:rotate(4deg)}}
.dshpet-panel{pointer-events:auto;position:absolute;bottom:100px;right:0;width:330px;max-height:72vh;display:flex;flex-direction:column;background:rgba(255,255,255,.58);-webkit-backdrop-filter:blur(20px) saturate(1.35);backdrop-filter:blur(20px) saturate(1.35);color:#12233a;border-radius:22px;box-shadow:0 22px 55px rgba(15,23,42,.2),inset 0 1px 0 rgba(255,255,255,.65);border:1px solid rgba(255,255,255,.55);overflow:hidden;font-size:13px}
.dshpet-panel header{display:flex;align-items:center;gap:8px;padding:11px 14px;background:linear-gradient(135deg,rgba(10,102,255,.9),rgba(6,182,212,.88));color:#fff}
.dshpet-panel header .dot{width:26px;height:26px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;font-size:15px}
.dshpet-panel header .t{flex:1;line-height:1.2}
.dshpet-panel header .t b{font-size:13px;display:block}
.dshpet-panel header .t span{font-size:10px;font-weight:400;opacity:.92}
.dshpet-panel .btn{cursor:pointer;background:none;border:0;color:#fff;opacity:.9;font-size:16px;line-height:1;padding:2px 4px}
.dshpet-panel .btn:hover{opacity:1}
.dshpet-actions{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid rgba(15,23,42,.08);background:transparent}
.dshpet-actions .meta{flex:1;font-size:10px;color:#5b6472;line-height:1.4;text-shadow:0 1px 0 rgba(255,255,255,.5)}
.dshpet-actions .meta b{color:#334155}
.dshpet-actions button.reflect{flex-shrink:0;border:0;border-radius:12px;padding:9px 12px;cursor:pointer;font-weight:700;background:linear-gradient(135deg,#0a66ff,#06b6d4);color:#fff;font-size:13px;box-shadow:0 4px 12px rgba(10,102,255,.28)}
.dshpet-actions button.reflect:hover{filter:brightness(1.05)}
.dshpet-actions button.reflect:disabled{opacity:.55;cursor:default;filter:none}
.dshpet-list{flex:1;overflow-y:auto;min-height:0;padding:8px;display:flex;flex-direction:column;gap:8px;background:transparent}
.dshpet-entry{background:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.6);border-radius:14px;padding:9px 11px;box-shadow:0 2px 8px rgba(15,23,42,.05),inset 0 1px 0 rgba(255,255,255,.5);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.dshpet-entry .eh{display:flex;align-items:center;gap:6px;font-size:10px;color:#8a94a6;margin-bottom:4px}
.dshpet-entry .eh .pill{flex-shrink:0;font-size:9px;padding:0 6px;border-radius:6px;line-height:1.6}
.dshpet-entry .eh .pill.auto{background:#e7f0ff;color:#0a66ff}
.dshpet-entry .eh .pill.manual{background:#e7faf0;color:#0a9b5a}
.dshpet-entry .eh time{margin-left:auto}
.dshpet-entry .body{white-space:pre-wrap;word-break:break-word;line-height:1.5;font-size:12.5px;color:#111827}
.dshpet-fixrow{display:flex;justify-content:flex-end;margin-top:6px;padding-top:6px;border-top:1px dashed #e5e9f2}
.dshpet-fix{border:1px solid #d5def0;background:#fff;color:#0a66ff;border-radius:7px;font-size:11px;padding:3px 9px;cursor:pointer;font-weight:600;transition:all .15s}
.dshpet-fix:hover{background:#f0f6ff}
.dshpet-fix.done{color:#0a9b5a;border-color:#bfe8d5;background:#eafaf2}
.dshpet-err{font-size:12px;color:#d93f3f;background:#fdecec;border:1px solid #f5c6c6;border-radius:10px;padding:8px 10px;margin:0 8px 8px}
.dshpet-empty{padding:26px 16px;text-align:center;color:#9aa3b2;font-size:12px;line-height:1.7}
.dshpet-pending{display:flex;align-items:center;gap:8px;padding:10px 12px;color:#5b6472;font-size:12px}
.dshpet-pending .spinner{width:14px;height:14px;border:2px solid #cfe0ff;border-top-color:#0a66ff;border-radius:50%;animation:dshpet-spin .8s linear infinite}
@keyframes dshpet-spin{to{transform:rotate(360deg)}}
.dshpet-girl{position:relative;pointer-events:none;display:flex;flex-direction:column;align-items:center;animation:dshpet-sway 6s ease-in-out infinite}
.dshpet-girlimg{height:118px;width:auto;object-fit:contain;display:block;filter:drop-shadow(0 6px 8px rgba(10,18,32,.16));transform-origin:50% 98%;animation:dshpet-breathe 3.6s ease-in-out infinite}
.dshpet-girlimg.happy{animation:dshpet-wiggle .6s ease-in-out 3,dshpet-breathe 3.6s ease-in-out infinite}
.dshpet-girlimg.sleep{animation-duration:6.5s;opacity:.94}
.dshpet-girlimg.thinking{animation:dshpet-breathe .9s ease-in-out infinite}
@keyframes dshpet-breathe{0%,100%{transform:scaleY(1) scaleX(1)}50%{transform:scaleY(.965) scaleX(1.03)}}
@keyframes dshpet-sway{0%,100%{transform:translateX(0)}20%{transform:translateX(1.5px)}80%{transform:translateX(-1.5px)}}
.dshpet-glyph{position:absolute;top:-3px;left:50%;transform:translateX(-50%);font-size:12px;color:#334155;background:rgba(255,255,255,.9);border:1px solid #dfe5ee;border-radius:10px;padding:0 6px;line-height:1.5;pointer-events:none;white-space:nowrap}
.dshpet-bubble{pointer-events:auto;position:absolute;bottom:104px;right:-8px;width:min(300px,76vw);min-width:220px;box-sizing:border-box;background:#fff;color:#332a3d;border-radius:20px 20px 20px 7px;padding:15px 14px 10px;box-shadow:0 18px 44px rgba(20,12,60,.22),0 3px 10px rgba(0,0,0,.06);transform-origin:100% 100%;animation:dshpet-pop .25s cubic-bezier(.2,1.4,.4,1);font-family:'Comic Sans MS','Chalkboard SE','Hiragino Maru Gothic ProN',ui-rounded,system-ui,sans-serif}
.dshpet-bubble::before{content:'';position:absolute;top:0;left:0;right:0;height:6px;border-radius:20px 20px 0 0;background:linear-gradient(90deg,#22d3ee,#3b82f6,#a78bfa)}
.dshpet-bubble::after{content:'';position:absolute;bottom:-11px;right:34px;width:0;height:0;border:11px solid transparent;border-top:12px solid #fff;filter:drop-shadow(0 1px 0 rgba(10,18,32,.08))}
@keyframes dshpet-pop{0%{transform:scale(.6) translateY(6px);opacity:0}100%{transform:scale(1) translateY(0);opacity:1}}
.dshpet-bub-head{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.dshpet-bub-ava{width:26px;height:26px;border-radius:50%;flex-shrink:0;background:linear-gradient(135deg,#a5f3fc,#93c5fd);display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.dshpet-bub-name{font-weight:800;font-size:13px;color:#0ea5b7;letter-spacing:.2px}
.dshpet-bub-name small{display:block;font-weight:600;font-size:10px;color:#94a3b8;letter-spacing:0}
.dshpet-bub-x{margin-left:auto;cursor:pointer;background:#f1f5f9;border:0;border-radius:50%;width:20px;height:20px;line-height:1;font-size:11px;color:#475569;flex-shrink:0}
.dshpet-bub-x:hover{background:#e2e8f0;color:#0f172a}
.dshpet-bub-text{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.55;color:#3b3347}
.dshpet-bub-row{display:flex;justify-content:flex-end;margin-top:8px}
.dshpet-bub-row .dshpet-fix{background:linear-gradient(135deg,#0a66ff,#06b6d4);color:#fff;border:0;box-shadow:0 2px 6px rgba(10,102,255,.3)}
.dshpet-bub-row .dshpet-fix:hover{filter:brightness(1.05)}
.dshpet-bub-row .dshpet-fix.done{background:#0a9b5a;color:#fff}
.dshpet-ack{pointer-events:none;position:absolute;bottom:120px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:7px;max-width:min(300px,72vw);padding:8px 15px;border-radius:999px;background:rgba(12,20,38,.34);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.38);box-shadow:0 10px 26px rgba(0,0,0,.16),inset 0 1px 0 rgba(255,255,255,.25);color:#fff;font-size:13.5px;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.28);text-align:center;white-space:nowrap;animation:dshpet-ack 2.6s cubic-bezier(.22,1,.36,1) forwards}
.dshpet-ack-ico{font-size:15px;filter:drop-shadow(0 1px 1px rgba(0,0,0,.3))}
@keyframes dshpet-ack{0%{opacity:0;transform:translate(-50%,10px) scale(.85)}12%{opacity:1;transform:translate(-50%,0) scale(1)}82%{opacity:1;transform:translate(-50%,0) scale(1)}100%{opacity:0;transform:translate(-50%,-8px) scale(.96)}}
`

    function injectStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.dataset.plugin = 'dsh-pet'
      el.textContent = CSS
      document.head.appendChild(el)
    }

    // ---------- whale avatar ----------------------------------------------
    function Whale({ mood }) {
      const eyeClosed = mood === 'sleep'
      const eyeWink = mood === 'happy' || mood === 'thinking'
      const eye = eyeClosed
        ? h('path', { d: 'M10 15 q3 -2 6 0', stroke: '#0b1220', strokeWidth: '1.8', fill: 'none', strokeLinecap: 'round' })
        : h('circle', { cx: 13, cy: 14, r: eyeWink ? 1.4 : 2, fill: '#0b1220' })
      const sparkle = eyeWink
        ? h('path', { d: 'M6 8 l1.4 2 2 1 -2 1 -1.4 2 -1.4 -2 -2 -1 2 -1 Z', fill: '#fff', opacity: '.85' })
        : null
      const mouth = h('path', {
        d: mood === 'happy' ? 'M8 19 q3 3 6 0' : 'M8 19 q3 1.6 6 0',
        stroke: '#0b1220', strokeWidth: '1.5', fill: 'none', strokeLinecap: 'round',
      })
      return h('svg',
        { viewBox: '0 0 32 32', width: '74', height: '74', style: { display: 'block' } },
        h('g', { transform: 'rotate(-6 16 16)' },
          h('path', { d: 'M25 13 q6 -2 6 -7 q0 6 -4 8 q2 4 -2 4 Z', fill: '#0891b2' }),
          h('ellipse', { cx: '13', cy: '17', rx: '11', ry: '9', fill: '#3b9fff' }),
          h('ellipse', { cx: '13', cy: '20', rx: '7.5', ry: '5', fill: '#cfe9ff' }),
          h('path', { d: 'M6 12 q-4 2 -3 7 q3 -2 4 -4 Z', fill: '#2b7fe0' }),
          sparkle, eye, mouth,
          h('text', { x: '20', y: '8', fontSize: '7', fill: '#0b1220' },
            mood === 'thinking' ? '⋯' : mood === 'sleep' ? 'zZ' : ''),
        ),
      )
    }

    function timeStr(ts) {
      try {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      } catch { return '' }
    }

    // Build a corrective prompt a human can paste back into the conversation.
    function promptForFix(text) {
      return (
        '鲸鱼娘女仆长提醒了你一个需要修正或跟进的地方，请据此核对并修正当前会话的工作。\n' +
        '鲸鱼娘女仆长的提醒：\n' + text +
        '\n\n请先点明问题所在，再给出并落实具体修正；完成后说明你改了什么。'
      )
    }
    function copyFallback(text) {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return ok
      } catch (e) { return false }
    }
    function doCopy(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).catch(() => copyFallback(text))
      }
      return Promise.resolve(copyFallback(text))
    }

    // ---------- analyzer component ----------------------------------------
    function DeskPet() {
      const [pos, setPos] = useState(null)
      const [dragging, setDragging] = useState(false)
      const [mood, setMood] = useState('idle')
      const [open, setOpen] = useState(false)
      const [records, setRecords] = useState([])
      const [unread, setUnread] = useState(0)
      const [busyFlag, setBusyFlag] = useState(false)
      const [error, setError] = useState('')
      const [meta, setMeta] = useState(null)
      const [copiedSeq, setCopiedSeq] = useState(null)
      const [bubble, setBubble] = useState(null) // { seq, text, fix } comic bubble over the head
      const [bubCopied, setBubCopied] = useState(false)

      const posRef = useRef(null)
      const currentPosRef = useRef(null)
      const rootRef = useRef(null)
      const lastSeqRef = useRef(0)
      const bubbledRef = useRef(0)
      const busyRef = useRef(false)
      const hadRef = useRef(false) // saw the panel at least once

      // keep the render flag and the ref used by the poll loop in sync
      const setBusy = useCallback((v) => { busyRef.current = v; setBusyFlag(v) }, [setBusyFlag])

      // position restore / default
      useEffect(() => {
        let saved = null
        try { saved = JSON.parse(localStorage.getItem(LS_POS) || 'null') } catch (e) { /* ignore */ }
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
          setPos(saved); currentPosRef.current = saved
        } else {
          const w = 124, m = 18
          const initial = { x: Math.max(m, window.innerWidth - w - m), y: Math.max(m, window.innerHeight - w - m) }
          setPos(initial); currentPosRef.current = initial
        }
      }, [])
      useEffect(() => { currentPosRef.current = pos }, [pos])

      // host status
      useEffect(() => {
        fetch(HOST_STATUS).then((r) => r.json()).then((d) => {
          if (d && d.ok) {
            setMeta(d.analysis || null)
            if (d.analysis && Number.isFinite(d.analysis.latestSeq)) {
              lastSeqRef.current = Math.max(lastSeqRef.current, d.analysis.latestSeq)
              bubbledRef.current = Math.max(bubbledRef.current, d.analysis.latestSeq)
            }
          }
        }).catch(() => { /* host quiet */ })
      }, [])

      // merge records, keep order by seq ascending
      const merge = useCallback((incoming) => {
        if (!Array.isArray(incoming) || incoming.length === 0) return
        setRecords((prev) => {
          const map = new Map(prev.map((r) => [r.seq, r]))
          let added = 0
          for (const rec of incoming) {
            if (rec && Number.isFinite(rec.seq) && !map.has(rec.seq)) {
              map.set(rec.seq, rec); added += 1
            }
          }
          const merged = Array.from(map.values()).sort((a, b) => a.seq - b.seq).slice(-MAX_KEEP)
          return merged
        })
        const maxSeq = incoming.reduce((m, r) => (r && Number.isFinite(r.seq) && r.seq > m ? r.seq : m), lastSeqRef.current)
        return maxSeq
      }, [])

      // Pop a comic speech bubble over the whale-girl's head for a new reminder.
      const showBubble = useCallback((rec) => {
        if (!rec || !Number.isFinite(rec.seq)) return
        if (rec.seq <= bubbledRef.current) return
        bubbledRef.current = rec.seq
        setBubble({ seq: rec.seq, text: rec.speech != null ? rec.speech : rec.text, fix: rec.fixPrompt })
        setBubCopied(false)
      }, [])

      // poll for auto reflections
      useEffect(() => {
        const tick = async () => {
          if (busyRef.current) return // a manual reflect is in flight; poll again later
          try {
            // Report the currently-open dialog session so the host reflects ONLY
            // that session's conversation (this dialog's workspace).
            const sess = currentSession.id || ''
            const res = await fetch(HOST_REFLECTIONS + '?since=' + lastSeqRef.current + '&session=' + encodeURIComponent(sess))
            const data = await res.json()
            if (data && data.ok && Array.isArray(data.reflections) && data.reflections.length > 0) {
              const last = merge(data.reflections)
              if (last > lastSeqRef.current) lastSeqRef.current = last
              const newest = data.reflections[data.reflections.length - 1]
              showBubble(newest) // comic bubble over the whale-girl's head
              setUnread((u) => u + data.reflections.length)
              setMood('happy')
              setTimeout(() => { setMood((m) => (m === 'happy' ? 'idle' : m)) }, 1200)
            } else if (data && data.ok) {
              if (Number.isFinite(data.latestSeq)) lastSeqRef.current = Math.max(lastSeqRef.current, data.latestSeq)
            }
          } catch (e) { /* transient */ }
        }
        tick()
        const t = setInterval(tick, POLL_MS)
        return () => clearInterval(t)
      }, [merge, showBubble])

      const doReflect = useCallback(async () => {
        if (busyRef.current) return
        setBusy(true)
        setError('')
        setMood('thinking')
        setOpen(false) // click observes and immediately closes the popup
        setBubble({ ack: true, text: '收到，开始盯了～' })
        try {
          const body = currentSession.id ? { sessionId: currentSession.id } : {}
          const res = await fetch(HOST_REFLECT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          const data = await res.json()
          if (!data || !data.ok) {
            throw new Error((data && data.error) || ('HTTP ' + res.status))
          }
          const rec = data.reflection
          if (rec && Number.isFinite(rec.seq)) {
            const last = merge([rec])
            if (last > lastSeqRef.current) lastSeqRef.current = last
            lastSeqRef.current = Math.max(lastSeqRef.current, rec.seq)
            showBubble(rec) // comic bubble over the whale-girl's head
            setUnread(0)
          }
          setMood('happy')
          setTimeout(() => { setMood((m) => (m === 'happy' ? 'idle' : m)) }, 1200)
        } catch (e) {
          setError((e && e.message) || String(e))
          setMood('idle')
        } finally {
          setBusy(false)
        }
      }, [merge, setBusy, showBubble])

      // Auto-dismiss the head bubble (ack toast is short-lived).
      useEffect(() => {
        if (!bubble) return
        const t = setTimeout(() => setBubble(null), bubble.ack ? 2600 : 7000)
        return () => clearTimeout(t)
      }, [bubble])

      // sleep while closed
      useEffect(() => {
        if (open) return
        const t = setTimeout(() => setMood('sleep'), 90000)
        return () => clearTimeout(t)
      }, [open])

      // clear unread once the panel is open
      useEffect(() => {
        if (open) {
          hadRef.current = true
          setUnread(0)
        }
      }, [open])

      const onPetClick = useCallback(() => {
        if (dragging) return
        setOpen((o) => !o)
        setMood('happy')
        setTimeout(() => { setMood((m) => (m === 'happy' ? 'idle' : m)) }, 800)
      }, [dragging])

      // drag
      const onPointerDown = useCallback((e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return
        e.preventDefault()
        const start = { x: e.clientX, y: e.clientY, px: pos ? pos.x : 0, py: pos ? pos.y : 0 }
        posRef.current = { start, moved: false }
        setDragging(true)
      }, [pos])
      useEffect(() => {
        if (!dragging) return
        const move = (e) => {
          const d = posRef.current
          if (!d || !pos) return
          if (!d.moved && Math.abs(e.clientX - d.start.x) + Math.abs(e.clientY - d.start.y) > 5) d.moved = true
          if (!d.moved) return
          const next = {
            x: Math.min(Math.max(0, d.start.px + (e.clientX - d.start.x)), window.innerWidth - 124),
            y: Math.min(Math.max(0, d.start.py + (e.clientY - d.start.y)), window.innerHeight - 124),
          }
          currentPosRef.current = next
          setPos(next)
        }
        const up = () => {
          setDragging(false)
          const d = posRef.current
          posRef.current = null
          if (d && d.moved) {
            try { localStorage.setItem(LS_POS, JSON.stringify(currentPosRef.current || pos)) } catch (e) { /* ignore */ }
          }
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
        return () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
        }
      }, [dragging, pos])

      // render
      const rendered = records.slice().reverse() // newest first
      const moodForPet = busyFlag ? 'thinking' : mood === 'sleep' ? 'sleep' : mood === 'happy' ? 'happy' : 'idle'

      let panel = null
      if (open) {
        const header = h('header', {},
          h('div', { className: 't' },
            h('b', {}, '🐳 鲸鱼娘女仆长'),
            h('span', {}, '监督每一个女仆工作'),
          ),
          h('button', { className: 'btn', onClick: () => setOpen(false), title: '收起' }, '✕'),
        )

        const actions = h('div', { className: 'dshpet-actions' },
          h('button', {
            className: 'reflect',
            disabled: busyFlag,
            onClick: doReflect,
            style: { width: '100%', padding: '9px 12px', fontSize: '13px' },
          }, busyFlag ? '观察对话中…' : '监督观察对话'),
        )

        let bodyContent
        if (busyFlag) {
          bodyContent = h('div', { className: 'dshpet-pending' },
            h('div', { className: 'spinner' }),
            '鲸鱼娘女仆长正在盯着这段会话…')
        } else if (rendered.length === 0) {
          bodyContent = h('div', { className: 'dshpet-empty' },
            '还没有记录。\n点上面的按钮开始观察这段对话，\n也可以等鲸鱼娘女仆长自动观察。')
        } else {
          bodyContent = h('div', { className: 'dshpet-list' },
            rendered.map((r) => h('div', { className: 'dshpet-entry', key: r.seq },
              h('div', { className: 'body' }, r.speech != null ? r.speech : r.text),
              h('div', { className: 'dshpet-fixrow' },
                h('button', {
                  className: 'dshpet-fix' + (copiedSeq === r.seq ? ' done' : ''),
                  onClick: () => {
                    const fix = r.fixPrompt || promptForFix(r.speech != null ? r.speech : r.text)
                    doCopy(fix)
                    setCopiedSeq(r.seq)
                    setTimeout(() => setCopiedSeq((cur) => (cur === r.seq ? null : cur)), 1600)
                  },
                }, copiedSeq === r.seq ? '已复制 ✓' : '复制修正 Prompt'),
              ),
            )))
        }

        const errNode = error ? h('div', { className: 'dshpet-err' }, error) : null

        panel = h('div', { style: { position: 'relative' }, ref: rootRef },
          h('div', { className: 'dshpet-panel' }, header, actions, errNode, bodyContent))
      }

      const petWrap = h('div', {
        className: 'dshpet-pet' + (dragging ? ' dragging' : ''),
        style: { position: 'relative' },
        onPointerDown,
        onClick: onPetClick,
        title: '点我展开 · 按住拖动',
      },
        h('div', { className: 'dshpet-girl' },
          h('img', {
            className: 'dshpet-girlimg' +
              (busyFlag || moodForPet === 'thinking' ? ' thinking' : '') +
              (moodForPet === 'happy' ? ' happy' : '') +
              (moodForPet === 'sleep' ? ' sleep' : ''),
            src: SPRITE.front,
            draggable: 'false',
            alt: '鲸鱼娘女仆长',
          }),
          (busyFlag || moodForPet === 'thinking' || moodForPet === 'sleep')
            ? h('span', { className: 'dshpet-glyph' },
                busyFlag || moodForPet === 'thinking' ? '⋯' : 'zZ')
            : null,
        ),
      )

      // Feedback / result shown over the whale-girl's head.
      let bubbleNode = null
      if (bubble) {
        if (bubble.ack) {
          // Transparent glass "ack" toast (收到，开始盯了).
          bubbleNode = h('div', { className: 'dshpet-ack', onClick: (e) => e.stopPropagation() },
            h('span', { className: 'dshpet-ack-ico' }, '🐳'),
            h('span', {}, bubble.text),
          )
        } else {
          const copyNow = () => {
            doCopy(bubble.fix || promptForFix(bubble.text))
            setBubCopied(true)
            setTimeout(() => setBubCopied(false), 1600)
          }
          bubbleNode = h('div', { className: 'dshpet-bubble', onClick: (e) => e.stopPropagation() },
            h('div', { className: 'dshpet-bub-head' },
              h('span', { className: 'dshpet-bub-ava' }, '🐳'),
              h('span', { className: 'dshpet-bub-name' },
                '鲸鱼娘女仆长', h('small', {}, '监督每一个女仆工作'),
              ),
              h('button', { className: 'dshpet-bub-x', onClick: () => setBubble(null), title: '关闭' }, '✕'),
            ),
            h('div', { className: 'dshpet-bub-text' }, bubble.text),
            bubble.fix ? h('div', { className: 'dshpet-bub-row' },
                h('button', {
                  className: 'dshpet-fix' + (bubCopied ? ' done' : ''),
                  onClick: copyNow,
                }, bubCopied ? '已复制 ✓' : '复制修正 Prompt')) : null,
          )
        }
      }

      return h('div', {
        className: 'dshpet-root',
        style: pos ? { left: pos.x + 'px', top: pos.y + 'px' } : { right: '18px', bottom: '18px' },
      }, panel, bubbleNode, petWrap)
    }

    const inject = ['slots', 'sessions']

    function apply(ctx) {
      injectStyle()
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-pet',
        label: () => 'dsh-pet',
      }, DeskPet)), 'dsh-pet: shell overlay')

      // Track the GUI's currently-selected session so a manual reflect targets it.
      ctx.effect(() => {
        const sessions = ctx.sessions
        if (!sessions || !sessions.list) return
        const set = () => { currentSession.id = sessions.list.getSnapshot().current }
        set()
        return sessions.list.subscribe(set)
      }, 'dsh-pet: track current session')
    }

    exports.name = NS
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
