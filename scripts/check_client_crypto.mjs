// Cross-checks the browser crypto in src/lib/ against the deployed verifiers.
//
// The client's Schnorr and DLEQ provers are ports of scripts/schnorr_keygen.py
// and scripts/dleq_prove.py. "Ports" is exactly the word that should worry
// you: a challenge hashed over the wrong limb encoding, or an MSM hint built
// for the wrong scalar, produces a proof that fails on-chain with no useful
// error and costs a transaction to discover.
//
// So this does not compare the TS against the Python. It generates fixtures
// through the TS modules and writes them into a Cairo test that runs the REAL
// DleqVerifier and SchnorrKeyVerifier -- the same code the adapter calls --
// and asserts they accept, then tampers with each and asserts they reject.
//
//   node scripts/check_client_crypto.mjs        # regenerate the fixtures
//   node scripts/check_client_crypto.mjs --check  # fail if they have drifted
//
// then `snforge test` in cairo-verifier/ is what actually proves it.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Bundle the client modules so this runs the SAME source the browser does,
// rather than a re-implementation that could agree with itself and nothing else.
// Inside node_modules so the bundle's externals (starknet, garaga, bb.js)
// resolve the same way they do for the app -- a bundle in /tmp cannot see them.
const outdir = join(root, 'node_modules/.cache/zkpoker');
mkdirSync(outdir, { recursive: true });
const entry = join(outdir, 'entry.ts');
writeFileSync(entry, `
export * as grumpkin from ${JSON.stringify(join(root, 'src/lib/grumpkin.ts'))};
export * as schnorr from ${JSON.stringify(join(root, 'src/lib/schnorr.ts'))};
export * as dleq from ${JSON.stringify(join(root, 'src/lib/dleq.ts'))};
export * as felt from ${JSON.stringify(join(root, 'src/lib/felt.ts'))};
export * as deck from ${JSON.stringify(join(root, 'src/lib/deck.ts'))};
export * as reveal from ${JSON.stringify(join(root, 'src/lib/reveal.ts'))};
`);
const bundle = join(outdir, 'bundle.mjs');
await build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
  outfile: bundle, external: ['garaga', 'starknet', '@aztec/bb.js'], logLevel: 'warning',
});
const { grumpkin, schnorr, dleq, felt, deck, reveal } = await import(pathToFileURL(bundle).href);

await dleq.initProver();
await schnorr.initProver();

// Deterministic secrets: a fixture that changes on every run is a fixture
// nobody can review, and a drift check that never passes.
// Deliberately NOT in arithmetic progression. An earlier draft used
// 0x1111/0x2222/0x3333, where a+b=c: after even-y normalisation one key
// negates and the three shares sum to the identity, which is a degenerate
// joint key (Y = O makes c2 = M + r*Y = M -- every card in the clear) and
// not a fixture the protocol would ever produce.
const SECRETS = [
  0x2b7e151628aed2a6abf7158809cf4f3cn,
  0x8e73b0f7da0e6452c810f32b809079e5n,
  0x62f8ead2522c6b7b3d5a1f0e4c9b8a71n,
];
const NONCES = [0xa11ce5n, 0xb0b0b0n, 0xcafe17n];

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1; };
const ok = (m) => console.log(`ok    ${m}`);

// ─── sanity that does not need Cairo ─────────────────────────────────────

// Card 0 must be G itself -- card_table.cairo's first entry is x = 0x1.
const cards = grumpkin.cardPoints();
if (cards[0].x !== 1n) fail(`card 0 x is ${cards[0].x}, expected 1 (G)`);
else ok('card 0 == G, matching card_table.cairo');
if (cards.length !== 52 || new Set(cards.map((c) => c.x)).size !== 52) {
  fail('card points are not 52 distinct x-coordinates');
} else ok('52 card points, all x distinct');
for (const [i, c] of cards.entries()) {
  if (!grumpkin.isOnCurve(c)) { fail(`card ${i} is off-curve`); break; }
  if (grumpkin.cardFromPoint(c) !== i) { fail(`card ${i} does not round-trip`); break; }
}
ok('every card point is on-curve and round-trips through cardFromPoint');

// The joint key really is the sum -- the property verify_joint_key checks
// on-chain, and the one a dealer could otherwise lie about.
const keys = SECRETS.map((s) => schnorr.normaliseEvenY(s));
const jointFromPoints = schnorr.jointKey(keys.map((k) => k.pk));
const jointFromSecrets = grumpkin.mulG(keys.reduce((a, k) => (a + k.secret) % grumpkin.N, 0n));
if (jointFromPoints === null || jointFromSecrets === null) {
  fail('joint key summed to the identity -- degenerate fixture secrets');
} else if (jointFromPoints.x !== jointFromSecrets.x || jointFromPoints.y !== jointFromSecrets.y) {
  fail('SUM(pk_i) != (SUM x_i)*G');
} else ok('joint key: SUM(pk_i) == (SUM x_i)*G');

// The pinned initial commitment's deck: a_0[i] = (identity, M_i).
const a0 = deck.initialDeck();
if (a0.length !== 52) fail(`initial deck has ${a0.length} cards`);
else if (a0.some((ct, i) => ct.c1 !== null || ct.c2.x !== cards[i].x)) fail('initial deck is not (O, M_i)');
else ok('initial deck a_0 is (identity, M_i) for i = 0..51');

// ─── fixtures the Cairo tests will run ───────────────────────────────────

const schnorrProofs = SECRETS.map((s, i) => schnorr.prove(s, NONCES[i]));

// H is a real ciphertext c1 -- r*G for some r -- not an arbitrary point, so
// the fixture exercises the shape the protocol actually produces.
const r = 0x1234567n;
const H = grumpkin.mulG(r);

const individual = dleq.prove(keys[0].secret, H, 0xfeedn);

// Aggregate: the three-round dance, honestly executed. The commitment round
// is modelled here so the fixture reflects deployment, not the shortcut.
const ks = [0x1001n, 0x1002n, 0x1003n];
const parts = keys.map((k, i) => ({
  pk: grumpkin.mulG(k.secret),
  d: grumpkin.mul(k.secret, H),
  r1: grumpkin.mulG(ks[i]),
  r2: grumpkin.mul(ks[i], H),
}));
const commitments = parts.map((p) => dleq.commitNonce(p.r1, p.r2).commitment);
if (new Set(commitments.map(String)).size !== 3) fail('nonce commitments collided');
const sumP = (f) => parts.map(f).reduce((a, p) => grumpkin.add(a, p), null);
const Y = sumP((p) => p.pk), D = sumP((p) => p.d), R1 = sumP((p) => p.r1), R2 = sumP((p) => p.r2);
const eAgg = dleq.challenge(Y, H, D, R1, R2);
const contributions = parts.map((p, i) => ({ ...p, s: dleq.respond(keys[i].secret, ks[i], eAgg) }));
const agg = dleq.aggregate(contributions, H);

// The card this aggregate opens. c2 = M + r*Y, so c2 - D must be M.
const CARD = 37;
const c2 = grumpkin.add(cards[CARD], grumpkin.mul(r, Y));
const recovered = dleq.recoverPoint(c2, D);
if (grumpkin.cardFromPoint(recovered) !== CARD) fail('aggregate share does not open the card');
else ok(`aggregate of ${SECRETS.length} shares opens card ${CARD} (${grumpkin.cardToName(CARD)})`);

// The hole-card commitment. reveal_hole_card recomputes this with Cairo's own
// poseidon_hash_span and refuses anything else, so a disagreement between the
// two languages here means a player can commit at dealing time and then be
// unable to show at showdown -- losing the pot to a hash mismatch.
const BLINDING = 0x5eed1n;
const holeCommitment = reveal.holeCommitment(D, BLINDING);
ok(`hole commitment computed over the combined share + blinding`);

// The card the combined share opens, recovered exactly as the UI does it.
const openedCard = reveal.cardFromShare({ c1: H, c2 }, D);
if (openedCard !== CARD) fail(`cardFromShare gave ${openedCard}, expected ${CARD}`);
else ok(`cardFromShare recovers card ${CARD} from (c1, c2) and the combined share`);

// ─── emit the Cairo fixture ──────────────────────────────────────────────

const arr = (name, vals) =>
  `    let ${name}: Array<felt252> = array![\n${vals.map((v) => `        0x${v.toString(16)},`).join('\n')}\n    ];`;
const u256 = (v) => { const [lo, hi] = felt.u256Parts(v); return `u256 { low: 0x${lo.toString(16)}, high: 0x${hi.toString(16)} }`; };
const feltOf = (v, half) => '0x' + felt.u256Parts(v)[half].toString(16);

const cairo = `// GENERATED by scripts/check_client_crypto.mjs -- do not edit by hand.
//
// Fixtures produced by the BROWSER crypto in src/lib/ (schnorr.ts, dleq.ts,
// grumpkin.ts), run here against the real verifiers. This is the only thing
// standing between "the TS port looks right" and "the TS port produces proofs
// the deployed contract accepts". Every negative case below was confirmed to
// fail for the reason stated, not merely to fail.
//
// Regenerate: node scripts/check_client_crypto.mjs && snforge test

use snforge_std::{ContractClassTrait, DeclareResultTrait, declare};
use zkpoker_verifier::dleq::{IDleqVerifierDispatcher, IDleqVerifierDispatcherTrait};
use zkpoker_verifier::{IKeyVerifierDispatcher, IKeyVerifierDispatcherTrait};

fn dleq() -> IDleqVerifierDispatcher {
    let contract = declare("DleqVerifier").unwrap().contract_class();
    let (address, _) = contract.deploy(@array![]).unwrap();
    IDleqVerifierDispatcher { contract_address: address }
}

fn schnorr() -> IKeyVerifierDispatcher {
    let contract = declare("SchnorrKeyVerifier").unwrap().contract_class();
    let (address, _) = contract.deploy(@array![]).unwrap();
    IKeyVerifierDispatcher { contract_address: address }
}

// ─── Schnorr: src/lib/schnorr.ts ─────────────────────────────────────────

${schnorrProofs.map((p, i) => `
// secret 0x${SECRETS[i].toString(16)}, nonce 0x${NONCES[i].toString(16)}
fn schnorr_proof_${i}() -> (Array<felt252>, Array<felt252>) {
${arr('proof', p.calldata)}
${arr('public_inputs', p.publicInputs)}
    (proof, public_inputs)
}`).join('\n')}

${schnorrProofs.map((_, i) => `
#[test]
fn test_browser_schnorr_${i}_is_accepted() {
    let v = schnorr();
    let (proof, public_inputs) = schnorr_proof_${i}();
    assert(v.verify_key_ownership(proof.span(), public_inputs.span()), 'schnorr ${i} rejected');
}`).join('\n')}

#[test]
fn test_browser_schnorr_rejects_a_tampered_challenge() {
    // e is the third felt of the calldata (rx, s, e, ..hint). A verifier that
    // took e from the caller instead of recomputing it would accept this --
    // that is the forgery the recompute exists to stop.
    let v = schnorr();
    let (proof, public_inputs) = schnorr_proof_0();
    let mut bad: Array<felt252> = array![];
    let mut i = 0;
    while i < proof.len() {
        if i == 2 { bad.append(*proof.at(i) + 1); } else { bad.append(*proof.at(i)); }
        i += 1;
    }
    assert(!v.verify_key_ownership(bad.span(), public_inputs.span()), 'tampered e accepted');
}

#[test]
fn test_browser_schnorr_rejects_a_foreign_public_key() {
    // Proof 0 replayed against key 1: the challenge binds to the key, so this
    // is the same rejection that stops a rogue-key registrant reusing someone
    // else's proof of knowledge.
    let v = schnorr();
    let (proof, _) = schnorr_proof_0();
    let (_, other_inputs) = schnorr_proof_1();
    assert(!v.verify_key_ownership(proof.span(), other_inputs.span()), 'foreign key accepted');
}

// ─── DLEQ: src/lib/dleq.ts ───────────────────────────────────────────────

// One party's individual share -- what answer_accusation posts.
fn dleq_individual() -> (Array<felt252>, Array<felt252>) {
${arr('proof', individual.proof)}
${arr('public_inputs', individual.publicInputs)}
    (proof, public_inputs)
}

// ${SECRETS.length} parties' shares aggregated into one proof against the joint key --
// the normal reveal path, flat in the number of players (PROTOCOL.md §6.2).
fn dleq_aggregate() -> (Array<felt252>, Array<felt252>) {
${arr('proof', agg.proof)}
${arr('public_inputs', agg.publicInputs)}
    (proof, public_inputs)
}

// The hole-card commitment, recomputed the way reveal_hole_card recomputes it.
//
// A player commits to the COMBINED share at dealing time, before betting, and
// reopens it at showdown. The contract rebuilds this hash from the share and
// blinding it is handed and rejects anything that does not match, so if
// starknet.js and Cairo disagreed about poseidon_hash_span the player would
// commit fine and then be unable to show -- forfeiting the pot to a hash.
#[test]
fn test_browser_hole_commitment_matches_cairo() {
    let share_x = ${u256(D.x)};
    let share_y = ${u256(D.y)};
    let blinding: felt252 = 0x${BLINDING.toString(16)};

    let recomputed = core::poseidon::poseidon_hash_span(
        array![
            share_x.low.into(), share_x.high.into(), share_y.low.into(), share_y.high.into(),
            blinding,
        ]
            .span(),
    );
    assert(recomputed == 0x${holeCommitment.toString(16)}, 'hole commitment mismatch');
}

// The reveal path's public inputs, in the order verify_reveal_at builds them:
// the table's JOINT key, then the opened ciphertext's c1, then the combined
// share. None of the first four felts come from the caller on-chain -- they are
// read from storage the shuffle chain and the opening proof already fixed --
// so this pins that the client builds the same statement the contract will.
#[test]
fn test_browser_reveal_inputs_are_joint_key_then_c1_then_share() {
    let (_, public_inputs) = dleq_aggregate();
    assert(public_inputs.len() == 12, 'expected 12 felts');

    // joint key
    assert(*public_inputs.at(0) == ${feltOf(Y.x, 0)}, 'joint x low');
    assert(*public_inputs.at(1) == ${feltOf(Y.x, 1)}, 'joint x high');
    assert(*public_inputs.at(2) == ${feltOf(Y.y, 0)}, 'joint y low');
    assert(*public_inputs.at(3) == ${feltOf(Y.y, 1)}, 'joint y high');
    // c1 -- the DLEQ base H
    assert(*public_inputs.at(4) == ${feltOf(H.x, 0)}, 'c1 x low');
    assert(*public_inputs.at(6) == ${feltOf(H.y, 0)}, 'c1 y low');
    // the combined share D
    assert(*public_inputs.at(8) == ${feltOf(D.x, 0)}, 'share x low');
    assert(*public_inputs.at(10) == ${feltOf(D.y, 0)}, 'share y low');
}

#[test]
fn test_browser_dleq_individual_share_is_accepted() {
    let v = dleq();
    let (proof, public_inputs) = dleq_individual();
    assert(v.verify_decryption_share(proof.span(), public_inputs.span()), 'individual rejected');
}

#[test]
fn test_browser_dleq_aggregate_is_accepted() {
    let v = dleq();
    let (proof, public_inputs) = dleq_aggregate();
    assert(v.verify_decryption_share(proof.span(), public_inputs.span()), 'aggregate rejected');
}

#[test]
fn test_browser_dleq_aggregate_opens_the_right_card() {
    // The whole point: c2 - D maps to card ${CARD} (${grumpkin.cardToName(CARD)}) in the
    // encoding table. The contract checks the named card rather than scanning
    // all 52, so naming the wrong one must fail -- the next test.
    let v = dleq();
    let (proof, public_inputs) = dleq_aggregate();
    assert(
        v.verify_card_reveal(
            proof.span(), public_inputs.span(), ${u256(c2.x)}, ${u256(c2.y)}, ${CARD},
        ),
        'card ${CARD} not recovered',
    );
}

#[test]
fn test_browser_dleq_rejects_a_wrong_claimed_card() {
    let v = dleq();
    let (proof, public_inputs) = dleq_aggregate();
    assert(
        !v.verify_card_reveal(
            proof.span(), public_inputs.span(), ${u256(c2.x)}, ${u256(c2.y)}, ${(CARD + 1) % 52},
        ),
        'wrong card accepted',
    );
}

#[test]
fn test_browser_dleq_rejects_a_tampered_share() {
    // d_x is public_inputs[8]. Moving the share breaks log_H(D) while leaving
    // log_G(PK) intact -- exactly the lie DLEQ exists to catch.
    let v = dleq();
    let (proof, public_inputs) = dleq_aggregate();
    let mut bad: Array<felt252> = array![];
    let mut i = 0;
    while i < public_inputs.len() {
        if i == 8 { bad.append(*public_inputs.at(i) + 1); } else { bad.append(*public_inputs.at(i)); }
        i += 1;
    }
    assert(!v.verify_decryption_share(proof.span(), bad.span()), 'tampered share accepted');
}

// -- Rejection here is a PANIC, not a 'false' -------------------------
//
// s is proof[0..1] and also the scalar the first MSM hint was built for.
// Moving it leaves the hint describing a different multiplication, and
// Garaga's msm_g1 asserts on that inconsistency rather than returning a
// value -- so the call reverts with 'Wrong FakeGLV decomposition' instead of
// verifying to false.
//
// That is safe HERE and it was checked rather than assumed: all five places
// PokerGame calls a verifier end in assert(..) (register_shuffle_key,
// begin_shuffle, submit_shuffle, answer_accusation, open_deck), so a panic
// and a 'false' both revert the transaction with no state written and no
// reentrancy lock stranded. In particular answer_accusation leaves the
// accusation uncleared either way, which is the outcome that matters.
//
// The difference is diagnostic: the caller sees a Garaga assertion string
// rather than BAD_SHARE_PROOF. Anything that ever wants to CONTINUE on a
// false -- rather than revert -- must not assume it will get one.
#[test]
#[should_panic(expected: ('Wrong FakeGLV decomposition', 'ENTRYPOINT_FAILED'))]
fn test_browser_dleq_rejects_a_tampered_response() {
    let v = dleq();
    let (proof, public_inputs) = dleq_aggregate();
    let mut bad: Array<felt252> = array![];
    let mut i = 0;
    while i < proof.len() {
        if i == 0 { bad.append(*proof.at(i) + 1); } else { bad.append(*proof.at(i)); }
        i += 1;
    }
    v.verify_decryption_share(bad.span(), public_inputs.span());
}

// A single party's share carries their own pk, not the joint key. Pairing one
// party's proof with the aggregate's public inputs is the shape of a party
// claiming credit for everyone's contribution. It is refused -- again by
// panic, for the reason above: the hint was built for this party's pk and the
// substituted inputs name a different point.
#[test]
#[should_panic(expected: ('wrong FakeGLV result', 'ENTRYPOINT_FAILED'))]
fn test_browser_dleq_individual_proof_does_not_verify_as_the_aggregate() {
    let v = dleq();
    let (proof, _) = dleq_individual();
    let (_, agg_inputs) = dleq_aggregate();
    v.verify_decryption_share(proof.span(), agg_inputs.span());
}
`;

const outPath = join(root, 'cairo-verifier/tests/test_client_vectors.cairo');
let existing = null;
try { existing = readFileSync(outPath, 'utf8'); } catch {}
if (process.argv.includes('--check')) {
  if (existing !== cairo) fail(`${outPath} is stale -- rerun without --check`);
  else ok('Cairo fixtures are up to date');
} else {
  writeFileSync(outPath, cairo);
  ok(`wrote cairo-verifier/tests/test_client_vectors.cairo`);
}

console.log(process.exitCode ? '\nFAILED' : '\nAll client-crypto checks passed. Now run: cd cairo-verifier && snforge test');
