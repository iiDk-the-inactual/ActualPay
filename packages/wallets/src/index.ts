/**
 * Watch-only wallets and deposit-address allocation.
 *
 * A wallet is an account-level extended PUBLIC key (XRPL: one receiving
 * account). This package cannot spend: private keys are refused at the door
 * and never stored. See docs/wallets.md for the design and its limits.
 *
 * Money-safety rules implemented here:
 *  - an operator must confirm the wallet's first address against their own
 *    wallet software before any address is issued (catches a wrong
 *    derivation path or the wrong account while it still costs nothing);
 *  - addresses are issued under a row lock on the wallet, one per index, and
 *    never reused or reassigned (also enforced by database constraints);
 *  - archived or unconfirmed wallets issue nothing.
 */
import { HDKey } from '@scure/bip32';
import {
  deriveEvmAddress,
  deriveTronAddress,
  deriveUtxoAddress,
  extendedKeyId,
  extendedKeyNetwork,
  MAX_DERIVATION_INDEX,
  parseExtendedPublicKey,
  validateAddress,
} from '@actualpay/chains';
import {
  inTransaction,
  type Db,
  type DepositAddressRow,
  type Tx,
  type WalletRow,
} from '@actualpay/database';
import { recordAudit, type AuditActor, type RequestMeta } from '@actualpay/audit';
import { AppError, type ChainFamily, type NetworkMode } from '@actualpay/shared';

export type { DepositAddressRow, WalletRow };

/**
 * Addresses the watcher keeps imported ahead of the highest issued index
 * (BIP44 gap limit). Phase 6 watchers must import `next_index + ADDRESS_GAP`.
 */
export const ADDRESS_GAP = 20;

const MAX_ACCOUNT_INDEX = MAX_DERIVATION_INDEX; // 2^31 - 1
const MAX_XRPL_TAG = 4_294_967_295;

export interface DerivedDeposit {
  readonly address: string;
  /** XRPL only. */
  readonly destinationTag?: number;
}

function toValidation(error: unknown): AppError {
  return AppError.validation(error instanceof Error ? error.message : 'Invalid key.');
}

/** The deposit target at `index` (derivation index, or destination tag for XRPL). */
export function deriveDeposit(
  wallet: Pick<WalletRow, 'chain' | 'network' | 'account_xpub' | 'xrpl_address'>,
  index: number,
): DerivedDeposit {
  if (wallet.chain === 'xrpl') {
    if (!wallet.xrpl_address) throw new Error('XRPL wallet has no address');
    if (!Number.isInteger(index) || index < 1 || index > MAX_XRPL_TAG)
      throw new RangeError('Invalid destination tag');
    return { address: wallet.xrpl_address, destinationTag: index };
  }
  if (!wallet.account_xpub) throw new Error('Wallet has no account key');
  if (!Number.isInteger(index) || index < 0 || index > MAX_ACCOUNT_INDEX)
    throw new RangeError('Invalid derivation index');
  const account: HDKey = parseExtendedPublicKey(wallet.account_xpub);
  switch (wallet.chain) {
    case 'bitcoin':
    case 'litecoin':
      return { address: deriveUtxoAddress(wallet.chain, wallet.network, account, index) };
    case 'ethereum':
      return { address: deriveEvmAddress(account, index) };
    case 'tron':
      return { address: deriveTronAddress(account, index) };
  }
}

export interface CreateWalletParams {
  readonly organizationId: string;
  readonly actor: AuditActor & { type: 'user' };
  readonly chain: ChainFamily;
  /** The deployment's network; wallets cannot be created for any other. */
  readonly network: NetworkMode;
  /** Chains that have at least one enabled asset in this deployment. */
  readonly enabledChains: readonly ChainFamily[];
  readonly label: string;
  /** Account-level extended public key (not for XRPL). */
  readonly accountXpub?: string;
  /** Classic receiving address (XRPL only). */
  readonly xrplAddress?: string;
  /**
   * XRPL only. The account the deployment's watcher monitors (XRPL_DEPOSIT_ACCOUNT),
   * or null when none is configured. When this key is present, the wallet address
   * must equal it: the watcher only sees payments to that one account.
   */
  readonly xrplWatchedAccount?: string | null;
}

export async function createWallet(
  db: Db,
  params: CreateWalletParams,
  meta: RequestMeta,
): Promise<{ wallet: WalletRow; firstAddress: DerivedDeposit }> {
  const label = params.label.trim();
  if (label.length < 1 || label.length > 100)
    throw AppError.validation('Label must be 1–100 characters.');
  if (!params.enabledChains.includes(params.chain))
    throw AppError.validation(`No ${params.chain} asset is enabled in this deployment.`);

  let accountXpub: string | null = null;
  let keyId: string | null = null;
  let xrplAddress: string | null = null;
  let firstIndex = 0;

  if (params.chain === 'xrpl') {
    if (params.accountXpub) throw AppError.validation('XRPL wallets do not use an extended key.');
    const canonical = params.xrplAddress
      ? validateAddress('xrpl', params.network, params.xrplAddress)
      : null;
    if (!canonical) throw AppError.validation('A valid XRPL classic address is required.');
    if (params.xrplWatchedAccount !== undefined) {
      if (params.xrplWatchedAccount === null)
        throw AppError.validation(
          'XRPL_DEPOSIT_ACCOUNT is not configured, so no watcher is monitoring an XRPL account.',
        );
      if (validateAddress('xrpl', params.network, params.xrplWatchedAccount) !== canonical)
        throw AppError.validation(
          'This address is not the account the watcher monitors (XRPL_DEPOSIT_ACCOUNT).',
        );
    }
    xrplAddress = canonical;
    firstIndex = 1;
  } else {
    if (params.xrplAddress) throw AppError.validation('Only XRPL wallets take an address.');
    if (!params.accountXpub)
      throw AppError.validation('An account-level extended public key is required.');
    let key: HDKey;
    try {
      key = parseExtendedPublicKey(params.accountXpub);
    } catch (error) {
      throw toValidation(error);
    }
    // Bitcoin/Litecoin encode the network in the key version (xpub vs tpub) and in
    // the addresses derived from it, so a mismatch would produce wrong-network addresses.
    if (
      (params.chain === 'bitcoin' || params.chain === 'litecoin') &&
      extendedKeyNetwork(key) !== params.network
    ) {
      throw AppError.validation(
        `This is a ${extendedKeyNetwork(key)} key but the deployment runs on ${params.network}.`,
      );
    }
    accountXpub = params.accountXpub.trim();
    keyId = extendedKeyId(key);
  }

  try {
    return await inTransaction(db, async (tx) => {
      const wallet = await tx
        .insertInto('wallets')
        .values({
          organization_id: params.organizationId,
          chain: params.chain,
          network: params.network,
          label,
          account_xpub: accountXpub,
          key_id: keyId,
          xrpl_address: xrplAddress,
          next_index: firstIndex,
          created_by: params.actor.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await recordAudit(tx, {
        actor: params.actor,
        action: 'wallet.created',
        organizationId: params.organizationId,
        target: { type: 'wallet', id: wallet.id },
        meta,
        metadata: { chain: wallet.chain, network: wallet.network, label, keyId },
      });
      return { wallet, firstAddress: deriveDeposit(wallet, firstIndex) };
    });
  } catch (error) {
    // Unique violation: this key/account is already registered somewhere. The
    // message deliberately does not say whether it is another organization.
    if ((error as { code?: string }).code === '23505')
      throw AppError.conflict('This key or account is already registered as a wallet.');
    throw error;
  }
}

async function lockWallet(tx: Tx, organizationId: string, walletId: string): Promise<WalletRow> {
  const wallet = await tx
    .selectFrom('wallets')
    .selectAll()
    .where('id', '=', walletId)
    .where('organization_id', '=', organizationId)
    .forUpdate()
    .executeTakeFirst();
  if (!wallet) throw AppError.notFound('Wallet');
  return wallet;
}

/**
 * Confirm the wallet by typing its first address as shown by the operator's
 * own wallet software. Only a match unlocks address issuance.
 */
export async function confirmWallet(
  db: Db,
  params: {
    organizationId: string;
    walletId: string;
    actor: AuditActor & { type: 'user' };
    address: string;
  },
  meta: RequestMeta,
): Promise<WalletRow> {
  // A mismatch must leave an audit record, so it is reported as a value and
  // thrown only after the transaction that wrote the record has committed.
  const result = await inTransaction(
    db,
    async (tx): Promise<{ wallet: WalletRow } | { mismatch: true }> => {
      const wallet = await lockWallet(tx, params.organizationId, params.walletId);
      if (wallet.status === 'archived') throw AppError.conflict('This wallet is archived.');
      if (wallet.verified_at) return { wallet }; // already confirmed: idempotent
      const typed = validateAddress(wallet.chain, wallet.network, params.address.trim());
      const expected = deriveDeposit(wallet, wallet.chain === 'xrpl' ? 1 : 0).address;
      if (!typed || typed !== expected) {
        await recordAudit(tx, {
          actor: params.actor,
          action: 'wallet.confirmation_failed',
          organizationId: params.organizationId,
          target: { type: 'wallet', id: wallet.id },
          meta,
        });
        return { mismatch: true };
      }
      const updated = await tx
        .updateTable('wallets')
        .set({ verified_at: new Date(), verified_by: params.actor.id })
        .where('id', '=', wallet.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await recordAudit(tx, {
        actor: params.actor,
        action: 'wallet.confirmed',
        organizationId: params.organizationId,
        target: { type: 'wallet', id: wallet.id },
        meta,
      });
      return { wallet: updated };
    },
  );
  if ('mismatch' in result)
    throw AppError.validation(
      'That address does not match the first address of this wallet. Check the derivation path and account in your wallet software.',
    );
  return result.wallet;
}

export async function archiveWallet(
  db: Db,
  params: { organizationId: string; walletId: string; actor: AuditActor & { type: 'user' } },
  meta: RequestMeta,
): Promise<WalletRow> {
  return inTransaction(db, async (tx) => {
    const wallet = await lockWallet(tx, params.organizationId, params.walletId);
    if (wallet.status === 'archived') return wallet;
    const updated = await tx
      .updateTable('wallets')
      .set({ status: 'archived', archived_at: new Date() })
      .where('id', '=', wallet.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(tx, {
      actor: params.actor,
      action: 'wallet.archived',
      organizationId: params.organizationId,
      target: { type: 'wallet', id: wallet.id },
      meta,
    });
    return updated;
  });
}

export async function listWallets(db: Db, organizationId: string): Promise<WalletRow[]> {
  return db
    .selectFrom('wallets')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .orderBy('created_at', 'desc')
    .limit(500)
    .execute();
}

export async function getWallet(
  db: Db,
  organizationId: string,
  walletId: string,
): Promise<WalletRow> {
  const wallet = await db
    .selectFrom('wallets')
    .selectAll()
    .where('id', '=', walletId)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst();
  if (!wallet) throw AppError.notFound('Wallet');
  return wallet;
}

/**
 * Issue the next deposit address of a confirmed, active wallet.
 *
 * Pass a transaction to make the allocation part of the caller's unit of work
 * (Phase 5: the invoice and its address commit or roll back together). Given a
 * plain connection it runs in its own transaction.
 */
export async function allocateDepositAddress(
  db: Db | Tx,
  params: {
    organizationId: string;
    walletId: string;
    reference?: { type: string; id: string };
  },
): Promise<DepositAddressRow> {
  const run = async (tx: Tx): Promise<DepositAddressRow> => {
    const wallet = await lockWallet(tx, params.organizationId, params.walletId);
    if (wallet.status !== 'active') throw AppError.conflict('This wallet is archived.');
    if (!wallet.verified_at)
      throw AppError.conflict("Confirm the wallet's first address before it can issue addresses.");
    const index = Number(wallet.next_index);
    // UTXO chains only see addresses the node has imported. Never issue one the
    // node is not watching yet; the worker extends the range ahead of demand.
    if (
      (wallet.chain === 'bitcoin' || wallet.chain === 'litecoin') &&
      index >= Number(wallet.watched_through)
    ) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        "This wallet's addresses are not being watched yet. Make sure the worker is running.",
      );
    }
    const limit = wallet.chain === 'xrpl' ? MAX_XRPL_TAG : MAX_ACCOUNT_INDEX;
    if (index > limit) throw AppError.conflict('This wallet has run out of addresses.');
    const target = deriveDeposit(wallet, index);
    const row = await tx
      .insertInto('deposit_addresses')
      .values({
        wallet_id: wallet.id,
        organization_id: wallet.organization_id,
        chain: wallet.chain,
        network: wallet.network,
        address: target.address,
        derivation_index: target.destinationTag === undefined ? index : null,
        destination_tag: target.destinationTag ?? null,
        reference_type: params.reference?.type ?? null,
        reference_id: params.reference?.id ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await tx
      .updateTable('wallets')
      .set({ next_index: index + 1 })
      .where('id', '=', wallet.id)
      .execute();
    return row;
  };
  return db.isTransaction ? run(db as Tx) : inTransaction(db, run);
}

export async function listDepositAddresses(
  db: Db,
  params: {
    organizationId: string;
    walletId?: string;
    limit: number;
    before?: { createdAt: string; id: string };
  },
): Promise<DepositAddressRow[]> {
  let query = db
    .selectFrom('deposit_addresses')
    .selectAll()
    .where('organization_id', '=', params.organizationId);
  if (params.walletId) query = query.where('wallet_id', '=', params.walletId);
  if (params.before) {
    const { createdAt, id } = params.before;
    query = query.where((eb) =>
      eb.or([
        eb('created_at', '<', new Date(createdAt)),
        eb.and([eb('created_at', '=', new Date(createdAt)), eb('id', '<', id)]),
      ]),
    );
  }
  return query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(params.limit).execute();
}
