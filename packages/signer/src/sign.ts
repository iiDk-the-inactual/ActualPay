/**
 * Signing approved withdrawals.
 *
 * The signer trusts nothing but its own checks. For every withdrawal it
 * re-verifies, from the database and the ledger, everything the API claims:
 *
 *   1. the platform is not paused;
 *   2. the approval is current (not expired) and its SEAL verifies, so the
 *      approved terms were not edited in the database;
 *   3. the approver is a different person from the requester, is still an
 *      owner/admin of the organization, and has two-factor authentication;
 *   4. the ledger really holds the funds: the hold journal exists, belongs to
 *      this organization, moved exactly amount + fee, and was not released;
 *   5. the destination is registered, not revoked, matches the address on the
 *      withdrawal, and had passed its cool-down when it was approved;
 *   6. the amount is still within the organization's policy;
 *   7. the registered hot wallet for the chain is the one this keystore holds.
 *
 * Then it builds the transaction, checks the fee against hard caps, signs,
 * reads its own signed bytes back to confirm they pay exactly what was approved
 * from exactly the hot wallet, and stores the signed transaction and its txid in
 * the SAME database transaction that moves the withdrawal to `signed`. It never
 * broadcasts. Only after that row is committed does anything go to the network,
 * so a lost response can always be reconciled by txid.
 */
import { sql } from 'kysely';
import {
  asPgError,
  inTransaction,
  PG_ERRORS,
  type Db,
  type Tx,
  type WithdrawalRow,
} from '@actualpay/database';
import { recordAudit } from '@actualpay/audit';
import { validateAddress, type EvmNode, type UtxoNode } from '@actualpay/chains';
import {
  assertWithinPolicy,
  isWithdrawableAsset,
  sealFieldsOf,
  verifySeal,
  withdrawalsPaused,
} from '@actualpay/withdrawals';
import { ASSETS, type AssetId, type Logger, type NetworkMode } from '@actualpay/shared';
import { decodeEip1559, erc20TransferData, recoverSender, signEip1559 } from './evm-tx';
import { type UnlockedKeystore } from './keystore';
import { bytesToHex, hexToBytes } from './rlp';
import { p2wpkhScript, parseUtxoTx, planSpend, scriptForAddress, signP2wpkh } from './utxo-tx';

export interface SignerLimits {
  /** Refuse to pay more than this per gas (wei). */
  readonly maxGasPriceWei: bigint;
  /** Refuse fee rates above this (sat/vB). */
  readonly maxFeeRateSatPerVb: bigint;
  /** Refuse when the network fee would exceed this share of the amount (basis points). Native assets only. */
  readonly maxFeeBps: number;
  /** An approval with less than this left is not signed (it would expire mid-flight). */
  readonly minApprovalRemainingMs: number;
}

export const DEFAULT_SIGNER_LIMITS: SignerLimits = {
  maxGasPriceWei: 500_000_000_000n, // 500 gwei
  maxFeeRateSatPerVb: 500n,
  maxFeeBps: 1_000, // 10%
  minApprovalRemainingMs: 30_000,
};

export interface SignerDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly keystore: UnlockedKeystore;
  readonly sealKey: Buffer;
  readonly network: NetworkMode;
  readonly evm?: EvmNode;
  readonly utxo?: Partial<Record<'bitcoin' | 'litecoin', UtxoNode>>;
  readonly tokenContracts: Partial<Record<AssetId, string>>;
  readonly limits?: SignerLimits;
  readonly now?: Date;
}

/** A reason the signer will not sign this withdrawal (shown to operators). */
export class SigningRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningRefused';
  }
}

async function verifyApproval(
  tx: Tx,
  w: WithdrawalRow,
  deps: SignerDeps,
  now: Date,
): Promise<void> {
  const limits = deps.limits ?? DEFAULT_SIGNER_LIMITS;
  if ((await withdrawalsPaused(tx)).paused) throw new SigningRefused('withdrawals are paused');
  if (w.status !== 'approved') throw new SigningRefused(`status is ${w.status}`);
  if (!w.approval_seal || !w.approval_expires_at || !w.approved_by)
    throw new SigningRefused('the withdrawal carries no approval');
  if (w.approval_expires_at.getTime() - now.getTime() < limits.minApprovalRemainingMs)
    throw new SigningRefused('the approval has expired or is about to');
  if (!verifySeal(deps.sealKey, sealFieldsOf(w), w.approval_seal))
    throw new SigningRefused('the approval seal does not verify (the withdrawal was altered)');
  if (w.requested_by_type === 'user' && w.requested_by_id === w.approved_by)
    throw new SigningRefused('the requester approved their own withdrawal');

  // The approver must still be entitled to approve, with two-factor authentication.
  const approver = await tx
    .selectFrom('users')
    .innerJoin('organization_members as m', 'm.user_id', 'users.id')
    .leftJoin('totp_credentials as t', 't.user_id', 'users.id')
    .select(['users.status', 'm.role', 't.confirmed_at'])
    .where('users.id', '=', w.approved_by)
    .where('m.organization_id', '=', w.organization_id)
    .executeTakeFirst();
  if (!approver || approver.status !== 'active')
    throw new SigningRefused('the approver is not an active user');
  if (approver.role !== 'owner' && approver.role !== 'admin')
    throw new SigningRefused('the approver no longer has approval rights');
  if (!approver.confirmed_at)
    throw new SigningRefused('the approver has no two-factor authentication');

  // The money must really be held in the ledger for this withdrawal.
  const total = BigInt(w.amount) + BigInt(w.fee_charged);
  const hold = await tx
    .selectFrom('ledger_journals')
    .select(['id', 'organization_id', 'kind'])
    .where('id', '=', w.hold_journal_id)
    .where('external_ref', '=', `withdrawal:${w.id}:hold`)
    .executeTakeFirst();
  if (!hold || hold.kind !== 'withdrawal_hold' || hold.organization_id !== w.organization_id)
    throw new SigningRefused('the ledger hold for this withdrawal does not exist');
  const held = await tx
    .selectFrom('ledger_entries')
    .innerJoin('ledger_accounts', 'ledger_accounts.id', 'ledger_entries.account_id')
    .select(sql<string>`COALESCE(SUM(ledger_entries.amount), 0)`.as('held'))
    .where('ledger_entries.journal_id', '=', w.hold_journal_id)
    .where('ledger_accounts.type', '=', 'org_withdrawal_hold')
    .where('ledger_accounts.organization_id', '=', w.organization_id)
    .where('ledger_entries.direction', '=', 'credit')
    .where('ledger_entries.asset_id', '=', w.asset_id)
    .executeTakeFirstOrThrow();
  if (BigInt(held.held) !== total)
    throw new SigningRefused('the ledger hold does not match the amount');
  const released = await tx
    .selectFrom('ledger_journals')
    .select('id')
    .where('external_ref', '=', `withdrawal:${w.id}:release`)
    .executeTakeFirst();
  if (released) throw new SigningRefused('the held funds were already released');

  // The destination must be the registered, cooled-down, unrevoked one.
  const asset = ASSETS[w.asset_id as AssetId];
  const destination = await tx
    .selectFrom('withdrawal_destinations')
    .selectAll()
    .where('id', '=', w.destination_id)
    .where('organization_id', '=', w.organization_id)
    .executeTakeFirst();
  if (!destination) throw new SigningRefused('the destination is not registered');
  if (destination.revoked_at) throw new SigningRefused('the destination was revoked');
  if (destination.address !== w.destination_address || destination.chain !== asset.chain)
    throw new SigningRefused('the destination does not match the withdrawal');
  if (!w.approved_at || destination.active_at.getTime() > w.approved_at.getTime())
    throw new SigningRefused('the destination was still in its cool-down when approved');
  if (validateAddress(asset.chain, deps.network, w.destination_address) !== w.destination_address)
    throw new SigningRefused('the destination is not a valid address for this network');

  try {
    await assertWithinPolicy(tx, {
      organizationId: w.organization_id,
      assetId: w.asset_id,
      amount: BigInt(w.amount),
      now,
      excludeWithdrawalId: w.id,
    });
  } catch (error) {
    throw new SigningRefused(`policy: ${error instanceof Error ? error.message : 'not allowed'}`);
  }

  if (!isWithdrawableAsset(w.asset_id)) throw new SigningRefused('this asset cannot be withdrawn');
  const key = deps.keystore.keyFor(asset.chain);
  const registered = await tx
    .selectFrom('hot_wallets')
    .select('id')
    .where('chain', '=', asset.chain)
    .where('network', '=', deps.network)
    .where('address', '=', key.address)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!registered) throw new SigningRefused('the hot wallet is not registered as active');
}

interface Built {
  readonly raw: string;
  readonly txid: string;
  readonly hotAddress: string;
  readonly nonce: bigint | null;
  readonly inputs: string[] | null;
  readonly plannedFee: bigint;
}

async function buildEvm(tx: Tx, w: WithdrawalRow, deps: SignerDeps): Promise<Built> {
  const evm = deps.evm;
  if (!evm) throw new SigningRefused('no Ethereum node is configured for the signer');
  const limits = deps.limits ?? DEFAULT_SIGNER_LIMITS;
  const key = deps.keystore.keyFor('ethereum');
  await evm.verifyChain();
  const amount = BigInt(w.amount);
  const isToken = w.asset_id !== 'eth';
  const contract = isToken ? deps.tokenContracts[w.asset_id as AssetId] : undefined;
  if (isToken && !contract) throw new SigningRefused(`no contract is configured for ${w.asset_id}`);

  const to = isToken ? (contract as string) : w.destination_address;
  const data = isToken ? erc20TransferData(w.destination_address, amount) : '0x';
  const value = isToken ? 0n : amount;

  const [{ baseFee, priorityFee }, nodeNonce] = await Promise.all([
    evm.feeData(),
    evm.nonce(key.address),
  ]);
  const priority = priorityFee > 10_000_000_000n ? 10_000_000_000n : priorityFee;
  const maxFee = baseFee * 2n + priority;
  if (maxFee > limits.maxGasPriceWei)
    throw new SigningRefused(`gas price ${maxFee} wei is above the safety cap`);

  const estimate = await evm.estimateGas({ from: key.address, to, value, data });
  const gasLimit = isToken ? (estimate * 13n) / 10n : estimate < 21_000n ? 21_000n : estimate;
  const gasCap = isToken ? 250_000n : 100_000n;
  if (gasLimit > gasCap) throw new SigningRefused('estimated gas is above the safety cap');
  const plannedFee = gasLimit * maxFee;

  // Hot wallet must cover the payment and the worst-case gas.
  const ethBalance = await evm.balance(key.address);
  if (isToken) {
    const tokenBalance = await evm.tokenBalance(contract as string, key.address);
    if (tokenBalance < amount)
      throw new SigningRefused('the hot wallet holds too little of the token');
    if (ethBalance < plannedFee)
      throw new SigningRefused('the hot wallet has too little ETH for gas');
  } else {
    if (ethBalance < amount + plannedFee)
      throw new SigningRefused('the hot wallet holds too little ETH');
    if (plannedFee * 10_000n > amount * BigInt(limits.maxFeeBps))
      throw new SigningRefused('the network fee is too large compared with the amount');
  }

  // Next nonce: never behind the node, and never reusing one we already signed.
  const used = await tx
    .selectFrom('withdrawals')
    .select(sql<string | null>`max(nonce)`.as('n'))
    .where('hot_address', '=', key.address)
    .executeTakeFirstOrThrow();
  const fromDb = used.n === null ? 0n : BigInt(used.n) + 1n;
  const nonce = nodeNonce > fromDb ? nodeNonce : fromDb;

  const unsigned = {
    chainId: await chainIdOf(evm),
    nonce,
    maxPriorityFeePerGas: priority,
    maxFeePerGas: maxFee,
    gasLimit,
    to,
    value,
    data,
  };
  const signed = signEip1559(unsigned, key.privateKey);

  // Read our own bytes back: right sender, right payee, right amount, right data.
  const decoded = decodeEip1559(signed.raw);
  if (recoverSender(signed.raw) !== key.address)
    throw new SigningRefused('internal check failed: the signature is not from the hot wallet');
  if (
    decoded.to !== to.toLowerCase() ||
    decoded.value !== value ||
    decoded.data !== data.toLowerCase() ||
    decoded.nonce !== nonce ||
    decoded.chainId !== unsigned.chainId
  )
    throw new SigningRefused('internal check failed: the signed transaction differs from the plan');
  return {
    raw: signed.raw,
    txid: signed.txid,
    hotAddress: key.address,
    nonce,
    inputs: null,
    plannedFee,
  };
}

async function chainIdOf(evm: EvmNode): Promise<bigint> {
  return BigInt((await evm.call('eth_chainId')) as string);
}

async function buildUtxo(tx: Tx, w: WithdrawalRow, deps: SignerDeps): Promise<Built> {
  const chain = ASSETS[w.asset_id as AssetId].chain;
  if (chain !== 'bitcoin' && chain !== 'litecoin') throw new SigningRefused('not a UTXO asset');
  const node = deps.utxo?.[chain];
  if (!node) throw new SigningRefused(`no ${chain} node is configured for the signer`);
  const limits = deps.limits ?? DEFAULT_SIGNER_LIMITS;
  const key = deps.keystore.keyFor(chain);
  await node.ensureHotWallet(key.address);

  const feeRate = await node.feeRate();
  if (feeRate > limits.maxFeeRateSatPerVb)
    throw new SigningRefused(`fee rate ${feeRate} sat/vB is above the safety cap`);

  // Coins already committed to unsettled withdrawals must not be spent twice.
  const committed = await tx
    .selectFrom('withdrawals')
    .select(sql<string>`unnest(inputs)`.as('outpoint'))
    .where('hot_address', '=', key.address)
    .where('status', 'in', ['signed', 'broadcast', 'needs_review'])
    .execute();
  const excluded = new Set(committed.map((r) => r.outpoint));

  const amount = BigInt(w.amount);
  const destinationScript = scriptForAddress(chain, deps.network, w.destination_address);
  const changeScript = p2wpkhScript(key.publicKey);
  const utxos = await node.listUnspent(key.address, 1);
  let plan;
  try {
    plan = planSpend({
      utxos,
      excluded,
      destination: destinationScript,
      amount,
      changeScript,
      feeRate,
    });
  } catch (error) {
    throw new SigningRefused(error instanceof Error ? error.message : 'could not plan the spend');
  }
  if (plan.fee * 10_000n > amount * BigInt(limits.maxFeeBps))
    throw new SigningRefused('the network fee is too large compared with the amount');

  const signed = signP2wpkh({
    inputs: plan.inputs,
    outputs: plan.outputs,
    privateKey: key.privateKey,
  });
  // Read our own bytes back: exactly these coins in, exactly these outputs out.
  const parsed = parseUtxoTx(signed.raw);
  const wantIn = plan.inputs.map((i) => `${i.txid}:${i.vout}`);
  const gotIn = parsed.inputs.map((i) => `${i.txid}:${i.vout}`);
  const wantOut = plan.outputs.map((o) => `${o.amount}:${bytesToHex(o.script)}`);
  const gotOut = parsed.outputs.map((o) => `${o.amount}:${o.script}`);
  if (
    parsed.txid !== signed.txid ||
    JSON.stringify(wantIn) !== JSON.stringify(gotIn) ||
    JSON.stringify(wantOut) !== JSON.stringify(gotOut)
  )
    throw new SigningRefused('internal check failed: the signed transaction differs from the plan');
  const payment = parsed.outputs[0];
  if (!payment || payment.script !== bytesToHex(destinationScript) || payment.amount !== amount)
    throw new SigningRefused('internal check failed: the payment output is wrong');
  const inputTotal = plan.inputs.reduce((n, i) => n + i.amount, 0n);
  const outputTotal = parsed.outputs.reduce((n, o) => n + o.amount, 0n);
  if (inputTotal - outputTotal !== plan.fee)
    throw new SigningRefused('internal check failed: the fee is not what was planned');
  return {
    raw: signed.raw,
    txid: signed.txid,
    hotAddress: key.address,
    nonce: null,
    inputs: wantIn,
    plannedFee: plan.fee,
  };
}

export interface SigningReport {
  readonly signed: string[];
  readonly refused: { id: string; reason: string }[];
}

/**
 * Sign every approved withdrawal that passes verification, oldest first, one
 * transaction each. Safe to run from one signer only per chain (callers hold a
 * lease); a second concurrent run simply finds the rows locked.
 */
export async function signApprovedWithdrawals(deps: SignerDeps): Promise<SigningReport> {
  const now = deps.now ?? new Date();
  const report: { signed: string[]; refused: { id: string; reason: string }[] } = {
    signed: [],
    refused: [],
  };
  const candidates = await deps.db
    .selectFrom('withdrawals')
    .select('id')
    .where('status', '=', 'approved')
    .orderBy('approved_at')
    .limit(20)
    .execute();

  for (const { id } of candidates) {
    try {
      const done = await inTransaction(
        deps.db,
        async (tx) => {
          const w = await tx
            .selectFrom('withdrawals')
            .selectAll()
            .where('id', '=', id)
            .where('status', '=', 'approved')
            .forUpdate()
            .skipLocked()
            .executeTakeFirst();
          if (!w) return false; // taken, cancelled or expired meanwhile
          await verifyApproval(tx, w, deps, now);
          const chain = ASSETS[w.asset_id as AssetId].chain;
          // One signature at a time per chain: nonces and coins are chosen from state
          // that a concurrent signing would otherwise change underneath us. The lock
          // is held until this transaction commits, i.e. until the choice is recorded.
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`signer:${chain}`}, 0))`.execute(
            tx,
          );
          const built =
            chain === 'ethereum' ? await buildEvm(tx, w, deps) : await buildUtxo(tx, w, deps);
          await tx
            .updateTable('withdrawals')
            .set({
              status: 'signed',
              hot_address: built.hotAddress,
              signed_at: now,
              signed_tx: built.raw,
              txid: built.txid,
              nonce: built.nonce,
              inputs: built.inputs,
              planned_network_fee: built.plannedFee,
              last_error: null,
            })
            .where('id', '=', w.id)
            .where('status', '=', 'approved')
            .execute();
          await recordAudit(tx, {
            actor: { type: 'system' },
            action: 'withdrawal.signed',
            organizationId: w.organization_id,
            target: { type: 'withdrawal', id: w.id },
            metadata: { txid: built.txid, hotAddress: built.hotAddress },
          });
          return true;
        },
        { maxAttempts: 1 },
      );
      if (done) report.signed.push(id);
    } catch (error) {
      if (error instanceof SigningRefused) {
        deps.logger.warn({ withdrawalId: id, reason: error.message }, 'signing refused');
        report.refused.push({ id, reason: error.message });
        await recordRefusal(deps.db, id, error.message);
      } else if (asPgError(error)?.code === PG_ERRORS.UNIQUE_VIOLATION) {
        deps.logger.error({ withdrawalId: id, err: error }, 'signing hit a uniqueness conflict');
        report.refused.push({ id, reason: 'conflict while recording the signature' });
      } else {
        deps.logger.error({ withdrawalId: id, err: error }, 'signing failed');
        report.refused.push({ id, reason: 'internal error' });
      }
    }
  }
  return report;
}

async function recordRefusal(db: Db, id: string, reason: string): Promise<void> {
  await db
    .updateTable('withdrawals')
    .set({ last_error: `signing refused: ${reason}`.slice(0, 500) })
    .where('id', '=', id)
    .where('status', '=', 'approved')
    .execute()
    .catch(() => undefined);
}

export { hexToBytes };
