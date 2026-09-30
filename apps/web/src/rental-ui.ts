import { encodeFunctionData, isAddress } from 'viem'
import { ARCHAVA_MOCK_USDT_ABI, ARCHAVA_RENTAL_V2_ABI, formatSiweMessage } from '@archava/rental'

interface RentalPackage {
  packageId: number
  name: string
  displayPriceIdr: number
  priceUnits: string
  priceMusdt: string
  includedMinutes: number
  validityDays: number
}

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>
  on?(event: string, handler: (...args: unknown[]) => void): void
  removeListener?(event: string, handler: (...args: unknown[]) => void): void
}

declare global {
  interface Window {
    ethereum?: EthereumProvider
  }
}

export interface RentalUIState {
  wallet: string | null
  chainId: number | null
  authenticated: boolean
  expiresAt: number | null
  hasActiveAccess: boolean
  packages: readonly RentalPackage[]
  txState: 'idle' | 'pending' | 'confirmed' | 'rejected' | 'failed'
  txKind: 'rental' | 'faucet' | null
  txHash: string | null
  activeSession: {
    capabilityToken: string
    leaseId: string
    remainingMinutes: number
  } | null
  errorMessage: string | null
}

const BSC_TESTNET_CHAIN_ID = 97
const BSC_TESTNET_HEX = '0x61'
const BSC_EXPLORER_BASE = 'https://testnet.bscscan.com'

export function mountRentalUI(container: HTMLElement): void {
  const state: RentalUIState = {
    wallet: null,
    chainId: null,
    authenticated: false,
    expiresAt: null,
    hasActiveAccess: false,
    packages: [],
    txState: 'idle',
    txKind: null,
    txHash: null,
    activeSession: null,
    errorMessage: null,
  }

  let contractAddress: string | null = null
  let tokenAddress: string | null = null
  let heartbeatInterval: NodeJS.Timeout | null = null

  // Fetch initial packages and contract info from backend
  async function loadPackages(): Promise<void> {
    try {
      const res = await fetch('/api/rental/packages')
      if (res.ok) {
        const data = (await res.json()) as {
          contractAddress: string
          tokenAddress: string
          packages: readonly {
            packageId: number
            name: string
            displayPriceIdr: number
            priceUnits: string
            priceMusdt: string
            includedMinutes: number
            validityDays: number
          }[]
        }
        if (data.contractAddress && isAddress(data.contractAddress)) {
          contractAddress = data.contractAddress
        }
        if (data.tokenAddress && isAddress(data.tokenAddress)) tokenAddress = data.tokenAddress
        if (data.packages) {
          state.packages = data.packages
        }
      }
    } catch {
      state.errorMessage = 'Unable to reach backend rental service.'
    }
  }

  // Check if existing session cookie is valid
  async function checkSession(): Promise<void> {
    try {
      const res = await fetch('/api/auth/session')
      if (res.ok) {
        const data = (await res.json()) as {
          authenticated: boolean
          session?: { wallet: string }
        }
        if (data.authenticated && data.session?.wallet) {
          state.authenticated = true
          state.wallet = data.session.wallet
          await refreshAuthoritativeStatus()
        }
      }
    } catch {
      // Ignore initial session check failure
    }
  }

  // Authoritatively refresh status from backend and BSC smart contract
  async function refreshAuthoritativeStatus(): Promise<void> {
    if (!state.wallet) return

    try {
      const res = await fetch(`/api/rental/status?wallet=${encodeURIComponent(state.wallet)}`)
      if (res.ok) {
        const data = (await res.json()) as {
          expiresAt: number
          hasActiveAccess: boolean
          secondsRemaining: number
        }
        state.expiresAt = data.expiresAt
        state.hasActiveAccess = data.hasActiveAccess
      } else {
        const err = (await res.json()) as { error?: { message?: string } }
        state.errorMessage = err.error?.message ?? 'Failed to refresh rental status'
      }
    } catch (err) {
      state.errorMessage = `Network error refreshing rental status: ${String(err)}`
    }
    render()
  }

  // Connect wallet via injected provider (MetaMask / OKX / Web3)
  async function connectWallet(): Promise<void> {
    state.errorMessage = null
    const provider = window.ethereum
    if (!provider) {
      state.errorMessage =
        'No Web3 wallet found. Please install MetaMask or use a browser with injected BNB Smart Chain wallet.'
      render()
      return
    }

    try {
      const accounts = (await provider.request({
        method: 'eth_requestAccounts',
      })) as string[]

      if (accounts && accounts[0]) {
        state.wallet = accounts[0]
      }

      const chainIdHex = (await provider.request({ method: 'eth_chainId' })) as string
      state.chainId = parseInt(chainIdHex, 16)

      if (state.chainId !== BSC_TESTNET_CHAIN_ID) {
        state.errorMessage =
          'Connected to wrong network. Please switch to BNB Smart Chain Testnet (Chain ID: 97).'
      } else {
        await refreshAuthoritativeStatus()
      }
    } catch (err: unknown) {
      state.errorMessage = `Wallet connection rejected: ${err instanceof Error ? err.message : String(err)}`
    }
    render()
  }

  // Request network switch or add BSC Testnet
  async function switchToBscTestnet(): Promise<void> {
    state.errorMessage = null
    const provider = window.ethereum
    if (!provider) return

    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: BSC_TESTNET_HEX }],
      })
      state.chainId = BSC_TESTNET_CHAIN_ID
      state.errorMessage = null
    } catch (switchError: unknown) {
      // Error code 4902 means the chain has not been added to MetaMask
      const err = switchError as { code?: number }
      if (err.code === 4902) {
        try {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: BSC_TESTNET_HEX,
                chainName: 'BNB Smart Chain Testnet',
                nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
                rpcUrls: ['https://data-seed-prebsc-1-s1.binance.org:8545/'],
                blockExplorerUrls: [BSC_EXPLORER_BASE],
              },
            ],
          })
          state.chainId = BSC_TESTNET_CHAIN_ID
          state.errorMessage = null
        } catch (addError) {
          state.errorMessage = `Failed to add BSC Testnet: ${addError instanceof Error ? addError.message : String(addError)}`
        }
      } else {
        state.errorMessage = `Failed to switch to BSC Testnet: ${switchError instanceof Error ? switchError.message : String(switchError)}`
      }
    }
    render()
  }

  // Sign SIWE login message without a transaction
  async function signInWithWallet(): Promise<void> {
    state.errorMessage = null
    if (!state.wallet) {
      await connectWallet()
      if (!state.wallet) return
    }

    if (state.chainId !== BSC_TESTNET_CHAIN_ID) {
      state.errorMessage = 'Please switch to BSC Testnet before signing in.'
      render()
      return
    }

    try {
      // 1. Fetch single-use nonce
      const nonceRes = await fetch('/api/auth/nonce', { method: 'POST' })
      if (!nonceRes.ok) throw new Error('Failed to obtain authentication nonce')
      const { nonce } = (await nonceRes.json()) as { nonce: string }

      // 2. Prepare SIWE message
      const domain = window.location.host
      const issuedAt = new Date().toISOString()
      const expirationTime = new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10m validity

      const message = formatSiweMessage({
        domain,
        address: state.wallet,
        uri: window.location.href,
        chainId: BSC_TESTNET_CHAIN_ID,
        nonce,
        issuedAt,
        expirationTime,
      })

      // 3. Request personal sign from wallet
      const provider = window.ethereum
      if (!provider) throw new Error('No provider available')

      const signature = (await provider.request({
        method: 'personal_sign',
        params: [message, state.wallet],
      })) as string

      // 4. Verify signature on backend
      const verifyRes = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, signature, domain }),
      })

      if (!verifyRes.ok) {
        const errData = (await verifyRes.json()) as { error?: { message?: string } }
        throw new Error(errData.error?.message ?? 'Signature verification failed')
      }

      state.authenticated = true
      await refreshAuthoritativeStatus()
    } catch (err: unknown) {
      state.errorMessage = `Sign-in failed: ${err instanceof Error ? err.message : String(err)}`
      render()
    }
  }

  // Sign out
  async function signOut(): Promise<void> {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // ignore
    }
    state.authenticated = false
    state.activeSession = null
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval)
      heartbeatInterval = null
    }
    render()
  }

  async function sendWalletTransaction(transaction: Record<string, string>): Promise<string> {
    const provider = window.ethereum
    if (!provider || !state.wallet) throw new Error('Connect your wallet first.')
    const txHash = (await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: state.wallet, ...transaction }],
    })) as string
    state.txHash = txHash
    render()

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const receipt = await provider.request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      })
      if (receipt && typeof receipt === 'object') {
        if ((receipt as { status?: string }).status !== '0x1') {
          throw new Error('Transaction reverted on BSC Testnet.')
        }
        return txHash
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    throw new Error('Transaction confirmation timed out. Check BscScan before retrying.')
  }

  async function claimMockUsdt(): Promise<void> {
    if (!state.wallet || state.chainId !== BSC_TESTNET_CHAIN_ID || !tokenAddress) {
      state.errorMessage = 'Connect your wallet to BSC Testnet first.'
      render()
      return
    }
    state.errorMessage = null
    state.txState = 'pending'
    state.txKind = 'faucet'
    render()
    try {
      const data = encodeFunctionData({ abi: ARCHAVA_MOCK_USDT_ABI, functionName: 'faucet' })
      await sendWalletTransaction({ to: tokenAddress, data })
      state.txState = 'confirmed'
      state.errorMessage = '100 testnet mUSDT claimed. It has no real-world value.'
    } catch (error) {
      state.txState = 'failed'
      state.errorMessage = error instanceof Error ? error.message : String(error)
    }
    render()
  }

  // Approve and purchase a package using testnet-only mUSDT.
  async function rentPackage(pkg: RentalPackage): Promise<void> {
    state.errorMessage = null
    state.txState = 'pending'
    state.txKind = 'rental'
    state.txHash = null
    render()

    if (!state.wallet || state.chainId !== BSC_TESTNET_CHAIN_ID) {
      state.errorMessage = 'Please connect wallet to BSC Testnet first.'
      state.txState = 'failed'
      render()
      return
    }

    if (!window.ethereum || !tokenAddress) {
      state.errorMessage = 'Mock USDT token configuration is unavailable.'
      state.txState = 'failed'
      render()
      return
    }

    try {
      if (!contractAddress || !isAddress(contractAddress)) {
        state.errorMessage = 'Rental contract address is not configured or unavailable.'
        state.txState = 'failed'
        render()
        return
      }

      const approveData = encodeFunctionData({
        abi: ARCHAVA_MOCK_USDT_ABI,
        functionName: 'approve',
        args: [contractAddress, BigInt(pkg.priceUnits)],
      })
      await sendWalletTransaction({ to: tokenAddress, data: approveData })

      const rentData = encodeFunctionData({
        abi: ARCHAVA_RENTAL_V2_ABI,
        functionName: 'rent',
        args: [pkg.packageId],
      })
      const txHash = await sendWalletTransaction({ to: contractAddress, data: rentData })
      state.txHash = txHash
      state.txState = 'confirmed'
      render()

      // Authoritative update rule: Re-query backend/contract to update entitlement state
      setTimeout(() => {
        void refreshAuthoritativeStatus()
      }, 3000)
    } catch (err: unknown) {
      const errObj = err as { code?: number; message?: string }
      if (errObj.code === 4001) {
        state.txState = 'rejected'
        state.errorMessage = 'Transaction rejected in wallet.'
      } else {
        state.txState = 'failed'
        state.errorMessage = `Transaction failed: ${errObj.message ?? String(err)}.`
      }
      render()
    }
  }

  // Launch protected Archava session
  async function launchProtectedSession(): Promise<void> {
    state.errorMessage = null
    if (!state.authenticated) {
      state.errorMessage = 'Authentication required. Please sign in with your wallet first.'
      render()
      return
    }

    try {
      const res = await fetch('/api/archava/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionType: 'archava-demo' }),
      })

      const data = (await res.json()) as {
        success?: boolean
        capability?: { capabilityToken: string; leaseId: string; remainingMinutes: number }
        error?: { code: string; message: string }
      }

      if (!res.ok || !data.success || !data.capability) {
        state.errorMessage = data.error?.message ?? 'Failed to launch protected Archava session'
        render()
        return
      }

      state.activeSession = data.capability

      // Start periodic heartbeat every 25 seconds
      if (heartbeatInterval) clearInterval(heartbeatInterval)
      heartbeatInterval = setInterval(() => {
        void (async () => {
          if (!state.activeSession) return
          try {
            const hbRes = await fetch('/api/archava/session/heartbeat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                leaseId: state.activeSession.leaseId,
                elapsedSeconds: 25,
              }),
            })
            if (!hbRes.ok) {
              state.activeSession = null
              if (heartbeatInterval) clearInterval(heartbeatInterval)
              render()
            }
          } catch {
            // ignore transient heartbeat error
          }
        })()
      }, 25_000)

      render()
    } catch (err) {
      state.errorMessage = `Session initiation error: ${String(err)}`
      render()
    }
  }

  // End protected session
  async function endProtectedSession(): Promise<void> {
    if (!state.activeSession) return
    try {
      await fetch('/api/archava/session/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leaseId: state.activeSession.leaseId }),
      })
    } catch {
      // ignore
    }
    state.activeSession = null
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval)
      heartbeatInterval = null
    }
    render()
  }

  // Render function
  function render(): void {
    const isWrongNetwork = state.wallet !== null && state.chainId !== BSC_TESTNET_CHAIN_ID
    const expiryDateStr =
      state.expiresAt && state.expiresAt > 0
        ? new Date(state.expiresAt * 1000).toLocaleString()
        : 'Never rented'

    container.innerHTML = `
      <div style="border: 2px solid currentColor; border-radius: 8px; padding: 1.25rem; margin: 1.5rem 0; background: color-mix(in oklab, currentColor 3%, transparent);">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem; border-bottom: 1px solid color-mix(in oklab, currentColor 20%, transparent); padding-bottom: 0.75rem; margin-bottom: 1rem;">
          <div>
            <h2 style="margin: 0; font-size: 1.2rem; display: flex; align-items: center; gap: 0.5rem;">
              <span>BNB Smart Chain Testnet Rental</span>
              <span style="font-size: 0.75rem; font-weight: normal; padding: 0.15rem 0.5rem; border-radius: 4px; background: color-mix(in oklab, currentColor 12%, transparent);">Chain ID: 97</span>
            </h2>
            <div style="font-size: 0.82rem; opacity: 0.8; margin-top: 0.2rem;">
              Onchain entitlement layer • Offchain Gemini, Spatius & LiveKit orchestration
            </div>
          </div>
          <div>
            ${
              !state.wallet
                ? `<button id="btn-connect-wallet" style="padding: 0.4rem 0.9rem; font-weight: bold; border-radius: 4px; cursor: pointer;">Connect Wallet</button>`
                : isWrongNetwork
                  ? `<button id="btn-switch-network" style="padding: 0.4rem 0.9rem; background: #eab308; color: #000; font-weight: bold; border-radius: 4px; cursor: pointer;">Switch to BSC Testnet</button>`
                  : !state.authenticated
                    ? `<button id="btn-sign-in" style="padding: 0.4rem 0.9rem; font-weight: bold; border-radius: 4px; cursor: pointer;">Sign In with Wallet</button>`
                    : `<span style="font-size: 0.85rem; margin-right: 0.5rem; color: #22c55e;">✓ Authenticated</span>
                       <button id="btn-sign-out" style="padding: 0.25rem 0.6rem; font-size: 0.8rem; cursor: pointer;">Sign Out</button>`
            }
          </div>
        </div>

        ${
          state.wallet
            ? `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem; margin-bottom: 1rem; font-size: 0.88rem;">
              <div style="padding: 0.6rem; border: 1px solid color-mix(in oklab, currentColor 15%, transparent); border-radius: 4px;">
                <div style="opacity: 0.7; font-size: 0.78rem;">CONNECTED WALLET</div>
                <div style="font-family: monospace; word-break: break-all;">${state.wallet}</div>
              </div>
              <div style="padding: 0.6rem; border: 1px solid color-mix(in oklab, currentColor 15%, transparent); border-radius: 4px;">
                <div style="opacity: 0.7; font-size: 0.78rem;">ACCESS EXPIRATION</div>
                <div>${expiryDateStr}</div>
              </div>
              <div style="padding: 0.6rem; border: 1px solid color-mix(in oklab, currentColor 15%, transparent); border-radius: 4px;">
                <div style="opacity: 0.7; font-size: 0.78rem;">ENTITLEMENT STATUS</div>
                <div>
                  ${
                    state.hasActiveAccess
                      ? `<span style="color: #22c55e; font-weight: bold;">● Active Entitlement</span>`
                      : `<span style="color: #ef4444; font-weight: bold;">○ Expired / Inactive</span>`
                  }
                </div>
              </div>
            </div>
            `
            : `
            <div style="margin-bottom: 1rem; font-size: 0.9rem; opacity: 0.85;">
              Connect your Web3 wallet to rent time-limited access packages on BNB Smart Chain Testnet. Free landing demo is available below without wallet.
            </div>
            `
        }

        ${
          state.errorMessage
            ? `
            <div style="padding: 0.75rem; margin-bottom: 1rem; background: color-mix(in oklab, #ef4444 15%, transparent); border: 1px solid #ef4444; border-radius: 4px; font-size: 0.85rem; color: #ef4444;">
              <strong>Notice:</strong> ${state.errorMessage}
              ${
                state.errorMessage.includes('tBNB')
                  ? `<div style="margin-top: 0.35rem;"><a href="https://testnet.bnbchain.org/faucet-smart" target="_blank" rel="noopener" style="color: inherit; text-decoration: underline;">Open Official BNB Testnet Faucet</a></div>`
                  : ''
              }
            </div>
            `
            : ''
        }

        ${
          state.txState !== 'idle'
            ? `
            <div style="padding: 0.75rem; margin-bottom: 1rem; border-radius: 4px; font-size: 0.85rem; background: color-mix(in oklab, currentColor 6%, transparent); border: 1px solid currentColor;">
              <div><strong>Transaction Status:</strong> <span style="text-transform: uppercase; font-weight: bold;">${state.txState}</span></div>
              ${
                state.txHash
                  ? `<div style="margin-top: 0.25rem;">
                       Hash: <a href="${BSC_EXPLORER_BASE}/tx/${state.txHash}" target="_blank" rel="noopener" style="text-decoration: underline; font-family: monospace;">${state.txHash.slice(0, 14)}...${state.txHash.slice(-10)}</a>
                     </div>`
                  : ''
              }
              ${
                state.txState === 'confirmed'
                  ? `<div style="color: #22c55e; margin-top: 0.25rem;">${state.txKind === 'faucet' ? 'Testnet mUSDT claim confirmed onchain.' : 'Rental confirmed onchain! Authoritative status refreshed from BSC smart contract.'}</div>`
                  : ''
              }
            </div>
            `
            : ''
        }

        <div style="margin-top: 1rem;">
          <h3 style="font-size: 1rem; margin: 0 0 0.5rem;">Archava access packages · BSC Testnet</h3>
          <p style="font-size: 0.82rem; opacity: 0.8;">Payment uses Archava Mock USDT (mUSDT), a testnet-only token with no real-world value. Claim demo tokens, then approve and purchase.</p>
          <button id="btn-claim-musdt" style="padding: 0.45rem 0.8rem; margin-bottom: 0.75rem; cursor: pointer;" ${!state.wallet || isWrongNetwork || state.txState === 'pending' ? 'disabled' : ''}>Claim 100 testnet mUSDT</button>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 0.75rem;">
            ${state.packages
              .map(
                (pkg) => `
              <div style="border: 1px solid color-mix(in oklab, currentColor 20%, transparent); border-radius: 6px; padding: 0.85rem; display: flex; flex-direction: column; justify-content: space-between;">
                <div>
                  <h4 style="margin: 0 0 0.25rem; font-size: 1rem;">${pkg.name}</h4>
                  <div style="font-size: 1.15rem; font-weight: bold; margin-bottom: 0.25rem;">Rp${pkg.displayPriceIdr.toLocaleString('id-ID')}</div>
                  <div style="font-size: 0.95rem; margin-bottom: 0.25rem;">${pkg.priceMusdt} mUSDT</div>
                  <p style="font-size: 0.8rem; opacity: 0.8; margin: 0 0 0.75rem;">${pkg.includedMinutes} conversation minutes · valid ${pkg.validityDays} days</p>
                </div>
                <button
                  class="btn-rent-package"
                  data-package-id="${pkg.packageId}"
                  style="width: 100%; padding: 0.45rem; cursor: pointer; font-weight: bold; border-radius: 4px;"
                  ${!state.wallet || isWrongNetwork || state.txState === 'pending' ? 'disabled' : ''}
                >
                  ${state.hasActiveAccess ? 'Buy / extend with mUSDT' : 'Buy with mUSDT'}
                </button>
              </div>
            `,
              )
              .join('')}
          </div>
        </div>

        <div style="margin-top: 1.25rem; border-top: 1px solid color-mix(in oklab, currentColor 15%, transparent); padding-top: 1rem;">
          <h3 style="font-size: 1rem; margin: 0 0 0.5rem;">Protected Archava Realtime Session</h3>
          <p style="font-size: 0.85rem; opacity: 0.8; margin: 0 0 0.75rem;">
            Starting a session requires an active BSC Testnet rental entitlement, checks offchain minute quotas, and enforces concurrency leases (1 active lease per wallet).
          </p>

          ${
            state.activeSession
              ? `
              <div style="padding: 0.75rem; border: 1px solid #22c55e; border-radius: 4px; background: color-mix(in oklab, #22c55e 10%, transparent); font-size: 0.85rem;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;">
                  <strong style="color: #22c55e;">● Protected Session Active</strong>
                  <button id="btn-end-session" style="padding: 0.2rem 0.5rem; font-size: 0.75rem; cursor: pointer;">End Session</button>
                </div>
                <div>Lease ID: <span style="font-family: monospace;">${state.activeSession.leaseId}</span></div>
                <div>Capability Token: <span style="font-family: monospace;">${state.activeSession.capabilityToken.slice(0, 20)}...</span></div>
                <div>Remaining Quota: ${state.activeSession.remainingMinutes} minutes</div>
                <div style="margin-top: 0.4rem; font-size: 0.78rem; opacity: 0.75;">Heartbeat stream connected. Credentials managed securely server-side.</div>
              </div>
              `
              : `
              <button
                id="btn-launch-session"
                style="padding: 0.5rem 1rem; font-weight: bold; border-radius: 4px; cursor: pointer;"
                ${!state.authenticated || !state.hasActiveAccess ? 'disabled' : ''}
              >
                Launch Protected Archava Session
              </button>
              ${
                !state.authenticated
                  ? `<span style="font-size: 0.82rem; margin-left: 0.75rem; opacity: 0.75;">(Sign in with wallet required)</span>`
                  : !state.hasActiveAccess
                    ? `<span style="font-size: 0.82rem; margin-left: 0.75rem; color: #ef4444;">(Active rental required)</span>`
                    : ''
              }
              `
          }
        </div>
      </div>
    `

    // Attach delegated button event listeners
    const btnConnect = container.querySelector('#btn-connect-wallet')
    if (btnConnect) btnConnect.addEventListener('click', () => void connectWallet())

    const btnSwitch = container.querySelector('#btn-switch-network')
    if (btnSwitch) btnSwitch.addEventListener('click', () => void switchToBscTestnet())

    const btnSignIn = container.querySelector('#btn-sign-in')
    if (btnSignIn) btnSignIn.addEventListener('click', () => void signInWithWallet())

    const btnSignOut = container.querySelector('#btn-sign-out')
    if (btnSignOut) btnSignOut.addEventListener('click', () => void signOut())

    const btnClaim = container.querySelector('#btn-claim-musdt')
    if (btnClaim) btnClaim.addEventListener('click', () => void claimMockUsdt())

    const btnLaunch = container.querySelector('#btn-launch-session')
    if (btnLaunch) btnLaunch.addEventListener('click', () => void launchProtectedSession())

    const btnEnd = container.querySelector('#btn-end-session')
    if (btnEnd) btnEnd.addEventListener('click', () => void endProtectedSession())

    container.querySelectorAll('.btn-rent-package').forEach((btn) => {
      btn.addEventListener('click', () => {
        const packageId = Number((btn as HTMLElement).dataset['packageId'])
        const pkg = state.packages.find((p) => p.packageId === packageId)
        if (pkg) void rentPackage(pkg)
      })
    })
  }

  // Initialize
  void (async () => {
    await loadPackages()
    await checkSession()

    // Listen to wallet accounts and chain change if provider is available
    if (window.ethereum?.on) {
      window.ethereum.on('accountsChanged', (accounts: unknown) => {
        const accs = accounts as string[]
        state.wallet = accs && accs[0] ? accs[0] : null
        state.authenticated = false
        state.activeSession = null
        void refreshAuthoritativeStatus()
      })

      window.ethereum.on('chainChanged', (chainIdHex: unknown) => {
        state.chainId = parseInt(chainIdHex as string, 16)
        render()
      })
    }

    render()
  })()
}
