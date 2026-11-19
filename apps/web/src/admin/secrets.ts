import { SiteApiError, encodeProof, type AdminApi, type SecretPurpose } from '../site/api';
import { isUserCancel } from '../site/session';
import { personalSign } from '../wallet/siwe';
import { connected } from '../wallet/store';

/** Signs a text with the admin wallet (`personal_sign`); throws when no wallet is connected. */
export type ProofSigner = (message: string) => Promise<string>;

/** The connected wallet as the signer of a secret export's proof. */
export function walletProofSigner(): ProofSigner {
  return async (message) => {
    const w = connected();
    if (!w) throw new Error('Connect the admin wallet first (top right).');
    return personalSign(w.provider, w.address, message);
  };
}

/**
 * The secret exports (backup, migration settings) need a fresh, purpose-bound signature of the admin wallet besides the
 * session: ask the server for the text, sign it, and send it as `X-Coinnibal-Proof`. A `proof_required` answer (the proof
 * expired or was used already) asks for one new signature, once.
 */
export async function withSecretProof<T>(api: AdminApi, purpose: SecretPurpose, sign: ProofSigner, run: (proof: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const challenge = await api.secretProof(purpose);
    const signature = await sign(challenge.message);
    try {
      return await run(encodeProof(challenge.message, signature));
    } catch (err) {
      if (attempt === 0 && err instanceof SiteApiError && err.code === 'proof_required') continue;
      throw err;
    }
  }
}

/** The words for a failed secret export (pure, tested). */
export function secretErrorText(err: unknown, what: string): string {
  if (isUserCancel(err)) return `Signature cancelled: ${what} did not happen.`;
  if (err instanceof SiteApiError) {
    if (err.code === 'admin_session_expired') return 'Your admin session ended (admin sessions last 2 hours, and "Sign out everywhere" ends them). Sign in again at the top right, then retry.';
    if (err.code === 'proof_required') return `The server did not accept the signature (it expired or was used already): ${err.message}`;
    if (err.code === 'disabled') return err.message;
  }
  return (err as Error)?.message || `${what[0].toUpperCase()}${what.slice(1)} failed.`;
}
