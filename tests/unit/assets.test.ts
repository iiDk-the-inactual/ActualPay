import { describe, expect, it } from 'vitest';
import { ASSETS, ASSET_IDS } from '@actualpay/shared';

describe('asset registry', () => {
  it('has an entry for every asset id, keyed consistently', () => {
    expect(Object.keys(ASSETS).sort()).toEqual([...ASSET_IDS].sort());
    for (const [key, asset] of Object.entries(ASSETS)) expect(asset.id).toBe(key);
  });

  it('pays fees in a native asset on the same chain', () => {
    for (const asset of Object.values(ASSETS)) {
      const feeAsset = ASSETS[asset.feeAssetId];
      expect(feeAsset.kind).toBe('native');
      expect(feeAsset.chain).toBe(asset.chain);
      if (asset.kind === 'native') expect(asset.feeAssetId).toBe(asset.id);
    }
  });

  it('declares contracts exactly for tokens', () => {
    for (const asset of Object.values(ASSETS)) {
      expect(asset.contract !== null).toBe(asset.kind === 'token');
    }
  });

  it('uses the documented protocol decimals', () => {
    expect(ASSETS.btc.decimals).toBe(8);
    expect(ASSETS.ltc.decimals).toBe(8);
    expect(ASSETS.eth.decimals).toBe(18);
    expect(ASSETS['usdt-erc20'].decimals).toBe(6);
    expect(ASSETS['usdt-trc20'].decimals).toBe(6);
    expect(ASSETS.trx.decimals).toBe(6);
    expect(ASSETS.xrp.decimals).toBe(6);
  });
});
