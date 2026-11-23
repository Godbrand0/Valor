'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useResolvedAuth } from '@/hooks/useResolvedAuth'
import { useGroup, useGroupMembers, useMyGroup, type GroupMember } from '@/hooks/useGroups'
import { useSeasonalRun } from '@/hooks/useSeasonalRun'
import WaveBoard from '@/components/battle/WaveBoard'
import { GroupCrest, groupHue } from '@/components/groups/GroupBadge'
import { RANK_COLORS } from '@/lib/constants'
import { rankLabel } from '@/lib/ranks'
import type { Rank } from '@/types'

const GOLD = '#eab308'

function status(s: { upcoming: boolean; ended: boolean; ends_at: string | null; starts_at: string }): string {
  const left = (iso: string) => {
    const ms = new Date(iso).getTime() - Date.now()
    if (ms <= 0) return 'now'
    const d = Math.floor(ms / 86_400_000)
    const h = Math.floor((ms % 86_400_000) / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
  }
  if (s.upcoming) return `Opens in ${left(s.starts_at)}`
  if (s.ended) return 'Season closed, payouts settling'
  return s.ends_at ? `Live, closes in ${left(s.ends_at)}` : 'Live now'
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-xl px-3 py-3 text-center" style={{ background: 'rgba(255,255,255,0.03)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.07)' }}>
      <p className="font-display font-black text-2xl leading-none tabular-nums" style={{ color: accent ?? '#fff' }}>{value}</p>
      <p className="text-[9px] uppercase tracking-[0.2em] font-bold text-slate-500 mt-1.5">{label}</p>
    </div>
  )
}

function MemberRow({ m, mine }: { m: GroupMember; mine: boolean }) {
  const name = m.username || m.character_name || `${m.wallet_address.slice(0, 6)}…${m.wallet_address.slice(-4)}`
  const rank = m.rank as Rank | null
  const rankColor = rank ? RANK_COLORS[rank] ?? '#94a3b8' : '#475569'
  const inner = (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="flex-1 min-w-0">
        <p className="truncate text-white text-sm font-bold leading-tight">
          {name}
          {mine && (
            <span className="ml-2 align-middle text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded"
                  style={{ background: '#eab308', color: '#0a0a0f' }}>you</span>
          )}
        </p>
        <p className="text-[10px] uppercase tracking-wider mt-0.5 truncate">
          {rank ? (
            <>
              <span className="font-bold" style={{ color: rankColor }}>{rankLabel(rank, m.prestige_level ?? 0)}</span>
              {m.character_class && <span className="text-slate-500"> · {m.character_class}</span>}
            </>
          ) : (
            <span className="text-slate-600">Joined, no character yet</span>
          )}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="font-display font-black text-lg leading-none tabular-nums" style={{ color: m.waves > 0 ? '#fff' : '#475569' }}>{m.waves}</p>
        <p className="text-[9px] uppercase tracking-widest text-slate-600 mt-0.5">waves</p>
      </div>
    </div>
  )
  const style = {
    background: mine ? 'rgba(234,179,8,0.09)' : 'rgba(255,255,255,0.025)',
    boxShadow: `inset 0 0 0 1px ${mine ? 'rgba(234,179,8,0.45)' : 'rgba(255,255,255,0.06)'}`,
  }
  // Only players with a character have a card to open.
  return rank
    ? <Link href={`/card/${m.wallet_address}`} className="block rounded-xl transition-colors hover:bg-white/[0.04]" style={style}>{inner}</Link>
    : <div className="rounded-xl" style={style}>{inner}</div>
}

/**
 * A group's page: who is in it, what the group has scored this season, and its
 * season board. Public, so a group leader can share it and anyone can look without
 * signing in. The group score is its members' season board scores added up.
 */
export default function GroupBoardPage() {
  const { slug: raw } = useParams<{ slug: string }>()
  const slug = (raw ?? '').toLowerCase()
  const { address } = useResolvedAuth()
  const group = useGroup(slug)
  const roster = useGroupMembers(slug)
  const mine = useMyGroup(address)
  const { season } = useSeasonalRun(undefined)
  const [tab, setTab] = useState<'board' | 'members'>('board')

  if (group.isLoading) return <div className="p-8 text-center text-slate-500">Loading…</div>
  if (!group.data) {
    return <div className="p-8 text-center text-slate-500">Group not found.</div>
  }

  const g = group.data
  const hue = groupHue(g.slug)
  const totals = roster.data?.totals
  const members = roster.data?.members ?? []
  const isMember = mine.group?.slug === slug
  const prizeHere = season && (!season.payout_group || season.payout_group.slug === slug)

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[380px]"
           style={{ background: 'radial-gradient(ellipse 70% 60% at 50% 0%, rgba(234,179,8,0.14), transparent 70%)' }} />
      <div className="relative max-w-md mx-auto px-5 pt-10 pb-12">
        <div className="text-center mb-7">
          <div className="flex items-center justify-center gap-2 mb-6">
            <img src="/valor-mark.png" alt="" width={26} height={26} className="opacity-90" />
            <span className="font-display font-black tracking-[0.3em] text-sm text-amber-400">VALOR</span>
          </div>
          <div className="flex justify-center mb-3"><GroupCrest slug={g.slug} name={g.name} size={52} /></div>
          <p className="text-[10px] uppercase tracking-[0.3em] font-bold mb-2" style={{ color: `hsl(${hue} 70% 62%)` }}>Group</p>
          <h1 className="font-display font-black text-white leading-none" style={{ fontSize: 'clamp(2.75rem, 15vw, 4rem)' }}>{g.name}</h1>
          {g.description && <p className="text-slate-400 text-xs mt-2">{g.description}</p>}
        </div>

        <div className="grid grid-cols-3 gap-2 mb-6">
          <Stat label="Members" value={(totals?.members ?? g.members).toLocaleString()} />
          <Stat label="Playing" value={totals ? totals.playing.toLocaleString() : '–'} />
          <Stat label="Group score" value={totals ? totals.score.toLocaleString() : '–'} accent={`hsl(${hue} 85% 68%)`} />
        </div>

        {season && (
          <div className="mb-7 rounded-2xl px-5 py-4 text-center"
               style={{ background: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.3)' }}>
            <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-amber-500/80 mb-1">{season.name}</p>
            {prizeHere && (
              <p className="font-display font-black text-amber-400 text-3xl">{season.prize_pool_g.toLocaleString()} G$</p>
            )}
            <p className="text-slate-400 text-xs mt-1">
              {prizeHere ? 'Top 3 split the prize pool · ' : ''}{status(season)}
            </p>
            <p className="text-slate-600 text-[11px] mt-1">Ranked by waves completed. Ties go to whoever got there first. The group score is every member's waves added up.</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-1 p-1 mb-5 rounded-xl" style={{ background: 'rgba(255,255,255,0.04)' }} role="tablist">
          {(['board', 'members'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className="py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-colors"
              style={tab === t ? { background: '#eab308', color: '#0a0a0f' } : { color: '#94a3b8' }}>
              {t === 'board' ? 'Season board' : `Members${totals ? ` · ${totals.members}` : ''}`}
            </button>
          ))}
        </div>

        {tab === 'board' ? (
          <WaveBoard groupSlug={slug} highlightWallet={address} limit={100} podium title={`${g.name} · Season`} />
        ) : roster.isLoading ? (
          <div className="flex flex-col gap-2" aria-busy>
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-14 rounded-xl animate-pulse" style={{ background: 'rgba(255,255,255,0.04)' }} />)}
          </div>
        ) : members.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 px-4 py-8 text-center">
            <p className="text-slate-400 text-sm font-bold">No members yet</p>
            <p className="text-slate-600 text-xs mt-1">Share the join link to bring your people in.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {members.map((m) => (
              <MemberRow key={m.wallet_address} m={m} mine={m.wallet_address.toLowerCase() === (address ?? '').toLowerCase()} />
            ))}
            {totals && totals.members > members.length && (
              <p className="text-center text-[11px] text-slate-600 mt-1">Showing {members.length.toLocaleString()} of {totals.members.toLocaleString()} members</p>
            )}
          </div>
        )}

        <div className="mt-8 grid grid-cols-2 gap-3">
          <Link href="/seasonal" className="text-center px-4 py-3.5 rounded-xl font-display font-black text-black" style={{ background: GOLD }}>
            Play the Season
          </Link>
          {isMember ? (
            <Link href="/groups" className="text-center px-4 py-3.5 rounded-xl font-bold text-white border border-slate-700">
              All groups
            </Link>
          ) : (
            <Link href={`/join/${slug}`} className="text-center px-4 py-3.5 rounded-xl font-bold text-white border border-slate-700">
              Join {g.name}
            </Link>
          )}
        </div>
        {!isMember && (
          <p className="text-center mt-4">
            <Link href="/groups" className="text-[11px] uppercase tracking-widest font-bold text-slate-500 hover:text-white">All groups</Link>
          </p>
        )}
      </div>
    </div>
  )
}
