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
  VariantGroup: 'vgrp',
  SizeScale: 'ssc',
  Brand: 'brd',
  Category: 'cat',
  Media: 'med',
  Collection: 'col',
  Promotion: 'prm',
  VoucherCode: 'vch',
  TargetedDrop: 'tdr',
  PromotionGrant: 'pgr',
  ConsumerFlag: 'cfg',
  WalletTx: 'wtx',
  LoyaltyTx: 'lty',
  LoyaltyAccount: 'lac',
  ClubbingRule: 'clb',
  // Orders
  Order: 'ord',
  OrderGroup: 'og',
  OrderItem: 'oi',
  OrderTransition: 'ot',
  Payment: 'pay',
  DeliveryAttempt: 'da',
  Address: 'addr',
  // Returns + held + refunds
  Return: 'rtn',
  HeldItem: 'hld',
  Refund: 'rfd',
  RefundLine: 'rfl',
  RefundDisbursement: 'rdb',
  // §15 Payment Capture
  PaymentSettlement: 'pst',
  PaymentSettlementEntry: 'pse',
  PaymentReconDiscrepancy: 'prd',
  // Disputes
  Dispute: 'dsp',
  // §19 Customer Issues
  Issue: 'iss',
  IssueMessage: 'ism',
  IssueTransition: 'ist',
  GiftCard: 'gc',
  ApplicationDoc: 'adoc',
  // Inventory
  InventoryAdjustment: 'iadj',
  // KYC
  KycReverification: 'kyc',
  KycDocument: 'kycd',
  // §20 Consumer Management
  ConsumerBan: 'bban',
  CommunityPost: 'cpst',
  Moodboard: 'mbd',
  MoodboardItem: 'mbi',
  Referral: 'rfr',
  Cart: 'crt',
  ProductReview: 'rev',
  ModerationReport: 'mrp',
  ModerationAction: 'mac',
  AccountDeletionRequest: 'adr',
  WalletPayout: 'wpo',
  // §21 Analytics events
  ListingView: 'lvw',
  CartEvent: 'cev',
  // §22 Notifications extras
  PushSubscription: 'psub',
  PushAttempt: 'patt',
  Banner: 'bnr',
  BannerDismissal: 'bdm',
  EmailOutbox: 'eml',
  // Offline POS (counter sales)
  PosSale: 'pos',
  PosSaleItem: 'posi',
  PosPayment: 'posp',
  PosCustomer: 'posc',
  PosReturnLine: 'posrl',
  // Reels + social interactions (likes / saves / comments on reels and posts)
  Reel: 'reel',
  ReelComment: 'rcmt',
  ReelLike: 'rlk',
  ReelSave: 'rsv',
  PostLike: 'plk',
  PostComment: 'pcmt',
  PostSave: 'psv',
} as const;
