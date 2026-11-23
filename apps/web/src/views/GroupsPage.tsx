'use client'

import Link from 'next/link'
import { useResolvedAuth } from '@/hooks/useResolvedAuth'
import { useGroupList, useMyGroup } from '@/hooks/useGroups'
import { GroupCrest, groupHue } from '@/components/groups/GroupBadge'

/**
 * Every group, ranked by this season's group score (its members' waves completed,
 * added up). Public, so it is the one link that reaches every group page.
 */
export default function GroupsPage() {
  const { address } = useResolvedAuth()
  const list = useGroupList()
  const mine = useMyGroup(address)
  const groups = list.data ?? []

  return (
    <div className="max-w-md mx-auto px-5 pt-10 pb-12">
      <div className="text-center mb-7">
        <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-slate-500 mb-2">This season</p>
        <h1 className="font-display font-black text-white text-4xl leading-none">Groups</h1>
        <p className="text-slate-500 text-xs mt-3">Universities and communities playing Valor. A group&apos;s score is every member&apos;s waves completed this season, added up.</p>
      </div>

      {list.isLoading ? (
        <div className="flex flex-col gap-2" aria-busy>
          {[0, 1, 2].map((i) => <div key={i} className="h-16 rounded-xl animate-pulse" style={{ background: 'rgba(255,255,255,0.04)' }} />)}
        </div>
      ) : groups.length === 0 ? (
        <p className="text-center text-slate-500 text-sm">No groups yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((g, i) => {
            const hue = groupHue(g.slug)
            const isMine = mine.group?.slug === g.slug
            return (
              <Link key={g.slug} href={`/groups/${g.slug}`}
                className="flex items-center gap-3 px-3 py-3 rounded-xl transition-colors hover:bg-white/[0.04]"
                style={{
                  background: isMine ? 'rgba(234,179,8,0.08)' : 'rgba(255,255,255,0.025)',
                  boxShadow: `inset 0 0 0 1px ${isMine ? 'rgba(234,179,8,0.45)' : 'rgba(255,255,255,0.06)'}`,
                }}>
                <span className="w-6 text-center font-display font-black text-sm text-slate-500 tabular-nums">{i + 1}</span>
                <GroupCrest slug={g.slug} name={g.name} size={30} />
                <div className="flex-1 min-w-0">
                  <p className="truncate text-white text-sm font-bold">
                    {g.name}
                    {isMine && (
                      <span className="ml-2 align-middle text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded"
                            style={{ background: '#eab308', color: '#0a0a0f' }}>yours</span>
                    )}
                  </p>
                  <p className="text-[10px] text-slate-500 mt-0.5">
                    {g.members.toLocaleString()} {g.members === 1 ? 'member' : 'members'}
                    {g.playing ? ` · ${g.playing.toLocaleString()} playing` : ''}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-display font-black text-lg leading-none tabular-nums" style={{ color: `hsl(${hue} 85% 68%)` }}>{(g.score ?? 0).toLocaleString()}</p>
                  <p className="text-[9px] uppercase tracking-widest text-slate-600 mt-0.5">score</p>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
