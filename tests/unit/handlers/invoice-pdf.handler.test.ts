import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// ESM-compatible module mocking
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

// Dynamic import after mock setup
const { getQuickbooksInvoicePdf } = await import('../../../src/handlers/get-quickbooks-invoice-pdf.handler');

describe('getQuickbooksInvoicePdf', () => {
  const originalMax = process.env.QBO_PDF_MAX_BYTES;

  beforeEach(() => {
    resetAllMocks();
    delete process.env.QBO_PDF_MAX_BYTES;
  });

  afterEach(() => {
    if (originalMax === undefined) {
      delete process.env.QBO_PDF_MAX_BYTES;
    } else {
      process.env.QBO_PDF_MAX_BYTES = originalMax;
    }
  });

  it('returns the PDF buffer on success', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake');
    mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, pdf));

    const result = await getQuickbooksInvoicePdf('123');

    expect(result.isError).toBe(false);
    expect(result.result).toBe(pdf);
    expect(result.error).toBeNull();
  });

  it('passes the invoice id through to node-quickbooks', async () => {
    mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, Buffer.from('x')));

    await getQuickbooksInvoicePdf('999');

    expect(mockQuickBooksInstance.getInvoicePdf).toHaveBeenCalledWith('999', expect.any(Function));
  });

  it('returns isError when the API callback yields an error', async () => {
    mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) =>
      cb(new Error('Invoice not found'), null)
    );

    const result = await getQuickbooksInvoicePdf('missing');

    expect(result.isError).toBe(true);
    expect(result.result).toBeNull();
    expect(result.error).toContain('Invoice not found');
  });

  it('returns isError when authentication fails', async () => {
    (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

    const result = await getQuickbooksInvoicePdf('123');

    expect(result.isError).toBe(true);
    expect(result.error).toContain('Auth failed');
  });

  it('returns isError when PDF exceeds the default 50 MiB cap', async () => {
    // Buffer.alloc with a single byte then re-report a fake length: avoids
    // actually allocating 50 MiB just to test the bounds check.
    const oversized = Buffer.alloc(1);
    Object.defineProperty(oversized, 'length', { value: 50 * 1024 * 1024 + 1 });
    mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, oversized));

    const result = await getQuickbooksInvoicePdf('huge');

    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/exceeds cap/);
  });

  it('honors a QBO_PDF_MAX_BYTES override', async () => {
    process.env.QBO_PDF_MAX_BYTES = '10';
    const pdf = Buffer.from('twelve-bytes'); // 12 bytes > 10
    mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, pdf));

    const result = await getQuickbooksInvoicePdf('123');

    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/exceeds cap of 10 bytes/);
  });

  it('falls back to the default cap when QBO_PDF_MAX_BYTES is not a positive integer', async () => {
    process.env.QBO_PDF_MAX_BYTES = 'not-a-number';
    const pdf = Buffer.from('small');
    mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, pdf));

    const result = await getQuickbooksInvoicePdf('123');

    expect(result.isError).toBe(false);
    expect(result.result).toBe(pdf);
  });

  it('falls back to the default cap when QBO_PDF_MAX_BYTES is zero or negative', async () => {
    process.env.QBO_PDF_MAX_BYTES = '0';
    const pdf = Buffer.from('small');
    mockQuickBooksInstance.getInvoicePdf.mockImplementation((_id: any, cb: any) => cb(null, pdf));

    const result = await getQuickbooksInvoicePdf('123');

    expect(result.isError).toBe(false);
    expect(result.result).toBe(pdf);
  });
});
