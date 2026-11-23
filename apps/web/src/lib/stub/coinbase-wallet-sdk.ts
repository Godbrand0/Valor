// Stub for `@coinbase/wallet-sdk` (used by wagmi's coinbaseWallet() connector, not
// used in Valor). The connector barrel dynamically imports it, and since it is an
// uninstalled optional peer, webpack reported "Module not found" on every dev
// compile. Aliasing it here matches the `accounts` / `porto` stubs.
export {}
