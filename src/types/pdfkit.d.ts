declare module 'pdfkit' {
  class PDFDocument {
    constructor(options?: Record<string, unknown>);
    fontSize(size: number): this;
    font(name: string): this;
    text(text: string, ...args: any[]): this;
    moveDown(lines?: number): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    stroke(): this;
    addPage(options?: Record<string, unknown>): this;
    end(): void;
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    pipe<T extends NodeJS.WritableStream>(destination: T): T;
    y: number;
    page: { width: number; height: number };
  }

  export = PDFDocument;
}
