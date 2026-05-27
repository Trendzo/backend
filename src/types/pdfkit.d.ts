declare module 'pdfkit' {
  import { Writable } from 'stream';

  class PDFDocument extends Writable {
    constructor(options?: Record<string, unknown>);
    fontSize(size: number): this;
    font(name: string): this;
    text(text: string, x?: number, y?: number, options?: Record<string, unknown>): this;
    moveDown(lines?: number): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    stroke(): this;
    addPage(options?: Record<string, unknown>): this;
    end(): void;
    pipe<T extends NodeJS.WritableStream>(destination: T): T;
    y: number;
    page: { width: number; height: number };
  }

  export = PDFDocument;
}
