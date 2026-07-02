/**
 * ESC/POS receipt + cash-drawer byte builder.
 *
 * Pure, dependency-free byte assembly for thermal receipt printers (the near-universal ESC/POS
 * command set — Epson TM series, and the Chinese 58/80mm clones that copy it). The same bytes
 * work whether they are streamed to an IP printer over TCP from the backend or handed to a paired
 * Bluetooth/USB terminal app as a base64 blob — this module has no I/O of its own.
 *
 * The default single-byte code page has no ₹ glyph, so money is rendered as plain digits with a
 * leading "Rs." where a currency marker helps; everything stays in printable ASCII.
 */

// ───────────────────────── raw commands ─────────────────────────

const ESC = 0x1b;
const GS = 0x1d;

const CMD = {
  init: [ESC, 0x40], // ESC @  — reset printer
  alignLeft: [ESC, 0x61, 0],
  alignCenter: [ESC, 0x61, 1],
  alignRight: [ESC, 0x61, 2],
  boldOn: [ESC, 0x45, 1],
  boldOff: [ESC, 0x45, 0],
  // GS ! n — n's high nibble = height multiplier, low nibble = width multiplier.
  sizeNormal: [GS, 0x21, 0x00],
  sizeDoubleHeight: [GS, 0x21, 0x01],
  sizeDouble: [GS, 0x21, 0x11], // double width + height
  feed: [0x0a],
  // GS V 66 n — partial cut after feeding n dots.
  cut: [GS, 0x56, 66, 0x00],
} as const;

/**
 * Cash-drawer kick pulse: ESC p m t1 t2. `m` selects the connector pin (0 => pin 2, 1 => pin 5);
 * t1/t2 are the on/off pulse durations in 2ms units (25 => ~50ms on, 250 => ~500ms off) which is
 * the safe default virtually every drawer accepts.
 */
export function drawerKick(pin: 0 | 1): Buffer {
  return Buffer.from([ESC, 0x70, pin, 0x19, 0xfa]);
}

// ───────────────────────── text layout helpers ─────────────────────────

/** Two-column line: `left` flush-left, `right` flush-right, padded to `width`. Truncates left. */
function twoCol(left: string, right: string, width: number): string {
  const space = width - right.length;
  if (space <= 1) return `${left} ${right}`.slice(0, width);
  const l = left.length > space - 1 ? left.slice(0, space - 1) : left;
  return l + ' '.repeat(width - l.length - right.length) + right;
}

/** Wrap `text` to `width`-char lines on word boundaries (hard-splits over-long words). */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (w.length > width) {
      if (cur) {
        lines.push(cur);
        cur = '';
      }
      for (let i = 0; i < w.length; i += width) lines.push(w.slice(i, i + width));
      continue;
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/** paise → grouped rupee string, e.g. 123456 => "1,234.56". Negative-aware. */
export function rupees(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100).toString();
  const frac = (abs % 100).toString().padStart(2, '0');
  // Indian grouping: last 3 digits, then pairs.
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${neg ? '-' : ''}${grouped}.${frac}`;
}

// ───────────────────────── receipt contract ─────────────────────────

export type PosReceiptLine = {
  name: string;
  qty: number;
  unitPaise: number;
  gstRateBp: number;
  lineTotalPaise: number;
};

export type PosReceiptTender = {
  method: 'cash' | 'card' | 'upi';
  amountPaise: number;
  changePaise: number;
  reference?: string | null;
};

export type PosReceipt = {
  title: string; // 'TAX INVOICE' | 'BILL OF SUPPLY' | 'CREDIT NOTE' etc.
  storeName: string;
  storeAddress: string;
  storeGstin: string;
  invoiceNumber: string | null;
  saleId: string;
  isReturn: boolean;
  dateTime: string;
  cashier?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerGstin?: string | null;
  lines: PosReceiptLine[];
  itemsGrossPaise: number;
  discountPaise: number;
  taxableValuePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  roundOffPaise: number;
  payablePaise: number;
  tenders: PosReceiptTender[];
  changePaise: number;
  headerText?: string | null;
  footerText?: string | null;
  showGstBreakup: boolean;
  charsPerLine: number;
};

// ───────────────────────── renderers ─────────────────────────

/**
 * Render a receipt as a plain-text block (for a `browser`/text preview, or debugging). Uses the
 * same column layout the ESC/POS renderer draws, so the two stay visually identical.
 */
export function renderReceiptText(r: PosReceipt): string {
  const w = r.charsPerLine;
  const rule = '-'.repeat(w);
  const center = (s: string) => {
    const t = s.length > w ? s.slice(0, w) : s;
    const pad = Math.floor((w - t.length) / 2);
    return ' '.repeat(Math.max(0, pad)) + t;
  };
  const out: string[] = [];

  if (r.headerText) for (const l of r.headerText.split('\n')) out.push(center(l));
  out.push(center(r.storeName));
  for (const l of wrap(r.storeAddress, w)) out.push(center(l));
  if (r.storeGstin) out.push(center(`GSTIN: ${r.storeGstin}`));
  out.push(center(r.title));
  out.push(rule);

  if (r.invoiceNumber) out.push(twoCol('Bill', r.invoiceNumber, w));
  out.push(twoCol('Date', r.dateTime, w));
  if (r.cashier) out.push(twoCol('Cashier', r.cashier, w));
  if (r.customerName) out.push(twoCol('Customer', r.customerName, w));
  if (r.customerPhone) out.push(twoCol('Phone', r.customerPhone, w));
  if (r.customerGstin) out.push(twoCol('Cust GSTIN', r.customerGstin, w));
  out.push(rule);

  out.push(twoCol('Item', 'Amount', w));
  out.push(rule);
  for (const line of r.lines) {
    for (const nl of wrap(line.name, w)) out.push(nl);
    const qtyStr = `  ${line.qty} x ${rupees(line.unitPaise)}`;
    out.push(twoCol(qtyStr, rupees(line.lineTotalPaise), w));
  }
  out.push(rule);

  out.push(twoCol('Subtotal', rupees(r.itemsGrossPaise), w));
  if (r.discountPaise > 0) out.push(twoCol('Discount', `-${rupees(r.discountPaise)}`, w));
  if (r.showGstBreakup) {
    out.push(twoCol('Taxable', rupees(r.taxableValuePaise), w));
    if (r.igstPaise > 0) out.push(twoCol('IGST', rupees(r.igstPaise), w));
    else {
      out.push(twoCol('CGST', rupees(r.cgstPaise), w));
      out.push(twoCol('SGST', rupees(r.sgstPaise), w));
    }
  }
  if (r.roundOffPaise !== 0) out.push(twoCol('Round off', rupees(r.roundOffPaise), w));
  out.push(rule);
  out.push(twoCol(r.isReturn ? 'REFUND' : 'TOTAL', `Rs.${rupees(r.payablePaise)}`, w));
  out.push(rule);

  for (const t of r.tenders) {
    const label = t.method.toUpperCase() + (t.reference ? ` (${t.reference})` : '');
    out.push(twoCol(label, rupees(t.amountPaise), w));
  }
  if (r.changePaise > 0) out.push(twoCol('Change', rupees(r.changePaise), w));

  if (r.footerText) {
    out.push('');
    for (const l of r.footerText.split('\n')) out.push(center(l));
  }
  return out.join('\n');
}

type EscPosOptions = {
  copies?: number;
  /** Append a cash-drawer kick pulse after the last copy. */
  drawerKickPin?: 0 | 1 | null;
};

/**
 * Render a receipt to an ESC/POS byte buffer. Emphasis (bold/size) is applied to the header and
 * grand total; everything else is monospaced body text. Cuts the paper after each copy and,
 * optionally, fires the drawer kick once at the very end.
 */
export function renderReceiptEscPos(r: PosReceipt, opts: EscPosOptions = {}): Buffer {
  const w = r.charsPerLine;
  const parts: number[] = [];
  const push = (bytes: readonly number[]) => parts.push(...bytes);
  const line = (s = '') => push([...Buffer.from(`${s}\n`, 'ascii')]);
  const rule = '-'.repeat(w);

  const copies = Math.max(1, opts.copies ?? 1);
  for (let c = 0; c < copies; c++) {
    push(CMD.init);

    // Header — centered, store name emphasised.
    push(CMD.alignCenter);
    if (r.headerText) {
      for (const l of r.headerText.split('\n')) line(l);
    }
    push(CMD.boldOn);
    push(CMD.sizeDoubleHeight);
    line(r.storeName);
    push(CMD.sizeNormal);
    push(CMD.boldOff);
    for (const l of wrap(r.storeAddress, w)) line(l);
    if (r.storeGstin) line(`GSTIN: ${r.storeGstin}`);
    push(CMD.boldOn);
    line(r.title);
    push(CMD.boldOff);

    // Meta + body — left aligned.
    push(CMD.alignLeft);
    line(rule);
    if (r.invoiceNumber) line(twoCol('Bill', r.invoiceNumber, w));
    line(twoCol('Date', r.dateTime, w));
    if (r.cashier) line(twoCol('Cashier', r.cashier, w));
    if (r.customerName) line(twoCol('Customer', r.customerName, w));
    if (r.customerPhone) line(twoCol('Phone', r.customerPhone, w));
    if (r.customerGstin) line(twoCol('Cust GSTIN', r.customerGstin, w));
    line(rule);

    line(twoCol('Item', 'Amount', w));
    line(rule);
    for (const li of r.lines) {
      for (const nl of wrap(li.name, w)) line(nl);
      line(twoCol(`  ${li.qty} x ${rupees(li.unitPaise)}`, rupees(li.lineTotalPaise), w));
    }
    line(rule);

    line(twoCol('Subtotal', rupees(r.itemsGrossPaise), w));
    if (r.discountPaise > 0) line(twoCol('Discount', `-${rupees(r.discountPaise)}`, w));
    if (r.showGstBreakup) {
      line(twoCol('Taxable', rupees(r.taxableValuePaise), w));
      if (r.igstPaise > 0) {
        line(twoCol('IGST', rupees(r.igstPaise), w));
      } else {
        line(twoCol('CGST', rupees(r.cgstPaise), w));
        line(twoCol('SGST', rupees(r.sgstPaise), w));
      }
    }
    if (r.roundOffPaise !== 0) line(twoCol('Round off', rupees(r.roundOffPaise), w));
    line(rule);

    push(CMD.boldOn);
    push(CMD.sizeDouble);
    line(twoCol(r.isReturn ? 'REFUND' : 'TOTAL', rupees(r.payablePaise), Math.floor(w / 2)));
    push(CMD.sizeNormal);
    push(CMD.boldOff);
    line(rule);

    for (const t of r.tenders) {
      const label = t.method.toUpperCase() + (t.reference ? ` (${t.reference})` : '');
      line(twoCol(label, rupees(t.amountPaise), w));
    }
    if (r.changePaise > 0) line(twoCol('Change', rupees(r.changePaise), w));

    if (r.footerText) {
      push(CMD.alignCenter);
      line();
      for (const l of r.footerText.split('\n')) line(l);
    }

    push(CMD.feed);
    push(CMD.feed);
    push(CMD.cut);
  }

  if (opts.drawerKickPin === 0 || opts.drawerKickPin === 1) {
    push([...drawerKick(opts.drawerKickPin)]);
  }

  return Buffer.from(parts);
}
