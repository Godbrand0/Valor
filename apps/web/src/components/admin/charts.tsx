'use client'

// Small dependency-free charts for the admin analytics page: a sparkline, a progress
// ring and an interactive daily explorer. Same look as the public dashboard.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { CountUp, PILL, PILL_ON, compact } from './ui'

export interface DayPoint {
  date: string; txs: number; newPlayers: number; activePlayers: number
  gMoved: number; gSpent: number; marketplaceSpend: number; rewards: number
  revenue?: number; staked?: number
}

/* ── smooth line through points (monotone cubic, never overshoots) ───────── */
function smooth(p: [number, number][]): string {
  const N = p.length
  if (N === 0) return ''
  if (N < 3) return 'M' + p.map((x) => x.join(',')).join('L')
  const dx: number[] = [], m: number[] = [], t: number[] = []
  for (let i = 0; i < N - 1; i++) { dx[i] = p[i + 1][0] - p[i][0] || 1e-6; m[i] = (p[i + 1][1] - p[i][1]) / dx[i] }
  t[0] = m[0]; t[N - 1] = m[N - 2]
  for (let i = 1; i < N - 1; i++) {
    t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i])
  }
  let d = `M${p[0].join(',')}`
  for (let i = 0; i < N - 1; i++) {
    d += `C${p[i][0] + dx[i] / 3},${p[i][1] + (t[i] * dx[i]) / 3} ${p[i + 1][0] - dx[i] / 3},${p[i + 1][1] - (t[i + 1] * dx[i]) / 3} ${p[i + 1].join(',')}`
  }
  return d
}

/* ── sparkline ───────────────────────────────────────────────────────────── */
export function Spark({ values, color = '#eab308', className = '' }: { values: number[]; color?: string; className?: string }) {
  const id = useId().replace(/:/g, '')
  if (values.length < 2) return null
  const w = 120, h = 34, mx = Math.max(1, ...values)
  const pts = values.map((v, i): [number, number] => [(i / (values.length - 1)) * w, h - 3 - (v / mx) * (h - 8)])
  const d = smooth(pts)
  return (
    <svg className={className} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".4" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d}L${w},${h}L0,${h}Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/* ── progress ring ───────────────────────────────────────────────────────── */
export function Ring({
  pct, label, detail, baselinePct,
}: { pct: number | null; label: string; detail: string; baselinePct?: number | null }) {
  const R = 46, C = 2 * Math.PI * R
  const id = useId().replace(/:/g, '')
  const [shown, setShown] = useState(0)
  useEffect(() => { const r = requestAnimationFrame(() => setShown(pct ?? 0)); return () => cancelAnimationFrame(r) }, [pct])
  const clamped = Math.min(100, Math.max(0, shown))
  const done = (pct ?? 0) >= 100
  let tick: { x1: number; y1: number; x2: number; y2: number } | null = null
  if (baselinePct != null && baselinePct > 0) {
    const a = (Math.min(100, baselinePct) / 100) * 2 * Math.PI - Math.PI / 2
    tick = { x1: 56 + (R - 6) * Math.cos(a), y1: 56 + (R - 6) * Math.sin(a), x2: 56 + (R + 7) * Math.cos(a), y2: 56 + (R + 7) * Math.sin(a) }
  }
  return (
    <div className="group flex flex-col items-center text-center rounded-xl border border-valor-border bg-linear-to-b from-[#14141d] to-[#0d0d14] px-3 pt-4 pb-3 transition-colors hover:border-amber-500/40">
      <svg viewBox="0 0 112 112" className="w-[104px] h-[104px] overflow-visible" role="img" aria-label={`${label} ${pct == null ? 'not on-chain' : `${pct}%`}`}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a16207" /><stop offset=".6" stopColor="#eab308" /><stop offset="1" stopColor="#fde047" />
          </linearGradient>
        </defs>
        {pct == null ? (
          <>
            <circle cx="56" cy="56" r={R} fill="none" stroke="#34344d" strokeWidth="2" strokeDasharray="3 6" />
            <text x="56" y="62" textAnchor="middle" fill="#6c6c84" fontSize="20">—</text>
          </>
        ) : (
          <>
            <circle cx="56" cy="56" r={R} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="8" />
            <circle
              cx="56" cy="56" r={R} fill="none" strokeWidth="8" strokeLinecap="round"
              stroke={done ? '#34d399' : `url(#${id})`}
              strokeDasharray={`${C} ${C}`} strokeDashoffset={C * (1 - clamped / 100)}
              transform="rotate(-90 56 56)"
              style={{ transition: 'stroke-dashoffset 1.6s cubic-bezier(.16,1,.3,1)', filter: `drop-shadow(0 0 5px ${done ? 'rgba(52,211,153,.5)' : 'rgba(234,179,8,.45)'})` }}
            />
            {tick && <line {...tick} stroke="#fde047" strokeWidth="3" strokeLinecap="round" />}
            <text x="56" y="58" textAnchor="middle" fill="#f3f0e6" fontSize="21" fontWeight="700" style={{ fontFamily: 'var(--font-family-display), serif' }}>{Math.round(pct)}%</text>
            <text x="56" y="73" textAnchor="middle" fill="#6c6c84" fontSize="7.5" letterSpacing="1.2">{done ? 'COMPLETE' : 'OF TARGET'}</text>
          </>
        )}
      </svg>
      <p className="mt-2 text-[12px] font-bold text-white leading-tight">{label}</p>
      <p className="text-[10.5px] text-slate-500 mt-0.5 tabular-nums">{detail}</p>
    </div>
  )
}

/* ── interactive daily explorer ──────────────────────────────────────────── */
const METRICS: { key: keyof Omit<DayPoint, 'date'>; label: string; unit: string }[] = [
  { key: 'txs', label: 'Transactions', unit: '' },
  { key: 'activePlayers', label: 'Active players', unit: '' },
  { key: 'newPlayers', label: 'New players', unit: '' },
  { key: 'gMoved', label: 'G$ moved', unit: ' G$' },
  { key: 'gSpent', label: 'G$ spent in app', unit: ' G$' },
  { key: 'marketplaceSpend', label: 'Marketplace', unit: ' G$' },
  { key: 'revenue', label: 'Revenue to Valor', unit: ' G$' },
  { key: 'staked', label: 'Duel stakes', unit: ' G$' },
  { key: 'rewards', label: 'Rewards paid', unit: ' G$' },
]
const fmtDate = (s: string, o: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) =>
  new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { ...o, timeZone: 'UTC' })

export function Explorer({ days }: { days: DayPoint[] }) {
  const [metric, setMetric] = useState<(typeof METRICS)[number]['key']>('txs')
  const [range, setRange] = useState<'30' | '90' | 'all'>('all')
  const [avg, setAvg] = useState(true)
  const [hover, setHover] = useState<number | null>(null)
  const [W, setW] = useState(640)
  const wrap = useRef<HTMLDivElement>(null)
  const id = useId().replace(/:/g, '')
  const H = 300

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(Math.max(280, el.clientWidth)))
    ro.observe(el); setW(Math.max(280, el.clientWidth))
    return () => ro.disconnect()
  }, [])

  const meta = METRICS.find((m) => m.key === metric)!
  const S = useMemo(() => {
    const sl = range === 'all' ? days : days.slice(-Number(range))
    return sl.map((d) => ({ l: d.date, v: d[metric] || 0 }))
  }, [days, metric, range])
  const N = S.length
  const rolling = useMemo(() => S.map((_, i) => { const a = S.slice(Math.max(0, i - 6), i + 1); return a.reduce((s, x) => s + x.v, 0) / a.length }), [S])

  if (N === 0) return <p className="text-slate-600 text-sm">No daily data yet.</p>

  const pad = { l: 46, r: 12, t: 24, b: 28 }
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b
  const raw = Math.max(1, ...S.map((s) => s.v)), p10 = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p10
  const mx = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p10
  const X = (i: number) => pad.l + (N === 1 ? iw / 2 : (i / (N - 1)) * iw)
  const Y = (v: number) => pad.t + ih - (v / mx) * ih
  const line = smooth(S.map((s, i): [number, number] => [X(i), Y(s.v)]))
  const area = `${line}L${X(N - 1)},${pad.t + ih}L${X(0)},${pad.t + ih}Z`
  const aline = smooth(rolling.map((v, i): [number, number] => [X(i), Y(v)]))
  const pk = S.reduce((b, s, i) => (s.v > S[b].v ? i : b), 0)
  const isPeak = metric === 'activePlayers'
  const total = S.reduce((s, x) => s + x.v, 0)
  const l7 = S.slice(-7).reduce((s, x) => s + x.v, 0)
  const p7 = S.slice(-14, -7).reduce((s, x) => s + x.v, 0)
  const ch = p7 ? Math.round(((l7 - p7) / p7) * 100) : null
  const chTxt = ch === null ? 'no prior week' : `${ch >= 0 ? '▲' : '▼'} ${Math.abs(ch) > 999 ? '999%+' : `${Math.abs(ch)}%`} vs previous 7`
  const activeDays = S.filter((s) => s.v > 0).length

  const at = (clientX: number, el: SVGElement) => {
    const r = el.getBoundingClientRect()
    const x = (clientX - r.left) * (W / r.width)
    setHover(Math.max(0, Math.min(N - 1, Math.round(((x - pad.l) / iw) * (N - 1)))))
  }
  const hv = hover === null ? null : S[hover]
  const tipLeft = hover === null ? 0 : Math.max(75, Math.min(W - 75, X(hover)))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-1.5 flex-wrap" role="tablist" aria-label="Metric">
          {METRICS.map((m) => (
            <button key={m.key} role="tab" aria-selected={metric === m.key} onClick={() => { setMetric(m.key); setHover(null) }}
              className={metric === m.key ? PILL_ON : PILL}>{m.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setAvg((v) => !v)} aria-pressed={avg} className="flex items-center gap-2 text-[11px] font-semibold text-slate-400 hover:text-white">
            <span className={`relative w-7 h-4 rounded-full transition-colors ${avg ? 'bg-amber-500' : 'bg-slate-700'}`}>
              <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${avg ? 'translate-x-3' : ''}`} />
            </span>
            7-day avg
          </button>
          <div className="inline-flex p-0.5 rounded-lg border border-valor-border bg-black/30" role="group" aria-label="Range">
            {(['30', '90', 'all'] as const).map((r) => (
              <button key={r} aria-pressed={range === r} onClick={() => { setRange(r); setHover(null) }}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${range === r ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}>
                {r === 'all' ? 'ALL' : `${r}D`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="font-[family-name:var(--font-family-display)] font-black text-3xl tabular-nums bg-linear-to-b from-amber-100 via-amber-300 to-amber-500 bg-clip-text text-transparent">
          <CountUp value={isPeak ? S[pk].v : total} format={(n) => compact(n, 1e5)} />
        </span>
        <span className="text-xs text-slate-500">{meta.label} · {isPeak ? 'highest single day' : 'total'} · {range === 'all' ? 'since launch' : `last ${range} days`}</span>
      </div>

      <div ref={wrap} className="relative select-none" style={{ height: H }}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block overflow-visible touch-pan-y" role="img" aria-label={`${meta.label} per day`}>
          <defs>
            <linearGradient id={`${id}a`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#eab308" stopOpacity=".42" /><stop offset="1" stopColor="#eab308" stopOpacity="0" /></linearGradient>
            <filter id={`${id}g`} x="-5%" y="-20%" width="110%" height="140%"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          </defs>
          {[0, 1, 2, 3, 4].map((i) => {
            const y = pad.t + ih - (ih * i) / 4
            return (
              <g key={i}>
                <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} stroke={`rgba(255,255,255,${i ? 0.06 : 0.14})`} strokeDasharray={i ? '3 5' : undefined} />
                <text x={pad.l - 10} y={y + 4} textAnchor="end" fontSize="11" fill="#6c6c84">{compact((mx * i) / 4, 1e4)}</text>
              </g>
            )
          })}
          {(() => {
            const ticks = Math.min(6, N)
            return Array.from({ length: ticks }, (_, i) => {
              const idx = ticks === 1 ? 0 : Math.round((i * (N - 1)) / (ticks - 1))
              return <text key={i} x={X(idx)} y={H - 6} textAnchor={i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle'} fontSize="11" fill="#6c6c84">{fmtDate(S[idx].l)}</text>
            })
          })()}
          <path d={area} fill={`url(#${id}a)`} />
          {avg && <path d={aline} fill="none" stroke="#5eead4" strokeWidth="1.8" strokeDasharray="5 5" opacity=".9" />}
          <path d={line} fill="none" stroke="#fde047" strokeWidth="2.4" strokeLinejoin="round" filter={`url(#${id}g)`} />
          {S[pk].v > 0 && (
            <g>
              <path d={`M${X(pk)},${Y(S[pk].v) - 14} l5,5 -5,5 -5,-5z`} fill="#fde047" />
              <text x={Math.min(W - pad.r - 30, Math.max(pad.l + 30, X(pk)))} y={Y(S[pk].v) - 20} textAnchor="middle" fontSize="10" fontWeight="700" letterSpacing="1.5" fill="#fde047">PEAK {compact(S[pk].v, 1e4)}</text>
            </g>
          )}
          {hover !== null && hv && (
            <g pointerEvents="none">
              <line x1={X(hover)} x2={X(hover)} y1={pad.t} y2={pad.t + ih} stroke="#fde047" strokeOpacity=".5" strokeDasharray="3 4" />
              <circle cx={X(hover)} cy={Y(hv.v)} r="6" fill="#07070b" stroke="#fde047" strokeWidth="2.5" />
            </g>
          )}
          <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="transparent"
            onPointerMove={(e) => at(e.clientX, e.currentTarget)} onPointerDown={(e) => at(e.clientX, e.currentTarget)} onPointerLeave={() => setHover(null)} />
        </svg>
        {hover !== null && hv && (
          <div className="absolute z-10 pointer-events-none px-3 py-2 rounded-xl border border-amber-500/40 bg-[#0a0a0f]/95 backdrop-blur shadow-xl min-w-[140px]"
            style={{ left: tipLeft, top: Math.max(0, Y(hv.v) - 16), transform: 'translate(-50%,-100%)' }}>
            <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">{fmtDate(hv.l, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</p>
            <p className="font-[family-name:var(--font-family-display)] font-black text-xl text-amber-300 tabular-nums leading-tight">{hv.v.toLocaleString('en-US')}{meta.unit}</p>
            {avg && <p className="text-[10px] text-cyan-300">7-day avg {rolling[hover].toLocaleString('en-US', { maximumFractionDigits: rolling[hover] < 10 ? 1 : 0 })}</p>}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        {[
          ['Peak day', `${compact(S[pk].v, 1e4)}${meta.unit}`, fmtDate(S[pk].l, { month: 'short', day: 'numeric', year: 'numeric' })],
          ['Daily average', `${compact(total / N, 1e4)}${meta.unit}`, `${activeDays} of ${N} days had activity`],
          ['Last 7 days', `${compact(l7, 1e4)}${meta.unit}`, chTxt],
          ['Latest day', `${compact(S[N - 1].v, 1e4)}${meta.unit}`, fmtDate(S[N - 1].l)],
        ].map(([l, v, c]) => (
          <div key={l} className="rounded-lg border border-valor-border bg-black/25 px-3 py-2.5">
            <p className="text-[9px] uppercase tracking-[0.18em] font-bold text-slate-500">{l}</p>
            <p className="font-[family-name:var(--font-family-display)] font-black text-lg text-white tabular-nums leading-tight mt-0.5">{v}</p>
            <p className="text-[10px] text-slate-500">{c}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
