/**
 * Print transport + orchestration for the counter.
 *
 * Two delivery paths, chosen by `config.connection`:
 *   - 'network' → the backend opens a TCP socket to the printer (host:port, ESC/POS raw port 9100
 *                 by convention) and streams the bytes itself. Used for LAN/IP printers.
 *   - 'client'/'browser' → the backend renders the payload and hands it back in the API response;
 *                 a paired terminal app relays it to a Bluetooth/USB printer (or the OS print
 *                 dialog for 'browser'). The backend performs no I/O in this path.
 *
 * Everything is gated by `config.enabled`; a store that never enabled printing gets `null` back and
 * the existing async PDF-invoice flow is untouched.
 */
import net from 'node:net';
import type { db as Db } from '@/db/client.js';
import { drawerKick, renderReceiptEscPos } from './escpos.js';
import { assembleReceipt, renderReceiptPayloads } from './receipt.js';
import {
  shouldKickDrawerForSale,
  type ResolvedPrinterConfig,
} from './printer-config.js';

const NETWORK_TIMEOUT_MS = 5000;

/** Stream a raw byte buffer to an IP/LAN printer over TCP. Rejects on timeout or socket error. */
export function printToNetwork(
  host: string,
  port: number,
  payload: Buffer,
  timeoutMs = NETWORK_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(timeoutMs);
    socket.once('error', done);
    socket.once('timeout', () => done(new Error(`Printer ${host}:${port} timed out`)));
    socket.connect(port, host, () => {
      socket.write(payload, (err) => {
        if (err) return done(err);
        // Give the printer a moment to drain, then close cleanly.
        socket.end(() => done());
      });
    });
  });
}

/** The client-facing print hint returned in the sale/reprint response. Shape depends on transport. */
export type PrintHint =
  | {
      connection: 'network';
      autoPrint: boolean;
      dispatched: boolean; // a network print was fired server-side
      drawerKicked: boolean;
    }
  | {
      connection: 'client' | 'browser';
      autoPrint: boolean;
      paperWidth: number;
      charsPerLine: number;
      drawerKick: boolean;
      escposBase64?: string; // present for 'client' (bytes to relay over BT/USB)
      receiptText: string;
    };

/**
 * Prepare printing for a just-completed sale: for a network printer this fires the print (and
 * drawer kick) server-side when auto-print is on; for a client/browser printer it renders the
 * payload for the response. Returns null when printing is disabled or the sale can't be assembled.
 *
 * Never throws — a print failure must not fail the sale (which is already committed).
 */
export async function preparePrintForSale(
  database: typeof Db,
  input: { storeId: string; saleId: string; config: ResolvedPrinterConfig; tenderMethods: string[] },
): Promise<PrintHint | null> {
  const { config } = input;
  if (!config.enabled) return null;

  const receipt = await assembleReceipt(database, {
    storeId: input.storeId,
    saleId: input.saleId,
    config,
  });
  if (!receipt) return null;

  const kick = shouldKickDrawerForSale(config, input.tenderMethods);
  const drawerKickPin = kick ? config.cashDrawerPin : null;

  if (config.connection === 'network') {
    let dispatched = false;
    if (config.autoPrintOnSale && config.host) {
      dispatched = true;
      const bytes = renderReceiptEscPos(receipt, { copies: config.copies, drawerKickPin });
      // Fire-and-forget post-response; a failed print must not roll back the settled sale.
      setImmediate(() => {
        void printToNetwork(config.host!, config.port, bytes).catch((err) => {
          console.error(
            `[pos-printer] network print failed for sale ${input.saleId}: ${(err as Error).message}`,
          );
        });
      });
    }
    return {
      connection: 'network',
      autoPrint: config.autoPrintOnSale,
      dispatched,
      drawerKicked: dispatched && kick,
    };
  }

  // client / browser — hand the payload back for the terminal to print.
  const payloads = renderReceiptPayloads(receipt, { copies: config.copies, drawerKickPin });
  return {
    connection: config.connection,
    autoPrint: config.autoPrintOnSale,
    paperWidth: config.paperWidth,
    charsPerLine: config.charsPerLine,
    drawerKick: kick,
    ...(config.connection === 'client' && { escposBase64: payloads.escposBase64 }),
    receiptText: payloads.text,
  };
}

/** Result of an explicit (on-demand) network print / drawer-open request. */
export type NetworkActionResult = { ok: boolean; error?: string };

/** Explicitly print a sale's receipt to the store's network printer (reprint button). */
export async function printSaleToNetwork(
  database: typeof Db,
  input: {
    storeId: string;
    saleId: string;
    config: ResolvedPrinterConfig;
    openDrawer?: boolean;
  },
): Promise<NetworkActionResult> {
  const { config } = input;
  if (config.connection !== 'network' || !config.host) {
    return { ok: false, error: 'Store is not configured for a network printer' };
  }
  const receipt = await assembleReceipt(database, {
    storeId: input.storeId,
    saleId: input.saleId,
    config,
  });
  if (!receipt) return { ok: false, error: 'Sale not found' };

  const drawerKickPin =
    input.openDrawer && config.cashDrawerEnabled ? config.cashDrawerPin : null;
  const bytes = renderReceiptEscPos(receipt, { copies: config.copies, drawerKickPin });
  try {
    await printToNetwork(config.host, config.port, bytes);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Pop the cash drawer on the network printer with no receipt (no-sale open). */
export async function openDrawerOnNetwork(
  config: ResolvedPrinterConfig,
): Promise<NetworkActionResult> {
  if (config.connection !== 'network' || !config.host) {
    return { ok: false, error: 'Store is not configured for a network printer' };
  }
  if (!config.cashDrawerEnabled) {
    return { ok: false, error: 'Cash drawer is not enabled' };
  }
  try {
    await printToNetwork(config.host, config.port, drawerKick(config.cashDrawerPin));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** ESC/POS drawer-kick bytes as base64, for a client/browser terminal to relay (no-sale open). */
export function drawerKickPayload(config: ResolvedPrinterConfig): string {
  return drawerKick(config.cashDrawerPin).toString('base64');
}
