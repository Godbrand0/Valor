'use client'

import { useState } from 'react'
import { Loader2, PenLine } from 'lucide-react'
import { signInPlayer, useSignInPrompt } from '@/lib/playerAuth'
import { useActiveWalletClient } from '@/hooks/useActiveWalletClient'

/**
 * For a wallet in another app (MetaMask on a phone, connected through "Other
 * Wallets"): the login signature has to start from a TAP, or the phone won't
 * open MetaMask to show it and the request expires. This banner is that tap.
 * See needsTapToSign in lib/playerAuth.
 */
export default function FinishSignIn({ wallet }: { wallet: string }) {
  const needed = useSignInPrompt((s) => s.needed)
  const walletClient = useActiveWalletClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!needed) return null

  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      await signInPlayer(wallet, walletClient)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in — try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="region" aria-label="Finish signing in"
      className="fixed inset-x-3 z-[65] rounded-xl p-3 flex flex-col gap-2"
      style={{
        top: 'calc(env(safe-area-inset-top, 0px) + 64px)',
        background: 'rgba(10,9,20,0.97)', border: '1px solid rgba(234,179,8,0.45)', boxShadow: '0 10px 30px rgba(0,0,0,0.6)',
      }}
    >
      <div className="flex items-center gap-3">
        <PenLine size={18} className="text-valor-gold shrink-0" />
        <p className="flex-1 text-white text-sm font-bold leading-snug">
          Finish signing in
          <span className="block text-slate-400 text-xs font-normal">
            Tap, approve the request in MetaMask, then come back to Valor.
          </span>
        </p>
        <button onClick={() => void go()} disabled={busy}
          className="shrink-0 min-h-10 px-4 rounded-lg bg-valor-gold text-black font-bold text-sm disabled:opacity-60 flex items-center gap-1.5">
          {busy ? <><Loader2 size={14} className="animate-spin" /> Waiting…</> : 'Sign in'}
        </button>
      </div>
      {error && <p role="alert" className="text-red-400 text-xs">{error}</p>}
    </div>
  )
}
