import type { WalletClient } from 'viem'
import { create } from 'zustand'
import { getBridgedProvider } from '@/lib/walletBridge'
import { isMobileBrowser } from '@/lib/mobileWallets'

// Player session — proves ownership of a wallet to the backend (see
// apps/api/src/auth.rs). Mirrors the admin session in AdminPage.tsx, one
// level down: any wallet can get one for itself, not just an allowlisted one.
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'
const SESSION_KEY = 'valor-player-session'

export interface PlayerSession {
  token: string
  wallet: string
  expires_at: number
}

export function getPlayerSession(): PlayerSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed: PlayerSession = JSON.parse(raw)
    if (parsed.expires_at * 1000 <= Date.now()) {
      sessionStorage.removeItem(SESSION_KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function storePlayerSession(session: PlayerSession) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    // Best effort — a failed write just means the next call signs again.
  }
}

export function clearPlayerSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY)
  } catch {
    // no-op
  }
}

// De-duped across callers: several components can discover at once that they
// have no session (e.g. every gated query on first load) — without this they
// would each trigger their own signature prompt back to back.
let pending: Promise<PlayerSession | null> | null = null

/**
 * Does signing need the player's TAP to reach their wallet?
 *
 * A wallet in ANOTHER APP — MetaMask etc. on a phone, connected through
 * Web3Auth's WalletConnect bridge — only sees a request once that app is brought
 * to the front, and a phone browser only lets a page open another app in
 * direct response to a tap. A login signature fired from a background sync
 * goes out over the relay, nobody opens MetaMask, and it dies as WalletConnect's
 * "Request expired". So for these wallets the login waits for a tap (the
 * FinishSignIn banner). Magic (signs in-page) and extensions/in-wallet browsers
 * (prompt pops over the page) keep signing automatically.
 */
export function needsTapToSign(): boolean {
  return getBridgedProvider()?.source === 'web3auth' && isMobileBrowser()
}

/** "Sign-in needed" for a tap-to-sign wallet, plus a counter that bumps each
 *  time a session is created so syncs can re-run. */
export const useSignInPrompt = create<{ needed: boolean; version: number; setNeeded: (v: boolean) => void; bump: () => void }>((set) => ({
  needed: false,
  version: 0,
  setNeeded: (needed) => set({ needed }),
  bump: () => set((s) => ({ version: s.version + 1, needed: false })),
}))

/** Turn a wallet/relay failure into something a player can act on. */
function describeSignInError(err: unknown): string {
  const m = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase()
  if (m.includes('expired') || m.includes('timeout') || m.includes('timed out')) {
    return "Your wallet didn't answer in time. Tap again, approve in MetaMask, then come back here."
  }
  if (m.includes('rejected') || m.includes('denied') || m.includes('cancel')) return 'Sign-in was cancelled in your wallet.'
  if (m.includes('offline') || m.includes('network') || m.includes('fetch')) return 'Connection problem — check your internet and try again.'
  return 'Could not sign in — try again.'
}

/** Sign in, REPORTING why it failed (the FinishSignIn button shows it). */
export async function signInPlayer(address: string, walletClient: WalletClient | undefined): Promise<PlayerSession> {
  const wallet = address.toLowerCase()
  const existing = getPlayerSession()
  if (existing && existing.wallet === wallet) return existing
  if (!walletClient?.account) throw new Error('Your wallet isn\'t connected — reconnect it and try again.')

  if (!pending) {
    pending = (async () => {
      try {
        const message = `Valor Player Login\ntimestamp:${Math.floor(Date.now() / 1000)}`
        let signature: `0x${string}`
        try {
          signature = await walletClient.signMessage({ account: walletClient.account!, message })
        } catch (err) {
          throw new Error(describeSignInError(err))
        }
        const res = await fetch(`${API}/players/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet, message, signature }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string }
          throw new Error(body.error ?? 'Sign-in was refused — try again.')
        }
        const session: PlayerSession = await res.json()
        storePlayerSession(session)
        useSignInPrompt.getState().bump()
        return session
      } finally {
        pending = null
      }
    })()
  }
  const p = pending
  if (!p) throw new Error('Could not sign in — try again.')
  const session = await p
  if (!session) throw new Error('Could not sign in — try again.')
  return session
}

/**
 * The session for `address`, signing in if needed; null if that isn't possible.
 *
 * A tap-to-sign wallet never signs from here — not even from a page's own
 * button, because a fetch/await between the tap and the signature can lose the
 * tap, and a request already in flight would swallow the banner's real tap. It
 * raises the "Finish signing in" banner instead, whose tap calls signInPlayer
 * directly. (`background` is kept for callers that want to say so explicitly.)
 */
export async function ensurePlayerSession(
  address: string,
  walletClient: WalletClient | undefined,
  opts: { background?: boolean } = {},
): Promise<PlayerSession | null> {
  const wallet = address.toLowerCase()
  const existing = getPlayerSession()
  if (existing && existing.wallet === wallet) return existing
  if (!walletClient?.account) return null
  void opts
  if (needsTapToSign()) {
    useSignInPrompt.getState().setNeeded(true)
    return null
  }
  try {
    return await signInPlayer(address, walletClient)
  } catch {
    return null
  }
}

/**
 * Drop-in for the raw `fetch(`${API}/players/...`)` calls scattered across the
 * app, for the routes that now require proof of wallet ownership (see the
 * gated handler list in apps/api/src/handlers/*.rs). Attaches the player
 * session token, signing in first if there isn't one yet, and retries once
 * after a fresh sign-in if the backend rejects the token with a 401.
 */
export async function authedFetch(
  path: string,
  opts: RequestInit,
  address: string,
  walletClient: WalletClient | undefined,
  /** Called from a background sync (not a tap): don't make a tap-to-sign
   *  wallet sign — see needsTapToSign. */
  authOpts: { background?: boolean } = {},
): Promise<Response> {
  let session = getPlayerSession()
  if (!session || session.wallet !== address.toLowerCase()) {
    session = await ensurePlayerSession(address, walletClient, authOpts)
  }

  const withAuth = (token: string | undefined) => {
    const headers = new Headers(opts.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    return headers
  }

  const res = await fetch(`${API}${path}`, { ...opts, headers: withAuth(session?.token) })
  if (res.status !== 401) return res

  clearPlayerSession()
  const retried = await ensurePlayerSession(address, walletClient, authOpts)
  if (!retried) return res
  return fetch(`${API}${path}`, { ...opts, headers: withAuth(retried.token) })
}
