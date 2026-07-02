/**
 * Per-store printer/cash-drawer configuration: loading, defaults, and the pure decision helpers
 * that the receipt renderer and the print transport both depend on.
 *
 * Kept separate from `printer.ts` (which does I/O) and `receipt.ts` (which assembles receipt data)
 * so both can import config without a cycle.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { posPrinterConfigs } from '@/db/schema/index.js';

export type PrinterConnection = 'network' | 'client' | 'browser';

export type ResolvedPrinterConfig = {
  storeId: string;
  enabled: boolean;
  connection: PrinterConnection;
  host: string | null;
  port: number;
  paperWidth: number;
  charsPerLine: number;
  copies: number;
  headerText: string | null;
  footerText: string | null;
  showGstBreakup: boolean;
  showQr: boolean;
  autoPrintOnSale: boolean;
  cashDrawerEnabled: boolean;
  cashDrawerPin: 0 | 1;
  cashDrawerOnlyOnCash: boolean;
  cashDrawerOnSale: boolean;
};

type ConfigRow = typeof posPrinterConfigs.$inferSelect;

/** Defaults applied when a store has never saved a printer config (feature OFF, safe values). */
export function defaultPrinterConfig(storeId: string): ResolvedPrinterConfig {
  return {
    storeId,
    enabled: false,
    connection: 'client',
    host: null,
    port: 9100,
    paperWidth: 80,
    charsPerLine: 48,
    copies: 1,
    headerText: null,
    footerText: 'Thank you! Please visit again.',
    showGstBreakup: true,
    showQr: false,
    autoPrintOnSale: true,
    cashDrawerEnabled: false,
    cashDrawerPin: 0,
    cashDrawerOnlyOnCash: true,
    cashDrawerOnSale: true,
  };
}

function fromRow(row: ConfigRow): ResolvedPrinterConfig {
  return {
    storeId: row.storeId,
    enabled: row.enabled,
    connection: row.connection as PrinterConnection,
    host: row.host,
    port: row.port,
    paperWidth: row.paperWidth,
    charsPerLine: row.charsPerLine,
    copies: row.copies,
    headerText: row.headerText,
    footerText: row.footerText,
    showGstBreakup: row.showGstBreakup,
    showQr: row.showQr,
    autoPrintOnSale: row.autoPrintOnSale,
    cashDrawerEnabled: row.cashDrawerEnabled,
    cashDrawerPin: (row.cashDrawerPin === 1 ? 1 : 0) as 0 | 1,
    cashDrawerOnlyOnCash: row.cashDrawerOnlyOnCash,
    cashDrawerOnSale: row.cashDrawerOnSale,
  };
}

/** Load a store's printer config, or defaults (feature disabled) if none saved. */
export async function getPrinterConfig(
  database: typeof Db,
  storeId: string,
): Promise<ResolvedPrinterConfig> {
  const row = await database.query.posPrinterConfigs.findFirst({
    where: eq(posPrinterConfigs.storeId, storeId),
  });
  return row ? fromRow(row) : defaultPrinterConfig(storeId);
}

/** Chars-per-line implied by paper width when the caller hasn't overridden it. */
export function charsForPaper(paperWidth: number): number {
  return paperWidth === 58 ? 32 : 48;
}

/**
 * Decide whether the drawer should pop for a completed sale, given the tender methods used.
 * Gated by the master toggle, `cashDrawerEnabled`, `cashDrawerOnSale`, and — when
 * `cashDrawerOnlyOnCash` is set — the presence of at least one cash tender.
 */
export function shouldKickDrawerForSale(
  config: ResolvedPrinterConfig,
  tenderMethods: string[],
): boolean {
  if (!config.enabled || !config.cashDrawerEnabled || !config.cashDrawerOnSale) return false;
  if (config.cashDrawerOnlyOnCash) return tenderMethods.includes('cash');
  return true;
}
