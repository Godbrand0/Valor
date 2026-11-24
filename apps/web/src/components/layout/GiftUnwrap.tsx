'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { Gift } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { getPlayerSession } from '@/lib/playerAuth'
import { usePlayerStore } from '@/stores/usePlayerStore'
import { ITEM_RARITY_COLORS } from '@/lib/constants'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'

interface ReceivedGift {
  id: string
  item_id: string
  item_name: string
  item_rarity: keyof typeof ITEM_RARITY_COLORS
  from_wallet: string
  from_name: string | null
  message: string
  seen: boolean
}

/** The player's session token, if they have one — never signs in (this runs
 *  on every page; it must not pop a wallet prompt by itself). */
function token(wallet: string): string | null {
  const s = getPlayerSession()
  return s && s.wallet === wallet.toLowerCase() ? s.token : null
}

/**
 * The "you got a gift" moment (apps/api/src/handlers/gifts.rs). Shows unopened
 * gifts once, newest first; opening marks them seen and pulls the inventory
 * so the item is ready to equip straight away.
 */
export default function GiftUnwrap({ wallet }: { wallet: string }) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const addInventoryItem = usePlayerStore((s) => s.addInventoryItem)
  const [dismissed, setDismissed] = useState(false)

  const { data } = useQuery({
    queryKey: ['gifts-received', wallet.toLowerCase()],
    queryFn: async (): Promise<{ gifts: ReceivedGift[]; unseen: number }> => {
      const t = token(wallet)
      if (!t) return { gifts: [], unseen: 0 }
      const res = await fetch(`${API}/players/${wallet}/gifts`, { headers: { Authorization: `Bearer ${t}` } })
      return res.ok ? res.json() : { gifts: [], unseen: 0 }
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })

  const unseen = (data?.gifts ?? []).filter((g) => !g.seen)
  if (dismissed || unseen.length === 0) return null
  const first = unseen[0]
  const color = ITEM_RARITY_COLORS[first.item_rarity] ?? '#eab308'

  const open = async (goToInventory: boolean) => {
    setDismissed(true)
    // It's already in their inventory server-side; reflect it locally now.
    for (const g of unseen) {
      addInventoryItem({ wallet_address: wallet, item_id: g.item_id, equipped: false, acquired_at: new Date().toISOString() })
    }
    const t = token(wallet)
    if (t) await fetch(`${API}/players/${wallet}/gifts/seen`, { method: 'POST', headers: { Authorization: `Bearer ${t}` } }).catch(() => {})
    void queryClient.invalidateQueries({ queryKey: ['gifts-received', wallet.toLowerCase()] })
    if (goToInventory) router.push('/profile')
  }

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[70] flex items-center justify-center p-6"
        style={{ background: 'rgba(0,0,0,0.75)' }}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      >
        <motion.div
          role="dialog" aria-label="You received a gift"
          className="w-full max-w-sm rounded-2xl p-6 flex flex-col items-center gap-3 text-center"
          style={{ background: 'rgba(10,9,20,0.98)', border: `1px solid ${color}55`, boxShadow: `0 0 60px ${color}33` }}
          initial={{ scale: 0.8, y: 20 }} animate={{ scale: 1, y: 0 }} transition={{ type: 'spring', damping: 14 }}
        >
          <motion.span
            className="w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{ background: `${color}1f`, color }}
            animate={{ rotate: [0, -8, 8, -4, 0] }} transition={{ duration: 0.9, delay: 0.2 }}
          >
            <Gift size={30} />
          </motion.span>
          <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-bold">
            {first.from_name ?? 'A friend'} sent you a gift
          </p>
          <p className="font-display font-black text-2xl" style={{ color }}>{first.item_name}</p>
          {first.message && <p className="text-slate-300 text-sm italic">&ldquo;{first.message}&rdquo;</p>}
          {unseen.length > 1 && <p className="text-slate-500 text-xs">+ {unseen.length - 1} more gift{unseen.length > 2 ? 's' : ''}</p>}
          <div className="flex gap-2 w-full mt-2">
            <button onClick={() => void open(false)} className="flex-1 min-h-11 rounded-xl border border-valor-border text-slate-200 font-bold text-sm">
              Nice!
            </button>
            <button onClick={() => void open(true)} className="flex-1 min-h-11 rounded-xl font-bold text-sm text-black" style={{ background: color }}>
              Equip it
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
