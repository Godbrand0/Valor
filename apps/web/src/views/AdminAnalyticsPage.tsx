'use client'

import { useCallback, useEffect, useState } from 'react'
import { BTN_GOLD, PANEL, PageBanner, SectionTitle, SignInCard, Stat, Badge, CountUp, compact } from '@/components/admin/ui'
import { Explorer, Ring, Spark, type DayPoint } from '@/components/admin/charts'

// Chain-only analytics, produced by the separate Analytics repo (github.com/MarvyNwaokobia/Analytics)
// and published as JSON. Everything here is derived from Valor's contract events on Celo.
// GitHub's API returns the latest committed file with no CDN lag; the raw URL is cached for ~5 minutes.
const FEED_API =
  process.env.NEXT_PUBLIC_ANALYTICS_API_URL ??
  'https://api.github.com/repos/MarvyNwaokobia/Analytics/contents/public/valor.json?ref=main'
const FEED =
  process.env.NEXT_PUBLIC_ANALYTICS_URL ??
  'https://raw.githubusercontent.com/MarvyNwaokobia/Analytics/main/public/valor.json'
const SESSION_KEY = 'valor-admin-session' // same key AdminPage writes

type Day = DayPoint
interface Week { weekStart: string; active: number; newPlayers: number; retainedNextWeek: number | null }
interface Target { id: string; label: string; kind: string; target: number; actual: number | null; baseline: number | null; pct: number | null }
interface Epoch { epoch: number; start: string; end: string; status: string; txs: number; gMoved: number; gSpent: number; revenue: number; rewards: number; newPlayers: number; activePlayers: number }
interface Report {
  name: string; asOf: string; startDate: string
  definitions: Record<string, string>
  excludedWallets: { wallet: string; label: string }[]
  totals: Record<string, number | string | null>
  days: Day[]; weekly: Week[]; latestRetentionPct: number | null
  season: { name: string; start: string; end: string; started: boolean; targets: Target[]; epochs: Epoch[] } | null
}

const n = (v: number | null | undefined, d = 0) =>
  v === null || v === undefined ? 'n/a' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d })

function hasAdminSession(): boolean {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return false
    return (JSON.parse(raw) as { expires_at: number }).expires_at * 1000 > Date.now()
  } catch {
    return false
  }
}

const DEF_NAMES: Record<string, string> = {
  player: 'Player', active: 'Active player', gMoved: 'G$ moved', gSpentInApp: 'G$ spent in app',
  revenue: 'Revenue to Valor', withdrawFee: 'Withdrawal fee', duelCut: 'Duel house cut', offchain: 'Not on-chain yet',
}

const epochTone = (s: string) => (s === 'active' || s === 'live' ? 'green' : s === 'upcoming' ? 'slate' : 'gold') as 'green' | 'slate' | 'gold'
const epochLabel = (s: string) => (s === 'active' || s === 'live' ? 'Live' : s === 'upcoming' ? 'Upcoming' : 'Complete')

export default function AdminAnalyticsPage() {
  const [ready, setReady] = useState(false)
  const [authed, setAuthed] = useState(false)
  const [data, setData] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)

  useEffect(() => { setAuthed(hasAdminSession()); setReady(true) }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      let res = await fetch(FEED_API, { headers: { Accept: 'application/vnd.github.raw' }, cache: 'no-store' }).catch(() => null)
      if (!res || !res.ok) res = await fetch(`${FEED}?t=${Date.now()}`, { cache: 'no-store' }) // API rate-limited: fall back
      if (!res.ok) throw new Error(`feed returned ${res.status}`)
      setData(await res.json())
      setFetchedAt(new Date())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not load the analytics feed')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (authed) void load() }, [authed, load])

  if (!ready) return null
  if (!authed) {
    return <SignInCard title="On-chain analytics" body="Sign in on the Season ops page first, then come back here in the same tab." href="/admin" cta="Go to Season ops" />
  }

  const t = data?.totals ?? {}
  const tot = (k: string) => (t[k] as number | undefined) ?? 0
  const spark = (k: keyof Day) => (data?.days ?? []).slice(-60).map((d) => d[k] as number)
  const cumNew = (() => { let s = 0; return (data?.days ?? []).slice(-60).map((d) => (s += d.newPlayers)) })()
  const age = data ? (Date.now() - new Date(data.asOf).getTime()) / 36e5 : 0
  const checked = t.verifiedCheckedAt ? new Date(String(t.verifiedCheckedAt)).toLocaleDateString() : null

  const hero: { label: string; value: number; unit?: string; sp: number[] }[] = [
    { label: 'Players', value: tot('players'), sp: cumNew },
    { label: 'G$ paid to players', value: tot('rewardsPaid'), unit: 'G$', sp: spark('rewards') },
    { label: 'On-chain txs', value: tot('txs'), sp: spark('txs') },
    { label: 'Active this month', value: tot('mau'), sp: spark('activePlayers') },
  ]

  return (
    <div className="flex flex-col gap-8 w-full">
      <PageBanner
        kicker="Intelligence"
        title="On-chain Analytics"
        sub={<>Read straight from Valor&apos;s contracts on Celo{data ? `, since ${data.startDate}` : ''}. Nothing here comes from our own database, so anyone can verify it on Celoscan.</>}
        actions={
          <button onClick={() => void load()} disabled={loading} className={`${BTN_GOLD} px-4 py-2.5 text-sm`}>
            <svg className={loading ? 'animate-spin' : ''} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
            {loading ? 'Loading' : fetchedAt ? `Refresh · ${fetchedAt.toLocaleTimeString()}` : 'Refresh'}
          </button>
        }
        aside={data ? (
          <>
            <div className="rounded-xl border border-valor-border/80 bg-black/45 backdrop-blur px-4 py-3">
              <p className="text-[9px] uppercase tracking-[0.22em] font-bold text-slate-500">Data as of</p>
              <p className="text-sm font-bold text-white mt-1.5 flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${age > 12 ? 'bg-orange-400' : 'bg-emerald-400 animate-pulse'}`} />
                {new Date(data.asOf).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </p>
              <p className="text-[11px] text-slate-500 mt-0.5">Refreshes every hour</p>
            </div>
            <div className="rounded-xl border border-valor-border/80 bg-black/45 backdrop-blur px-4 py-3">
              <p className="text-[9px] uppercase tracking-[0.22em] font-bold text-slate-500">Season</p>
              <p className="text-sm font-bold text-white mt-1.5 truncate">{data.season ? data.season.name : 'None configured'}</p>
              <p className={`text-[11px] mt-0.5 ${data.season?.started ? 'text-emerald-400' : 'text-amber-400'}`}>{data.season ? (data.season.started ? 'Live' : 'Awaiting launch') : ' '}</p>
            </div>
          </>
        ) : undefined}
      />

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          Could not load analytics: {error}. The feed is published by the Analytics repo (<code>npm run refresh</code> then push <code>public/valor.json</code>).
        </div>
      )}

      {!data && !error && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-28 rounded-xl border border-valor-border bg-white/[0.03] animate-pulse" />)}
        </div>
      )}

      {data && (
        <>
          {/* Hero numbers */}
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {hero.map((h) => (
              <div key={h.label} className="relative overflow-hidden rounded-xl border border-valor-border bg-linear-to-b from-[#16161f] to-[#0d0d14] p-4 pb-3 transition-colors hover:border-amber-500/40">
                <p className="text-[9px] uppercase tracking-[0.2em] font-bold text-slate-500">{h.label}</p>
                <p className="font-[family-name:var(--font-family-display)] font-black text-[28px] leading-none mt-2 tabular-nums bg-linear-to-b from-amber-100 via-amber-300 to-amber-500 bg-clip-text text-transparent">
                  <CountUp value={h.value} format={(v) => compact(v, 1e5)} />
                  {h.unit && <span className="ml-1.5 font-sans text-[11px] font-semibold text-slate-500">{h.unit}</span>}
                </p>
                <Spark values={h.sp} className="w-full h-9 mt-3 -mb-1" />
              </div>
            ))}
          </section>

          {/* Season */}
          {data.season && (
            <section className="flex flex-col gap-4">
              <SectionTitle right={<Badge tone={data.season.started ? 'green' : 'gold'}>{data.season.started ? 'Live' : 'Awaiting launch'}</Badge>}>
                {data.season.name} · {data.season.start} to {data.season.end}
              </SectionTitle>
              {(['stock', 'flow', 'offchain'] as const).map((kind) => {
                const rows = data.season!.targets.filter((x) => x.kind === kind)
                if (!rows.length) return null
                const title = kind === 'stock' ? 'Live totals' : kind === 'flow' ? 'Counted from season start' : 'Tracked off-chain'
                const note = kind === 'stock' ? 'The gold tick marks where the season started.' : kind === 'flow' ? 'Starts at zero on day one.' : 'Not visible in contract data.'
                return (
                  <div key={kind} className="flex flex-col gap-2.5">
                    <p className="text-xs text-slate-300 font-bold">{title} <span className="font-normal text-slate-600">· {note}</span></p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                      {rows.map((x) => {
                        const ret = x.id === 'weeklyRetentionPct'
                        return (
                          <Ring
                            key={x.id}
                            label={x.label}
                            pct={x.pct}
                            baselinePct={kind === 'stock' && x.baseline !== null && x.target ? (x.baseline / x.target) * 100 : null}
                            detail={x.actual === null ? 'not on-chain' : `${n(x.actual, ret ? 1 : 0)}${ret ? '%' : ''} of ${compact(x.target, 1e4)}${ret ? '%' : ''}`}
                          />
                        )
                      })}
                    </div>
                  </div>
                )
              })}

              <div className={`${PANEL} overflow-x-auto p-0 sm:p-0`}>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500 text-left bg-white/[0.02]">
                      {['Epoch', 'Window', 'Status', 'Txs', 'New', 'Active', 'G$ moved', 'Spent', 'Revenue', 'Rewards'].map((h, i) => (
                        <th key={h} className={`px-3.5 py-2.5 font-bold uppercase tracking-wider text-[9px] ${i > 2 ? 'text-right' : ''}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.season.epochs.map((e) => (
                      <tr key={e.epoch} className="border-t border-valor-border text-slate-300 hover:bg-white/[0.02] transition-colors">
                        <td className="px-3.5 py-3 font-[family-name:var(--font-family-display)] font-black text-white">{e.epoch}</td>
                        <td className="px-3.5 py-3 whitespace-nowrap text-slate-400">{e.start} to {e.end}</td>
                        <td className="px-3.5 py-3"><Badge tone={epochTone(e.status)}>{epochLabel(e.status)}</Badge></td>
                        {[e.txs, e.newPlayers, e.activePlayers, e.gMoved, e.gSpent, e.revenue, e.rewards].map((v, i) => (
                          <td key={i} className="px-3.5 py-3 text-right tabular-nums">{compact(v, 1e5)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Explorer */}
          <section className="flex flex-col gap-4">
            <SectionTitle>Daily explorer</SectionTitle>
            <div className={PANEL}>
              <Explorer days={data.days} />
            </div>
          </section>

          {/* All time */}
          <section className="flex flex-col gap-4">
            <SectionTitle>All-time record</SectionTitle>
            <p className="text-[11px] uppercase tracking-[0.2em] font-bold text-slate-500 -mb-1">Players</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Players" count={tot('players')} sub="characters claimed, same as Dune" />
              <Stat label="Verified right now" count={tot('verifiedNow')} sub="lower bound, GoodDollar whitelists lapse" />
              <Stat label="Active this month" count={tot('mau')} sub="players, last 30 days" />
              <Stat label="Active this week" count={tot('wau')} sub="players, last 7 days" />
              <Stat label="Weekly retention" value={data.latestRetentionPct === null ? 'n/a' : `${data.latestRetentionPct}%`} sub="last full week, players" />
              <Stat label="Battles recorded" count={tot('battles')} />
              <Stat label="Earners" count={tot('earners')} sub="wallets paid by a reward pool" />
              <Stat label="Items on-chain" count={tot('itemsRegistered')} />
            </div>
            <p className="text-[11px] uppercase tracking-[0.2em] font-bold text-slate-500 -mb-1 mt-2">Transactions and G$</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Stat label="On-chain txs" count={tot('txs')} sub={`${n(tot('txsLast30d'))} in 30d, ${n(tot('txsLast7d'))} in 7d`} />
              <Stat label="G$ moved" count={tot('gMoved')} format={(v) => compact(v)} unit="G$" sub="in + out, team wallets excluded" />
              <Stat label="G$ spent in app" count={tot('gSpentInApp')} format={(v) => compact(v)} unit="G$" sub="players into Valor contracts" />
              <Stat label="Spent in marketplace" count={tot('gSpentMarketplace')} format={(v) => compact(v)} unit="G$" sub={`${n(tot('marketplacePurchases'))} purchases`} />
              <Stat label="Rewards paid out" count={tot('rewardsPaid')} format={(v) => compact(v)} unit="G$" sub="from both reward pools, duel prizes excluded" />
            </div>
            <p className="text-[11px] uppercase tracking-[0.2em] font-bold text-slate-500 -mb-1 mt-2">Revenue to Valor</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Total revenue" count={tot('revenue')} format={(v) => compact(v)} unit="G$" sub="marketplace + withdrawal fees + duel cut" />
              <Stat label="Marketplace" count={tot('marketplaceRevenue')} format={(v) => compact(v)} unit="G$" sub={`${n(tot('marketplaceRevenueWithdrawn'))} withdrawn from the contract`} />
              <Stat label="Withdrawal fees" count={tot('withdrawFeeRevenue')} format={(v) => compact(v)} unit="G$" sub={`${n(tot('withdrawalsCharged'))} withdrawals, paid to the treasury`} />
              <Stat label="Duel house cut" count={tot('duelCutRevenue')} format={(v) => compact(v)} unit="G$" sub={`${n(tot('duelWins'))} duel wins, kept in the main pool`} />
            </div>
            <p className="text-[11px] uppercase tracking-[0.2em] font-bold text-slate-500 -mb-1 mt-2">Duel stakes</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Staked" count={tot('duelStaked')} format={(v) => compact(v)} unit="G$" sub={`${n(tot('duelStakes'))} stakes, Face-Off and wave race`} />
              <Stat label="Paid to winners" count={tot('duelPaidToWinners')} format={(v) => compact(v)} unit="G$" sub={`${n(tot('duelWins'))} wins`} />
              <Stat label="Refunded" count={tot('duelRefunded')} format={(v) => compact(v)} unit="G$" sub="draws, cancels, lost accept races" />
              <Stat label="Still held in the pool" count={tot('duelUnsettled')} format={(v) => compact(v)} unit="G$" sub="open challenges and unresolved duels" />
            </div>
          </section>

          {/* Weekly */}
          <section className="flex flex-col gap-3">
            <SectionTitle>Weekly players</SectionTitle>
            <div className={`${PANEL} overflow-auto max-h-[26rem] p-0 sm:p-0`}>
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-[#13131c]">
                  <tr className="text-slate-500 text-left bg-white/[0.02]">
                    <th className="px-3.5 py-2.5 font-bold uppercase tracking-wider text-[9px]">Week of</th>
                    <th className="px-3.5 py-2.5 font-bold uppercase tracking-wider text-[9px] text-right">Active</th>
                    <th className="px-3.5 py-2.5 font-bold uppercase tracking-wider text-[9px] text-right">New</th>
                    <th className="px-3.5 py-2.5 font-bold uppercase tracking-wider text-[9px]">Back next week</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.weekly].reverse().map((w) => {
                    const pct = w.retainedNextWeek === null ? null : Math.round((100 * w.retainedNextWeek) / Math.max(1, w.active))
                    return (
                      <tr key={w.weekStart} className="border-t border-valor-border text-slate-300 hover:bg-white/[0.02] transition-colors">
                        <td className="px-3.5 py-2.5 text-slate-400 whitespace-nowrap">{w.weekStart}</td>
                        <td className="px-3.5 py-2.5 text-right tabular-nums">{n(w.active)}</td>
                        <td className="px-3.5 py-2.5 text-right tabular-nums">{n(w.newPlayers)}</td>
                        <td className="px-3.5 py-2.5">
                          {pct === null ? (
                            <span className="text-slate-600">in progress</span>
                          ) : (
                            <div className="flex items-center gap-2.5">
                              <div className="w-24 h-1.5 rounded-full bg-white/5 overflow-hidden"><div className="h-full rounded-full bg-linear-to-r from-amber-600 to-amber-300" style={{ width: `${Math.min(100, pct)}%` }} /></div>
                              <span className="tabular-nums text-slate-400 whitespace-nowrap">{n(w.retainedNextWeek)} ({pct}%)</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Method */}
          <section className="flex flex-col gap-3">
            <SectionTitle>How this is counted</SectionTitle>
            <div className="flex flex-col gap-2">
              {Object.entries(data.definitions).map(([k, v], i) => (
                <details key={k} open={i === 0} className="group rounded-xl border border-valor-border bg-black/25 open:border-amber-500/30">
                  <summary className="cursor-pointer list-none flex items-center justify-between px-4 py-3 text-sm font-bold text-slate-200 [&::-webkit-details-marker]:hidden">
                    {DEF_NAMES[k] ?? k}
                    <span className="text-amber-400 text-lg leading-none transition-transform group-open:rotate-45">+</span>
                  </summary>
                  <p className="px-4 pb-3.5 text-xs text-slate-400 leading-relaxed">{v}</p>
                </details>
              ))}
              <details className="group rounded-xl border border-valor-border bg-black/25 open:border-amber-500/30">
                <summary className="cursor-pointer list-none flex items-center justify-between px-4 py-3 text-sm font-bold text-slate-200 [&::-webkit-details-marker]:hidden">
                  Excluded wallets
                  <span className="text-amber-400 text-lg leading-none transition-transform group-open:rotate-45">+</span>
                </summary>
                <div className="px-4 pb-3.5 flex flex-col gap-1.5 text-xs">
                  {data.excludedWallets.map((w) => (
                    <p key={w.wallet} className="flex items-center gap-2 flex-wrap">
                      <code className="px-1.5 py-0.5 rounded bg-black/40 border border-valor-border text-amber-300">{w.wallet.slice(0, 8)}…{w.wallet.slice(-6)}</code>
                      <span className="text-slate-400">{w.label}</span>
                    </p>
                  ))}
                </div>
              </details>
              <p className="text-[11px] text-slate-600 px-1">
                Verified status is a live GoodDollar whitelist snapshot{checked ? ` from ${checked}` : ''}; it can drop when GoodDollar un-whitelists a wallet.
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

