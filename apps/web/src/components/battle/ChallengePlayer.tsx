'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Search, Loader2, Flame, Swords, Check } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { FREE_STAKE, isFree, type DuelsList } from '@/hooks/useDuels'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'

interface PlayerHit {
  wallet_address: string
  character_name: string
  username: string | null
  rank: string | null
}

type Format = 'live' | 'async'

/**
 * "Challenge a Player" — a REAL fight against a specific person, replacing the
 * old loadout-vs-loadout simulation. Pick who, then how:
 *   - Live  → a Face-Off: both in the arena at once, refereed by the server.
 *   - Async → a Duel: both run the same seeded map whenever suits them.
 * and for what: Free (friendly, no stake, no rating) or a stake tier.
 *
 * It doesn't create anything itself — it hands off to that mode's own page with
 * the opponent and stake filled in, so every confirmation, signature and the
 * notification to the opponent go through the one flow that already does them.
 */
export default function ChallengePlayer({ walletAddress, onBack, prefillOpponent }: {
  walletAddress: string
  onBack: () => void
  prefillOpponent?: string
}) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<PlayerHit[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<{ wallet: string; name: string } | null>(null)
  const [format, setFormat] = useState<Format>('live')
  const [stake, setStake] = useState<number>(FREE_STAKE)

  // The server's stake ladder and whether it takes free duels — the same
  // contract check the Duels/Face-Off pages use, so this never offers a stake
  // the API would refuse.
  const { data: list } = useQuery({
    queryKey: ['duels-terms'],
    queryFn: async (): Promise<DuelsList | null> => {
      const res = await fetch(`${API}/duels`)
      return res.ok ? res.json() : null
    },
    staleTime: 5 * 60_000,
  })
  const tiers = list?.stake_tiers ?? []
  const choices = list?.free_allowed ? [FREE_STAKE, ...tiers] : tiers
  const activeStake = choices.includes(stake) ? stake : (choices[0] ?? stake)

  // ?challenge=<wallet> from a profile or link: resolve it straight away.
  useEffect(() => {
    if (!prefillOpponent || picked) return
    void (async () => {
      const res = await fetch(`${API}/players/${prefillOpponent.toLowerCase()}`)
      if (!res.ok) return
      const p = await res.json() as PlayerHit
      setPicked({ wallet: p.wallet_address, name: p.username || p.character_name })
    })()
  }, [prefillOpponent, picked])

  async function search() {
    const q = query.trim()
    setError(null)
    setHits([])
    if (!q) return
    setSearching(true)
    try {
      if (q.startsWith('0x') && q.length === 42) {
        const res = await fetch(`${API}/players/${q.toLowerCase()}`)
        if (!res.ok) { setError('No player found at that address.'); return }
        const p = await res.json() as PlayerHit
        setPicked({ wallet: p.wallet_address, name: p.username || p.character_name })
        return
      }
      const res = await fetch(`${API}/players/search?q=${encodeURIComponent(q)}&exclude=${walletAddress}`)
      const results = res.ok ? await res.json() as PlayerHit[] : []
      if (!results.length) { setError(`No player named "${q}" found.`); return }
      // Several matches: let the player choose rather than guessing.
      if (results.length === 1) setPicked({ wallet: results[0].wallet_address, name: results[0].username || results[0].character_name })
      else setHits(results)
    } finally { setSearching(false) }
  }

  function send() {
    if (!picked) return
    const qs = new URLSearchParams({ challenge: picked.wallet, name: picked.name, stake: String(activeStake) })
    router.push(`${format === 'live' ? '/faceoff' : '/duels'}?${qs}`)
  }

  const FORMATS: { id: Format; title: string; blurb: string; Icon: typeof Flame; accent: string }[] = [
    { id: 'live', title: 'Live · Face-Off', blurb: 'Both in the arena at once. You get a notification the moment they join.', Icon: Flame, accent: '#f97316' },
    { id: 'async', title: 'Async · Duel', blurb: 'Same map for both, played whenever suits you. Higher score wins.', Icon: Swords, accent: '#eab308' },
  ]

  return (
    <div className="flex flex-col gap-5">
      <button onClick={onBack} className="flex items-center gap-1 text-slate-400 hover:text-white text-sm w-fit">
        <ArrowLeft size={16} /> Back
      </button>
      <div>
        <h1 className="font-display font-black text-white text-2xl tracking-wide">Challenge a Player</h1>
        <p className="text-slate-500 text-sm mt-1">A real fight — pick who, how you play, and what&apos;s on the line.</p>
      </div>

      {/* 1 — who */}
      <section className="rounded-xl border border-valor-border bg-valor-surface p-4 flex flex-col gap-3">
        <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">1 · Opponent</p>
        {picked ? (
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 rounded-full flex items-center justify-center bg-emerald-500/15 text-emerald-400"><Check size={16} /></span>
            <p className="flex-1 min-w-0 text-white font-bold truncate">{picked.name}</p>
            <button onClick={() => { setPicked(null); setQuery('') }} className="text-xs text-slate-400 hover:text-white">Change</button>
          </div>
        ) : (
          <>
            <form onSubmit={(e) => { e.preventDefault(); void search() }} className="flex gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Username or wallet address"
                aria-label="Search for a player"
                className="flex-1 min-w-0 min-h-11 px-3 rounded-lg bg-valor-surface-2 border border-valor-border text-white text-sm outline-none focus:border-valor-gold/60"
              />
              <button type="submit" disabled={searching || !query.trim()}
                className="min-h-11 px-4 rounded-lg bg-valor-gold text-black font-bold text-sm disabled:opacity-40 flex items-center gap-1.5">
                {searching ? <Loader2 className="animate-spin" size={15} /> : <Search size={15} />} Find
              </button>
            </form>
            {error && <p className="text-red-400 text-xs">{error}</p>}
            {hits.length > 0 && (
              <ul className="flex flex-col gap-1">
                {hits.map((h) => (
                  <li key={h.wallet_address}>
                    <button onClick={() => { setPicked({ wallet: h.wallet_address, name: h.username || h.character_name }); setHits([]) }}
                      className="w-full text-left px-3 py-2 rounded-lg bg-valor-surface-2 hover:bg-white/5 flex items-center justify-between gap-2">
                      <span className="text-white text-sm font-bold truncate">{h.username || h.character_name}</span>
                      {h.rank && <span className="text-[10px] text-slate-500 uppercase tracking-wider">{h.rank}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* 2 — how */}
      <section className="rounded-xl border border-valor-border bg-valor-surface p-4 flex flex-col gap-3">
        <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">2 · How you play</p>
        <div className="grid sm:grid-cols-2 gap-2">
          {FORMATS.map((f) => (
            <button key={f.id} onClick={() => setFormat(f.id)} aria-pressed={format === f.id}
              className="text-left p-3 rounded-lg border transition-colors flex gap-3"
              style={{ borderColor: format === f.id ? f.accent : 'rgba(42,42,58,0.9)', background: format === f.id ? `${f.accent}14` : 'transparent' }}>
              <f.Icon size={18} style={{ color: f.accent }} className="mt-0.5 shrink-0" />
              <span>
                <span className="block text-white font-bold text-sm">{f.title}</span>
                <span className="block text-slate-400 text-xs mt-0.5 leading-snug">{f.blurb}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* 3 — stakes */}
      <section className="rounded-xl border border-valor-border bg-valor-surface p-4 flex flex-col gap-3">
        <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">3 · Stakes</p>
        {choices.length === 0 ? (
          <p className="text-slate-500 text-sm">Loading…</p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {choices.map((t) => (
              <button key={t} onClick={() => setStake(t)} aria-pressed={activeStake === t}
                className={`min-h-11 rounded-lg border font-bold text-sm transition-colors ${
                  activeStake === t
                    ? (isFree(t) ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300' : 'border-valor-gold bg-valor-gold/15 text-valor-gold')
                    : 'border-valor-border bg-valor-surface-2 text-slate-300 hover:border-valor-gold/50'
                }`}>
                {isFree(t) ? 'Free' : `${t.toLocaleString()} G$`}
              </button>
            ))}
          </div>
        )}
        <p className="text-slate-500 text-xs">
          {isFree(activeStake)
            ? 'Friendly — nothing staked, no rating change. You both still earn XP.'
            : 'You both stake the same amount; the winner takes the pot (minus a 0.5% pool cut).'}
        </p>
      </section>

      <button onClick={send} disabled={!picked || choices.length === 0}
        className="w-full min-h-12 rounded-xl bg-valor-gold text-black font-black text-sm uppercase tracking-wider disabled:opacity-40">
        {picked ? `Challenge ${picked.name}` : 'Pick an opponent'}
      </button>
      <p className="text-slate-500 text-xs text-center -mt-2">
        They&apos;ll get a notification and can accept from the notification bell, their phone, or the Multiplayer lobby.
      </p>
    </div>
  )
}
