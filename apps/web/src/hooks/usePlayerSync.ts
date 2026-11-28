import { useEffect } from 'react'
import { usePlayerStore } from '@/stores/usePlayerStore'
import { useActiveWalletClient } from '@/hooks/useActiveWalletClient'
import { authedFetch, useSignInPrompt } from '@/lib/playerAuth'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'
const TIMEOUT_MS = 10_000

function fetchWithTimeout(url: string, signal: AbortSignal) {
  return fetch(url, { signal })
}

export function usePlayerSync(address: string | undefined) {
  const { setPlayer, setInventory, clearPlayer, setPlayerSynced, setVerified, setSyncFailed } = usePlayerStore()
  const walletClient = useActiveWalletClient()
  // Bumps when a session is created (e.g. from the FinishSignIn tap), so the
  // gated inventory read runs again with it.
  const sessionVersion = useSignInPrompt((s) => s.version)

  useEffect(() => {
    if (!address) {
      clearPlayer()
      return
    }

    // Always lowercase — wagmi returns EIP-55 checksummed addresses but
    // the DB stores them normalized (lowercase) via normalize_wallet on the backend.
    const wallet = address.toLowerCase()

    // Guard: Clear cached player immediately if it belongs to a different wallet
    // Optional-chained on purpose. This runs in the effect BODY, outside the
    // try below, so a missing wallet_address here does not fail the sync — it
    // takes down the whole route through the error boundary. The store now
    // validates on rehydrate so this should be unreachable; it stays because
    // the cost of being wrong about that is a crash, and the cost of the guard
    // is one character.
    const cachedPlayer = usePlayerStore.getState().player
    if (cachedPlayer && cachedPlayer.wallet_address?.toLowerCase() !== wallet) {
      clearPlayer()
    }

    let cancelled = false
    let activeController: AbortController | null = null

    async function sync() {
      const controller = new AbortController()
      activeController = controller
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

      try {
        const [playerRes, inventoryRes] = await Promise.all([
          fetchWithTimeout(`${API}/players/${wallet}`, controller.signal),
          // Background: never makes a wallet in another app sign without a tap
          // (that request can't reach it, and expires) — see needsTapToSign.
          authedFetch(`/players/${wallet}/inventory`, { signal: controller.signal }, wallet, walletClient, { background: true }),
        ])

        if (cancelled) return

        if (playerRes.ok) {
          const player = await playerRes.json()
          if (player && player.wallet_address.toLowerCase() === wallet) {
            setPlayer(player)
            setVerified(true)
            setSyncFailed(false)
          } else {
            clearPlayer()
          }
        } else if (playerRes.status === 404) {
          clearPlayer()
          setSyncFailed(false)
        } else {
          setSyncFailed(true)
        }

        if (inventoryRes.ok) {
          const inventory = await inventoryRes.json()
          // `?? []` only ever caught null/undefined. A 200 carrying an object
          // instead of a list went straight into the store — see setInventory.
          setInventory(Array.isArray(inventory) ? inventory : [])
        }

      } catch {
        if (!cancelled) setSyncFailed(true)
      } finally {
        clearTimeout(timeoutId)
        if (!cancelled) setPlayerSynced(true)
      }
    }

    sync()
    // Re-syncs inventory (and player) every 30s, not just on mount/address
    // change — the backend's own view of inventory can move without the
    // player doing anything here (a resale sale settling, a gift landing),
    // and without this an already-open tab would only ever see it on a
    // fresh reload.
    const intervalId = setInterval(sync, 30_000)

    return () => {
      cancelled = true
      clearInterval(intervalId)
      activeController?.abort()
    }
  }, [address, walletClient, sessionVersion, setPlayer, setInventory, clearPlayer, setPlayerSynced, setVerified, setSyncFailed])
}
