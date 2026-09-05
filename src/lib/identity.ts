// Seat identity: the secret key share behind a player's registered public key.
//
// ── Why this is persisted at all ────────────────────────────────────────
// The key is registered once per table and needed for the whole hand: every
// decryption share is x_i * c1, and n-of-n means a share nobody can recompute
// stalls the table permanently. If a player reloads and loses their secret,
// they cannot answer an accusation, and claim_share_timeout convicts them and
// forfeits their stake (docs/PROTOCOL.md §8.1). Losing this key is not an
// inconvenience, it costs money.
//
// So it lives in localStorage, keyed by (chain, contract, table, address).
// That is a real and deliberate trade: localStorage is readable by any script
// on this origin, so an XSS on this page reads the key. It buys survival
// across a reload, which is the failure that actually happens. Two things
// bound the damage:
//
//   * the key is per TABLE, not an account key -- it signs nothing, moves no
//     funds, and is worthless once the table settles;
//   * knowing one seat's share does NOT open that seat's cards. Reading a hole
//     card needs every party's share, and this is one of them.
//
// What it DOES let an attacker do is decrypt shares sent to this seat and read
// this seat's own cards. That is the exposure, stated plainly.
//
// A hardware-backed alternative (non-extractable WebCrypto keys) cannot work
// here: the protocol needs raw scalar arithmetic on Grumpkin, which WebCrypto
// does not implement and non-extractable keys would forbid.

import { N } from './grumpkin';
import { KeyPair, normaliseEvenY } from './schnorr';
import { generateKey } from './schnorr';

const VERSION = 'v1';

function storageKey(p: { chainId: string; contract: string; tableId: string; address: string }): string {
  return ['zkpoker', VERSION, p.chainId, p.contract.toLowerCase(), p.tableId, p.address.toLowerCase()].join(':');
}

export type SeatIdentity = KeyPair & { fresh: boolean };

/**
 * The key for this seat, loaded or created.
 *
 * Deliberately NOT derived from a wallet signature. That would be tidier --
 * nothing to store -- but it makes the key recoverable by anyone who can get
 * one signature out of the wallet, and it ties a value that must stay secret
 * for the life of the table to a UX flow the user is trained to click through.
 */
export function loadOrCreateSeatKey(p: {
  chainId: string;
  contract: string;
  tableId: string;
  address: string;
}): SeatIdentity {
  const k = storageKey(p);
  try {
    const stored = window.localStorage.getItem(k);
    if (stored) {
      const secret = BigInt(stored);
      if (secret > 0n && secret < N) return { ...normaliseEvenY(secret), fresh: false };
    }
  } catch {
    // Private mode, disabled storage, or a corrupt value. Fall through and
    // mint a fresh key rather than failing -- but `fresh` tells the caller,
    // and the UI must warn before this seat has registered anything.
  }
  const key = generateKey();
  try {
    window.localStorage.setItem(k, '0x' + key.secret.toString(16));
  } catch {
    // Nothing more to do. The UI surfaces `persisted: false` so the player
    // learns BEFORE they stake money that a reload will cost them the hand.
  }
  return { ...key, fresh: true };
}

/** Whether the key actually made it to storage -- see the note above. */
export function seatKeyIsPersisted(p: {
  chainId: string;
  contract: string;
  tableId: string;
  address: string;
}): boolean {
  try {
    return window.localStorage.getItem(storageKey(p)) !== null;
  } catch {
    return false;
  }
}

/**
 * Export the raw secret so a player can move seats between browsers, or keep a
 * backup before a risky reload. Displaying this is exactly as dangerous as it
 * sounds; the UI gates it behind an explicit reveal.
 */
export function exportSeatKey(p: {
  chainId: string;
  contract: string;
  tableId: string;
  address: string;
}): string | null {
  try {
    return window.localStorage.getItem(storageKey(p));
  } catch {
    return null;
  }
}

export function importSeatKey(
  p: { chainId: string; contract: string; tableId: string; address: string },
  secretHex: string,
): SeatIdentity {
  const secret = BigInt(secretHex.trim());
  if (secret <= 0n || secret >= N) throw new Error('identity: secret out of range for Grumpkin');
  const key = normaliseEvenY(secret);
  window.localStorage.setItem(storageKey(p), '0x' + key.secret.toString(16));
  return { ...key, fresh: false };
}

/** Forget a table's key. Safe only once the table has settled. */
export function forgetSeatKey(p: {
  chainId: string;
  contract: string;
  tableId: string;
  address: string;
}): void {
  try { window.localStorage.removeItem(storageKey(p)); } catch {}
}
