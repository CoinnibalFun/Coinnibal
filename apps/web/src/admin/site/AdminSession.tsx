import { useEffect, useState } from 'react';
import { AddressChip, Button, Chip } from '../../design';
import { SiteApiError, adminApi } from '../../site/api';
import { signIn, signOut, useSession, type SiteSession } from '../../site/session';
import { providerSigner } from '../../wallet/siwe';
import { connectWallet, connected, disconnectWallet, initWallets, useWallet } from '../../wallet/store';

export type AdminState = { kind: 'none' } | { kind: 'checking' } | { kind: 'admin'; session: SiteSession } | { kind: 'denied'; session: SiteSession } | { kind: 'error'; message: string };

/**
 * The admin's site session: SIWE (one free signature) traded for the server's session token, then
 * checked with `/api/admin/me`. Every WL / collab / settings call carries it as a Bearer token,
 * and `/play` reads the same token.
 */
export function useAdminSession(): AdminState {
  const session = useSession((s) => s.session);
  const [state, setState] = useState<AdminState>(session ? { kind: 'checking' } : { kind: 'none' });
  useEffect(() => {
    if (!session) {
      setState({ kind: 'none' });
      return;
    }
    let live = true;
    setState({ kind: 'checking' });
    adminApi(session.token)
      .me()
      .then(
        () => live && setState({ kind: 'admin', session: { ...session, admin: true } }),
        (err: unknown) => {
          if (!live) return;
          if (err instanceof SiteApiError && err.code === 'forbidden') setState({ kind: 'denied', session });
          else if (err instanceof SiteApiError && err.code === 'unauthorized') {
            signOut();
            setState({ kind: 'none' });
          } else setState({ kind: 'error', message: (err as Error).message });
        },
      );
    return () => {
      live = false;
    };
  }, [session]);
  return state;
}

/** Owner of the registered contracts, as the chain tabs last read it (null: unknown). */
export interface OwnerRole {
  arena: boolean | null;
  nft: boolean | null;
}

/**
 * The right side of the workshop's top bar: the wallet (connect / the address chip /
 * disconnect), the role badges (OWNER from the chain, ADMIN from the server) and the free
 * sign-in. Problems show as a slim strip under the bar.
 */
export function AdminSessionBar({ state, role }: { state: AdminState; role?: OwnerRole }) {
  const providers = useWallet((s) => s.providers);
  const status = useWallet((s) => s.status);
  const walletError = useWallet((s) => s.error);
  const address = useWallet((s) => (s.status === 'connected' ? s.address : null));
  const signing = useSession((s) => s.signing);
  const error = useSession((s) => s.error);
  useEffect(() => initWallets(), []);
  const session = state.kind === 'admin' || state.kind === 'denied' ? state.session : null;
  const owner = role ? (role.arena === true || role.nft === true ? true : role.arena === false && (role.nft === false || role.nft === null) ? false : null) : null;
  const problems = [
    state.kind === 'denied' ? 'This wallet is not in ADMIN_WALLETS. Sign in with the admin wallet.' : null,
    state.kind === 'error' ? state.message : null,
    error,
    walletError,
    !address && providers.length === 0 ? 'No browser wallet found. Install MetaMask, Rabby or any browser wallet (a Ledger works through them).' : null,
  ].filter((x): x is string => !!x);

  return (
    <div className="ad-session" aria-label="Admin session">
      <div className="ad-session__row">
        {address ? (
          <>
            <AddressChip address={address} size="sm" chars={4} label="You" />
            {owner === true && (
              <Chip tone="sun" title="The connected wallet owns the registered contracts">
                Owner
              </Chip>
            )}
            {owner === false && (
              <Chip tone="down" title="The connected wallet does not own the registered contracts">
                Not owner
              </Chip>
            )}
            {state.kind === 'admin' && <Chip tone="teal">Admin</Chip>}
            {state.kind === 'denied' && <Chip tone="down">Not an admin</Chip>}
            {session ? (
              <Button variant="ghost" size="sm" onClick={() => signOut()}>
                Sign out
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                lead="key"
                disabled={signing || state.kind === 'checking'}
                onClick={() => {
                  const w = connected();
                  if (w) void signIn(providerSigner(w.provider, w.address)).catch(() => {});
                }}
              >
                {signing ? 'Check your wallet…' : 'Sign in'}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => disconnectWallet()} aria-label="Disconnect the wallet">
              Disconnect
            </Button>
          </>
        ) : (
          providers.map((d) => (
            <Button key={d.info.uuid} variant="secondary" size="sm" disabled={status === 'connecting'} onClick={() => void connectWallet(d)}>
              {d.info.icon && <img src={d.info.icon} alt="" width={18} height={18} className="ad-session__icon" />} {status === 'connecting' ? 'Connecting…' : `Connect ${d.info.name}`}
            </Button>
          ))
        )}
      </div>
      {!session && address && <p className="ad-session__hint">One free signature opens the WL, collab and site drawers. No transaction.</p>}
      {problems.length > 0 && (
        <div className="ad-session__problems" role="alert">
          {problems.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The start screen's first card while nobody is signed in: connect the owner wallet, then one free signature. The
 * same buttons as the top bar, where the owner looks first.
 */
export function SignInCard({ state }: { state: AdminState }) {
  const providers = useWallet((s) => s.providers);
  const status = useWallet((s) => s.status);
  const address = useWallet((s) => (s.status === 'connected' ? s.address : null));
  const signing = useSession((s) => s.signing);
  useEffect(() => initWallets(), []);
  if (state.kind === 'admin') return null;
  return (
    <section className="ad-card ad-signin" aria-labelledby="ad-signin-h" data-testid="start-signin">
      <h2 className="ad-card__title" id="ad-signin-h">
        {address ? 'Sign in' : 'Connect your wallet'}
      </h2>
      <p className="ad-card__lede">
        {state.kind === 'denied' ? 'This wallet is not an admin. Connect the owner wallet.' : address ? 'One free signature. No transaction.' : 'Use the owner wallet. It deploys the contracts and owns them.'}
      </p>
      <div className="ad-actions">
        {address ? (
          <Button
            variant="primary"
            size="sm"
            lead="key"
            disabled={signing || state.kind === 'checking'}
            onClick={() => {
              const w = connected();
              if (w) void signIn(providerSigner(w.provider, w.address)).catch(() => {});
            }}
          >
            {signing ? 'Check your wallet…' : 'Sign in'}
          </Button>
        ) : providers.length ? (
          providers.map((d) => (
            <Button key={d.info.uuid} variant="primary" size="sm" disabled={status === 'connecting'} onClick={() => void connectWallet(d)}>
              {status === 'connecting' ? 'Connecting…' : `Connect ${d.info.name}`}
            </Button>
          ))
        ) : (
          <p className="ad-note">No browser wallet found. Install MetaMask or Rabby (a Ledger works through them).</p>
        )}
      </div>
    </section>
  );
}
