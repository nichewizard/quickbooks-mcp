import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ESM-compatible module mocking — must be set up before importing the tool.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { GetInvoicePdfTool } = await import('../../../src/tools/get-invoice-pdf.tool');

const handler = (args: any) => (GetInvoicePdfTool.handler as any)({ params: args });

describe('GetInvoicePdfTool', () => {
  const originalAllowlist = process.env.QBO_PDF_OUTPUT_DIR;
  let tmpRoot: string;

  beforeEach(() => {
    resetAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-pdf-tool-test-'));
  });

  afterEach(() => {
    if (originalAllowlist === undefined) {
      delete process.env.QBO_PDF_OUTPUT_DIR;
    } else {
      process.env.QBO_PDF_OUTPUT_DIR = originalAllowlist;
    }
    // Best-effort cleanup of the per-test sandbox.
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('inline (base64) mode', () => {
    it('returns the PDF as base64 when output_path is omitted', async () => {
      const pdf = Buffer.from('%PDF-1.4 inline');
      mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, pdf));

      const result = await handler({ invoice_id: '42' });

      expect(result.content).toHaveLength(2);
      expect(result.content[0].text).toContain('Invoice 42 PDF');
      expect(result.content[1].text).toBe(pdf.toString('base64'));
    });

    it('surfaces handler-level errors verbatim', async () => {
      mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) =>
        cb(new Error('Invoice not found'), null)
      );

      const result = await handler({ invoice_id: 'missing' });

      expect(result.content[0].text).toMatch(/Error downloading invoice missing/);
      expect(result.content[0].text).toMatch(/Invoice not found/);
    });
  });

  describe('disk write mode', () => {
    it('refuses to write when QBO_PDF_OUTPUT_DIR is unset', async () => {
      delete process.env.QBO_PDF_OUTPUT_DIR;
      const pdf = Buffer.from('%PDF-1.4');
      mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, pdf));

      const result = await handler({ invoice_id: '1', output_path: '/tmp/anywhere.pdf' });

      expect(result.content[0].text).toMatch(/Disk writes are disabled/);
      expect(result.content[0].text).toMatch(/QBO_PDF_OUTPUT_DIR/);
    });

    it('refuses to write when QBO_PDF_OUTPUT_DIR is empty/whitespace', async () => {
      process.env.QBO_PDF_OUTPUT_DIR = '   ';
      const pdf = Buffer.from('%PDF-1.4');
      mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, pdf));

      const result = await handler({ invoice_id: '1', output_path: 'foo.pdf' });

      expect(result.content[0].text).toMatch(/Disk writes are disabled/);
    });

    it('writes the PDF to disk when the resolved path is inside the allowlist', async () => {
      process.env.QBO_PDF_OUTPUT_DIR = tmpRoot;
      const pdf = Buffer.from('%PDF-1.4 ondisk');
      mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, pdf));

      const out = path.join(tmpRoot, 'invoice-1.pdf');
      const result = await handler({ invoice_id: '1', output_path: out });

      expect(result.content[0].text).toMatch(/Wrote \d+ bytes to/);
      expect(fs.readFileSync(out)).toEqual(pdf);
    });

    it('accepts a relative output_path resolved against the allowlist', async () => {
      process.env.QBO_PDF_OUTPUT_DIR = tmpRoot;
      const pdf = Buffer.from('rel');
      mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, pdf));

      const result = await handler({ invoice_id: '1', output_path: 'invoice-rel.pdf' });

      expect(result.content[0].text).toMatch(/Wrote \d+ bytes to/);
      expect(fs.readFileSync(path.join(tmpRoot, 'invoice-rel.pdf'))).toEqual(pdf);
    });

    it('rejects paths containing .. segments', async () => {
      process.env.QBO_PDF_OUTPUT_DIR = tmpRoot;
      mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, Buffer.from('x')));

      const result = await handler({ invoice_id: '1', output_path: '../escape.pdf' });

      expect(result.content[0].text).toMatch(/".."/);
    });

    it('rejects absolute paths that resolve outside the allowlist', async () => {
      process.env.QBO_PDF_OUTPUT_DIR = tmpRoot;
      mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, Buffer.from('x')));
      const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-pdf-tool-sibling-'));
      try {
        const out = path.join(sibling, 'escape.pdf');
        const result = await handler({ invoice_id: '1', output_path: out });
        expect(result.content[0].text).toMatch(/resolves outside QBO_PDF_OUTPUT_DIR/);
      } finally {
        fs.rmSync(sibling, { recursive: true, force: true });
      }
    });

    it('rejects symlinked parent directories that point outside the allowlist', async () => {
      process.env.QBO_PDF_OUTPUT_DIR = tmpRoot;
      mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, Buffer.from('x')));
      const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-pdf-tool-symlink-target-'));
      const linkPath = path.join(tmpRoot, 'link');
      try {
        fs.symlinkSync(sibling, linkPath);
        const result = await handler({ invoice_id: '1', output_path: 'link/escape.pdf' });
        expect(result.content[0].text).toMatch(/resolves outside QBO_PDF_OUTPUT_DIR/);
      } finally {
        try { fs.unlinkSync(linkPath); } catch { /* ignore */ }
        fs.rmSync(sibling, { recursive: true, force: true });
      }
    });

    it('returns an error when the allowlist directory itself does not exist', async () => {
      process.env.QBO_PDF_OUTPUT_DIR = path.join(tmpRoot, 'does-not-exist');
      mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, Buffer.from('x')));

      const result = await handler({ invoice_id: '1', output_path: 'foo.pdf' });

      expect(result.content[0].text).toMatch(/QBO_PDF_OUTPUT_DIR/);
      expect(result.content[0].text).toMatch(/does not resolve/);
    });

    it('returns an error when the output_path parent does not exist', async () => {
      process.env.QBO_PDF_OUTPUT_DIR = tmpRoot;
      mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, Buffer.from('x')));

      const result = await handler({ invoice_id: '1', output_path: 'nested/missing/parent/foo.pdf' });

      expect(result.content[0].text).toMatch(/parent directory does not exist/);
    });

    it('refuses to overwrite an existing file by default', async () => {
      process.env.QBO_PDF_OUTPUT_DIR = tmpRoot;
      const pdf = Buffer.from('new');
      mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, pdf));
      const out = path.join(tmpRoot, 'existing.pdf');
      fs.writeFileSync(out, Buffer.from('original'));

      const result = await handler({ invoice_id: '1', output_path: out });

      expect(result.content[0].text).toMatch(/Failed to write PDF/);
      // The file should still contain the original bytes.
      expect(fs.readFileSync(out, 'utf8')).toBe('original');
    });

    it('overwrites when overwrite=true', async () => {
      process.env.QBO_PDF_OUTPUT_DIR = tmpRoot;
      const pdf = Buffer.from('new');
      mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, pdf));
      const out = path.join(tmpRoot, 'existing.pdf');
      fs.writeFileSync(out, Buffer.from('original'));

      const result = await handler({ invoice_id: '1', output_path: out, overwrite: true });

      expect(result.content[0].text).toMatch(/Wrote 3 bytes/);
      expect(fs.readFileSync(out, 'utf8')).toBe('new');
    });

    it('handles QBO_PDF_OUTPUT_DIR with a trailing separator', async () => {
      process.env.QBO_PDF_OUTPUT_DIR = tmpRoot + path.sep;
      const pdf = Buffer.from('trailing-sep');
      mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, pdf));

      const result = await handler({ invoice_id: '1', output_path: 'trail.pdf' });

      expect(result.content[0].text).toMatch(/Wrote \d+ bytes/);
      expect(fs.readFileSync(path.join(tmpRoot, 'trail.pdf'))).toEqual(pdf);
    });

    it('writes when the output_path is exactly inside the allowlist root (no subdir)', async () => {
      process.env.QBO_PDF_OUTPUT_DIR = tmpRoot;
      const pdf = Buffer.from('root');
      mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, pdf));

      const out = path.join(tmpRoot, 'root.pdf');
      const result = await handler({ invoice_id: '1', output_path: out });

      expect(result.content[0].text).toMatch(/Wrote/);
      expect(fs.readFileSync(out)).toEqual(pdf);
    });

    it('returns an error when the underlying writeFileSync throws unexpectedly', async () => {
      process.env.QBO_PDF_OUTPUT_DIR = tmpRoot;
      const pdf = Buffer.from('x');
      mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, pdf));
      // Make the target a directory so writeFileSync EISDIRs.
      const out = path.join(tmpRoot, 'target-is-dir.pdf');
      fs.mkdirSync(out);

      const result = await handler({ invoice_id: '1', output_path: out, overwrite: true });

      expect(result.content[0].text).toMatch(/Failed to write PDF/);
    });
  });
});
