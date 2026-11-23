'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useResolvedAuth } from '@/hooks/useResolvedAuth'
import { usePlayerStore } from '@/stores/usePlayerStore'
import ChallengePlayer from '@/components/battle/ChallengePlayer'
import LoadingScreen from '@/components/ui/LoadingScreen'
import Redirect from '@/components/ui/Redirect'

/**
 * Ranked (async) PvP — the interim competitive loop while real-time PvP is built
 * (see docs/PVP_NETCODE.md). Challenge any warrior by wallet/name; the server
 * resolves the fight from both loadouts and awards XP to both. Decoupled from the
 * retired turn-based "Classic" page. Now the same real challenge flow as the Fight
 * page (ChallengePlayer): a live Face-Off or an async Duel, free or staked.
 */
export default function RankedPage() {
  const { status, address } = useResolvedAuth()
  const router        = useRouter()
  const player        = usePlayerStore(s => s.player)
  const playerSynced  = usePlayerStore(s => s.playerSynced)
  const searchParams  = useSearchParams()
  const challengeTarget = searchParams.get('challenge') ?? undefined

  if (status === 'loading') return <LoadingScreen />
  if (status === 'unauthenticated' || !address) return <Redirect to="/" />
  if (!player && !playerSynced) return <LoadingScreen />
  if (!player) return <Redirect to="/" />

  return (
    <div className="max-w-2xl mx-auto">
      <ChallengePlayer
        walletAddress={address}
        onBack={() => router.push('/')}
        prefillOpponent={challengeTarget}
      />
    </div>
  )
}
