import { describe, expect, it } from 'vitest';
import {
  drawerKick,
  renderReceiptEscPos,
  renderReceiptText,
  rupees,
  type PosReceipt,
} from './escpos.js';

function receipt(over: Partial<PosReceipt> = {}): PosReceipt {
  return {
    title: 'TAX INVOICE',
    storeName: 'Acme Apparel',
    storeAddress: '12 MG Road, Bengaluru 560001',
    storeGstin: '29ABCDE1234F1Z5',
    invoiceNumber: 'POS-A/25-26/0001',
    saleId: 'pos_1',
    isReturn: false,
    dateTime: '02/07/2026 03:45 pm',
    cashier: 'Priya',
    customerName: 'Walk-in',
    customerPhone: null,
    customerGstin: null,
    lines: [
      { name: 'Cotton Tee (M)', qty: 2, unitPaise: 49900, gstRateBp: 500, lineTotalPaise: 99800 },
    ],
    itemsGrossPaise: 99800,
    discountPaise: 0,
    taxableValuePaise: 95048,
    cgstPaise: 2376,
    sgstPaise: 2376,
    igstPaise: 0,
    roundOffPaise: 0,
    payablePaise: 99800,
    tenders: [{ method: 'cash', amountPaise: 100000, changePaise: 200 }],
    changePaise: 200,
    headerText: null,
    footerText: 'Thank you!',
    showGstBreakup: true,
    charsPerLine: 48,
    ...over,
  };
}

describe('rupees', () => {
  it('formats paise with Indian grouping + 2 decimals', () => {
    expect(rupees(0)).toBe('0.00');
    expect(rupees(5)).toBe('0.05');
    expect(rupees(99800)).toBe('998.00');
    expect(rupees(12345678)).toBe('1,23,456.78');
  });
  it('is negative-aware (round-off / credit notes)', () => {
    expect(rupees(-150)).toBe('-1.50');
  });
});

describe('drawerKick', () => {
  it('emits the ESC p m t1 t2 pulse for the selected pin', () => {
    expect([...drawerKick(0)]).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
    expect([...drawerKick(1)]).toEqual([0x1b, 0x70, 0x01, 0x19, 0xfa]);
  });
});

describe('renderReceiptText', () => {
  it('renders store, total and tender lines', () => {
    const text = renderReceiptText(receipt());
    expect(text).toContain('Acme Apparel');
    expect(text).toContain('POS-A/25-26/0001');
    expect(text).toMatch(/TOTAL\s+Rs\.998\.00/);
    expect(text).toContain('CGST');
    expect(text).toContain('SGST');
    expect(text).toMatch(/CASH\s+1,000\.00/);
    expect(text).toMatch(/Change\s+2\.00/);
  });
  it('shows IGST (not CGST/SGST) for an inter-state sale', () => {
    const text = renderReceiptText(
      receipt({ cgstPaise: 0, sgstPaise: 0, igstPaise: 4752 }),
    );
    expect(text).toContain('IGST');
    expect(text).not.toContain('CGST');
  });
  it('labels a return as REFUND', () => {
    const text = renderReceiptText(receipt({ isReturn: true, title: 'CREDIT NOTE' }));
    expect(text).toContain('CREDIT NOTE');
    expect(text).toContain('REFUND');
  });
});

describe('renderReceiptEscPos', () => {
  it('starts with the init command and ends with a cut', () => {
    const bytes = renderReceiptEscPos(receipt());
    expect([bytes[0], bytes[1]]).toEqual([0x1b, 0x40]); // ESC @
    // last 4 bytes are the partial-cut command GS V 66 0
    expect([...bytes.subarray(bytes.length - 4)]).toEqual([0x1d, 0x56, 66, 0x00]);
  });
  it('appends a drawer kick only when a pin is given', () => {
    const withKick = renderReceiptEscPos(receipt(), { drawerKickPin: 0 });
    expect([...withKick.subarray(withKick.length - 5)]).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
    const without = renderReceiptEscPos(receipt(), { drawerKickPin: null });
    expect([...without.subarray(without.length - 5)]).not.toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  });
  it('repeats the body once per copy (two cuts for two copies)', () => {
    const bytes = renderReceiptEscPos(receipt(), { copies: 2 });
    let cuts = 0;
    for (let i = 0; i < bytes.length - 3; i++) {
      if (bytes[i] === 0x1d && bytes[i + 1] === 0x56 && bytes[i + 2] === 66) cuts++;
    }
    expect(cuts).toBe(2);
  });
});
