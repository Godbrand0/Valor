'use client'

import { useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import type { PlayerSnapshot } from '@/hooks/useArenaSocket'
import { localToWorldXZ } from '@/engine/scene/operatorLocomotion'

/** Dev preview of the Face-Off arena room, bypassing real matchmaking (no
 *  auth, no /ws/arena, no stake) so the visuals can be checked without a
 *  live 2-player match. A fake opponent snapshot stands across the room,
 *  facing you, so the cover/lighting/materials are all visible at once.
 *
 *  `?bot` makes the fake opponent move like a player — forward, strafing both
 *  ways, back-pedalling, crouching, looking up and down — sent at the server's
 *  20 Hz tick rate, so the opponent's animation and interpolation can be
 *  checked without a second account. Wallets are lowercase, as the server
 *  sends them. */
const ArenaScene = dynamic(() => import('@/engine/scene/ArenaScene').then((m) => m.ArenaScene), { ssr: false })

const OPP = '0xopponent'
const WALK = 3.4

/** Bot script: [seconds, forward, right, crouching, pitch] — yaw stays PI
 *  (facing the player at the near end, yaw 0 = -Z). */
const SCRIPT: [number, number, number, boolean, number][] = [
  [1.5, 0, 0, false, 0],
  [1.6, 1, 0, false, 0],
  [1.6, 0, 1, false, 0.15],
  [1.6, 0, -1, false, -0.15],
  [1.6, -1, 0, false, 0],
  [1.5, 0, 0, true, 0],
  [1.6, 0, 1, true, 0],
  [1.6, 0, -1, true, 0],
  [1.6, 1, 0, true, 0],
]

export default function DevFaceoffPreview() {
  const latestPlayers = useRef<Map<string, PlayerSnapshot>>(
    new Map([[OPP, {
      wallet: OPP, x: 0, z: -7.3, yaw: Math.PI, pitch: 0,
      hp: 100, ammo: 30, reloading: false, crouching: false, ads: false,
    }]]),
  )

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('bot')) return
    let x = 0, z = -4, t = 0
    const total = SCRIPT.reduce((n, s) => n + s[0], 0)
    const id = window.setInterval(() => {
      t = (t + 0.05) % total
      let acc = 0
      let step = SCRIPT[0]
      for (const s of SCRIPT) { if (t < acc + s[0]) { step = s; break } acc += s[0] }
      const [, fwd, right, crouching, pitch] = step
      const yaw = Math.PI
      const [dx, dz] = localToWorldXZ(yaw, fwd, right)
      x += dx * WALK * 0.05
      z += dz * WALK * 0.05
      x = Math.max(-3, Math.min(3, x)); z = Math.max(-6.5, Math.min(-1.5, z))
      // A fresh object per tick, like a real state_update.
      latestPlayers.current.set(OPP, {
        wallet: OPP, x, z, yaw, pitch, hp: 100, ammo: 30, reloading: false, crouching, ads: false,
      })
    }, 50)
    return () => window.clearInterval(id)
  }, [])

  return (
    <ArenaScene
      walletAddress="0xlocal"
      opponentWallet={OPP}
      fighting={true}
      sendInput={() => {}}
      drainHits={() => []}
      latestPlayers={latestPlayers}
      onLocalHp={() => {}}
      onAmmo={() => {}}
      onOpponentHp={() => {}}
    />
  )
}
