'use client'

import { useState } from 'react'
import { useResolvedAuth } from '@/hooks/useResolvedAuth'
import { useGroupList, useMyGroup } from '@/hooks/useGroups'

/**
 * Communities live on Profile only. A player picks the one they play for (or leaves it);
 * nothing about a community is pushed onto Home or other pages any more.
 */
export default function CommunityPicker() {
  const { address } = useResolvedAuth()
  const mine = useMyGroup(address)
  const list = useGroupList()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  const groups = list.data ?? []
  if (list.isLoading || groups.length === 0) return null

  async function pick(slug: string) {
    setBusy(slug); setError('')
    try { await mine.join(slug) } catch (e) { setError(e instanceof Error ? e.message : 'Could not join') } finally { setBusy(null) }
  }
  async function leave() {
    setBusy('leave'); setError('')
    try { await mine.leave() } catch (e) { setError(e instanceof Error ? e.message : 'Could not leave') } finally { setBusy(null) }
  }

  return (
    <div className="rounded-xl border p-3 flex flex-col gap-2" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.08)' }}>
      <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-500">Community</p>
      {groups.map((g) => {
        const joined = mine.group?.slug === g.slug
        return (
          <div key={g.slug} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-white truncate">{g.name}</p>
              {g.members >= 5 && <p className="text-[10px] text-slate-500">{g.members.toLocaleString()} members</p>}
            </div>
            {joined ? (
              <button onClick={leave} disabled={busy !== null}
                className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-300 border border-white/10 disabled:opacity-40">
                {busy === 'leave' ? '…' : 'Leave'}
              </button>
            ) : mine.group ? (
              <span className="text-[10px] text-slate-600">Leave {mine.group.name} first</span>
            ) : (
              <button onClick={() => pick(g.slug)} disabled={busy !== null || mine.loading}
                className="px-3 py-1.5 rounded-lg text-xs font-black text-black disabled:opacity-40" style={{ background: '#eab308' }}>
                {busy === g.slug ? '…' : 'Join'}
              </button>
            )}
          </div>
        )
      })}
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  )
}
