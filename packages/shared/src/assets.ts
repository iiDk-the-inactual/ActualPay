/**
 * Registry of supported assets.
 *
 * An asset is "a currency on a specific network". USDT on Ethereum and USDT on
 * Tron are different assets with different contracts, fees and finality, and a
 * payment sent on the wrong one may be unrecoverable. The asset id is
 * therefore always network-qualified and is the only identifier used by the
 * ledger, invoices and withdrawals.
 *
 * Decimals and mainnet contract addresses are protocol facts; they are kept
 * here (not in the database) so they are code-reviewed and cannot be edited
 * by an operator at runtime. Testnets have no official USDT deployment, so
 * testnet token contracts must be supplied through configuration.
 */
export const CHAIN_FAMILIES = ['bitcoin', 'litecoin', 'ethereum', 'tron', 'xrpl'] as const;
export type ChainFamily = (typeof CHAIN_FAMILIES)[number];

export const NETWORK_MODES = ['mainnet', 'testnet'] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];

export const ASSET_IDS = ['btc', 'ltc', 'eth', 'usdt-erc20', 'trx', 'usdt-trc20', 'xrp'] as const;
export type AssetId = (typeof ASSET_IDS)[number];

export type AssetKind = 'native' | 'token';

export interface AssetDefinition {
  readonly id: AssetId;
  readonly chain: ChainFamily;
  readonly symbol: string;
  readonly name: string;
  readonly kind: AssetKind;
  /** Number of decimal places between the display unit and the base unit. */
  readonly decimals: number;
  /** Human name of the base unit, for documentation and logs. */
  readonly baseUnitName: string;
  /** Asset that pays network fees when moving this asset. */
  readonly feeAssetId: AssetId;
  /** Token contract per network mode; `null` means "must be configured". */
  readonly contract: Readonly<Record<NetworkMode, string | null>> | null;
}

export const ASSETS: Readonly<Record<AssetId, AssetDefinition>> = {
  btc: {
    id: 'btc',
    chain: 'bitcoin',
    symbol: 'BTC',
    name: 'Bitcoin',
    kind: 'native',
    decimals: 8,
    baseUnitName: 'satoshi',
    feeAssetId: 'btc',
    contract: null,
  },
  ltc: {
    id: 'ltc',
    chain: 'litecoin',
    symbol: 'LTC',
    name: 'Litecoin',
    kind: 'native',
    decimals: 8,
    baseUnitName: 'litoshi',
    feeAssetId: 'ltc',
    contract: null,
  },
  eth: {
    id: 'eth',
    chain: 'ethereum',
    symbol: 'ETH',
    name: 'Ether',
    kind: 'native',
    decimals: 18,
    baseUnitName: 'wei',
    feeAssetId: 'eth',
    contract: null,
  },
  'usdt-erc20': {
    id: 'usdt-erc20',
    chain: 'ethereum',
    symbol: 'USDT',
    name: 'Tether USD (Ethereum)',
    kind: 'token',
    decimals: 6,
    baseUnitName: 'micro-USDT',
    feeAssetId: 'eth',
    contract: { mainnet: '0xdAC17F958D2ee523a2206206994597C13D831ec7', testnet: null },
  },
  trx: {
    id: 'trx',
    chain: 'tron',
    symbol: 'TRX',
    name: 'TRON',
    kind: 'native',
    decimals: 6,
    baseUnitName: 'sun',
    feeAssetId: 'trx',
    contract: null,
  },
  'usdt-trc20': {
    id: 'usdt-trc20',
    chain: 'tron',
    symbol: 'USDT',
    name: 'Tether USD (Tron)',
    kind: 'token',
    decimals: 6,
    baseUnitName: 'micro-USDT',
    feeAssetId: 'trx',
    contract: { mainnet: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', testnet: null },
  },
  xrp: {
    id: 'xrp',
    chain: 'xrpl',
    symbol: 'XRP',
    name: 'XRP',
    kind: 'native',
    decimals: 6,
    baseUnitName: 'drop',
    feeAssetId: 'xrp',
    contract: null,
  },
};

export function isAssetId(value: unknown): value is AssetId {
  return typeof value === 'string' && (ASSET_IDS as readonly string[]).includes(value);
}

export function getAsset(id: AssetId): AssetDefinition {
  return ASSETS[id];
}
