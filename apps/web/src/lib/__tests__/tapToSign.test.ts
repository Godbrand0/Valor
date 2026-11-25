import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WalletClient } from 'viem'
import { setBridgedProvider, clearBridgedProvider } from '../walletBridge'
import { ensurePlayerSession, needsTapToSign, useSignInPrompt } from '../playerAuth'

const ADDR = '0x00000000000000000000000000000000000000a1' as const

function setUA(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })
}

function fakeClient() {
  const signMessage = vi.fn(async () => '0xsig' as `0x${string}`)
  return { client: { account: { address: ADDR }, signMessage } as unknown as WalletClient, signMessage }
}

describe('tap-to-sign wallets (MetaMask app on a phone via Web3Auth)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    clearBridgedProvider('web3auth')
    clearBridgedProvider('magic')
    useSignInPrompt.setState({ needed: false, version: 0 })
  })

  it('is only a phone browser with the wallet bridged through Web3Auth', () => {
    setUA('Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36')
    setBridgedProvider('web3auth', {} as never, ADDR)
    expect(needsTapToSign()).toBe(true)
    setUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 14) Chrome/130 Safari/537.36')
    expect(needsTapToSign()).toBe(false)
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148')
    clearBridgedProvider('web3auth')
    setBridgedProvider('magic', {} as never, ADDR)
    expect(needsTapToSign()).toBe(false)
  })

  it('never fires the login signature without a tap — it raises the banner instead', async () => {
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148')
    setBridgedProvider('web3auth', {} as never, ADDR)
    const { client, signMessage } = fakeClient()
    const session = await ensurePlayerSession(ADDR, client, { background: true })
    expect(session).toBeNull()
    expect(signMessage).not.toHaveBeenCalled()
    expect(useSignInPrompt.getState().needed).toBe(true)
  })
})
