declare module 'pdfkit' {
  class PDFDocument {
    constructor(options?: Record<string, unknown>);
    fontSize(size: number): this;
    font(name: string): this;
    text(text: string, ...args: unknown[]): this;
    moveDown(lines?: number): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    stroke(): this;
    addPage(options?: Record<string, unknown>): this;
    end(): void;
    on(event: string, listener: (...args: unknown[]) => void): this;
    pipe<T extends NodeJS.WritableStream>(destination: T): T;
    y: number;
    page: { width: number; height: number };
  }

  export = PDFDocument;
}
