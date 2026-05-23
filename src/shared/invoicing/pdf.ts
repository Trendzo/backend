/**
 * PDF render for consumer tax invoices, supplementary invoices, and credit notes.
 * Sync render via pdfkit → returns a Buffer. Caller uploads to Cloudinary.
 */
import PDFDocument from 'pdfkit';

export type InvoiceLine = {
  description: string;
  hsn: string | null;
  qty: number;
  unitPricePaise: number;
  gstRateBp: number;
  taxableValuePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
};

export type InvoiceRenderInput = {
  title: string; // "TAX INVOICE", "SUPPLEMENTARY INVOICE", "CREDIT NOTE"
  number: string;
  issuedAt: Date;
  store: {
    legalName: string;
    address: string;
    gstin: string;
    stateCode: string;
  };
  consumer: {
    name: string;
    billingAddress: string;
    gstin: string | null;
  };
  lines: InvoiceLine[];
  totals: {
    subtotalPaise: number;
    discountPaise: number;
    taxableValuePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    tcsPaise: number;
    grandTotalPaise: number;
  };
  footer?: string;
  /** Reference to parent invoice number — only for credit notes. */
  parentInvoiceNumber?: string;
  /** Reason — only for credit notes. */
  reason?: string;
};

const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

export function renderInvoicePdf(input: InvoiceRenderInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(18).text(input.title, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).text(`Number: ${input.number}`, { align: 'center' });
    doc.text(`Issued: ${input.issuedAt.toISOString().slice(0, 19).replace('T', ' ')} UTC`, {
      align: 'center',
    });
    if (input.parentInvoiceNumber) {
      doc.text(`Against invoice: ${input.parentInvoiceNumber}`, { align: 'center' });
    }
    doc.moveDown();

    // Store + consumer block
    const colY = doc.y;
    doc.fontSize(10).font('Helvetica-Bold').text('Issued by (Seller)', 40, colY);
    doc.font('Helvetica').text(input.store.legalName, 40, colY + 14);
    doc.text(input.store.address, 40, colY + 28, { width: 240 });
    doc.text(`GSTIN: ${input.store.gstin}`, 40, doc.y + 4);
    doc.text(`State code: ${input.store.stateCode}`);

    const consumerY = colY;
    doc.font('Helvetica-Bold').text('Billed to (Consumer)', 320, consumerY);
    doc.font('Helvetica').text(input.consumer.name, 320, consumerY + 14);
    doc.text(input.consumer.billingAddress, 320, consumerY + 28, { width: 230 });
    if (input.consumer.gstin) {
      doc.text(`GSTIN: ${input.consumer.gstin}`, 320, doc.y + 4);
    }

    doc.moveDown(2);
    if (input.reason) {
      doc.font('Helvetica-Oblique').text(`Reason: ${input.reason}`);
      doc.font('Helvetica');
      doc.moveDown(0.5);
    }

    // Items table
    const tableTop = doc.y + 10;
    const cols = ['Description', 'HSN', 'Qty', 'Rate', 'GST%', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total'];
    const colWidths = [110, 50, 30, 50, 35, 55, 45, 45, 45, 55];
    const colX: number[] = [];
    let runX = 40;
    for (const w of colWidths) {
      colX.push(runX);
      runX += w;
    }

    doc.fontSize(8).font('Helvetica-Bold');
    cols.forEach((c, i) => doc.text(c, colX[i]!, tableTop, { width: colWidths[i]!, align: 'left' }));
    doc.moveTo(40, tableTop + 12).lineTo(555, tableTop + 12).stroke();

    let rowY = tableTop + 16;
    doc.font('Helvetica');
    for (const ln of input.lines) {
      const row = [
        ln.description,
        ln.hsn ?? '-',
        String(ln.qty),
        rupees(ln.unitPricePaise),
        `${(ln.gstRateBp / 100).toFixed(2)}%`,
        rupees(ln.taxableValuePaise),
        rupees(ln.cgstPaise),
        rupees(ln.sgstPaise),
        rupees(ln.igstPaise),
        rupees(ln.totalPaise),
      ];
      const lineHeight = 20;
      row.forEach((cell, i) =>
        doc.text(cell, colX[i]!, rowY, { width: colWidths[i]!, align: 'left' }),
      );
      rowY += lineHeight;
      if (rowY > 720) {
        doc.addPage();
        rowY = 40;
      }
    }
    doc.moveTo(40, rowY).lineTo(555, rowY).stroke();
    rowY += 10;

    // Totals
    const labels: Array<[string, number]> = [
      ['Subtotal', input.totals.subtotalPaise],
      ['Discount', -input.totals.discountPaise],
      ['Taxable value', input.totals.taxableValuePaise],
      ['CGST', input.totals.cgstPaise],
      ['SGST', input.totals.sgstPaise],
      ['IGST', input.totals.igstPaise],
      ['TCS', input.totals.tcsPaise],
      ['Grand total', input.totals.grandTotalPaise],
    ];
    doc.fontSize(10);
    for (const [label, amount] of labels) {
      doc.text(label, 350, rowY, { width: 100, align: 'right' });
      doc.text(rupees(amount), 460, rowY, { width: 95, align: 'right' });
      rowY += 14;
    }

    rowY += 20;
    doc.fontSize(8).font('Helvetica-Oblique');
    doc.text(
      input.footer ??
        `Issued by ClosetX on behalf of ${input.store.legalName} under GSTIN ${input.store.gstin}.`,
      40,
      rowY,
      { width: 515, align: 'left' },
    );

    doc.end();
  });
}
