import { randomUUID } from 'node:crypto';

/**
 * Prefixed, URL-safe identifier. Format: `{prefix}_{32-hex}` (uses crypto.randomUUID without
 * dashes). Prefixes are short lowercase tags so IDs are debuggable in logs.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export const IdPrefix = {
  Admin: 'adm',
  Retailer: 'ret',
  Consumer: 'cns',
  Store: 'str',
  BankAccount: 'bnk',
  Listing: 'lst',
  Variant: 'var',
  Brand: 'brd',
  Category: 'cat',
  Collection: 'col',
  Promotion: 'prm',
  VoucherCode: 'vch',
  WalletTx: 'wtx',
  LoyaltyTx: 'lty',
  ClubbingRule: 'clb',
} as const;
