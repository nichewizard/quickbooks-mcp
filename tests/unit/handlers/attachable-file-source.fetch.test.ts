import { jest, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import { mockQuickbooksClient, mockQuickbooksClientClass } from '../../mocks/quickbooks.mock';

// Mock DNS so hostname URLs resolve to a public address (or a private one,
// per test) without real lookups.
const mockLookup = jest.fn();
jest.unstable_mockModule('dns/promises', () => ({
  lookup: mockLookup,
}));

jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

// https mock whose request object is a real Writable, so fs/web streams can
// pipe into it; the response fires only after req.end(), like a real server.
const mockHttpsRequest = jest.fn();
jest.unstable_mockModule('https', () => ({
  default: { request: mockHttpsRequest },
  request: mockHttpsRequest,
}));

function mockStreamingUploadResponse(statusCode: number, responseBody: unknown) {
  const captured: { body: Buffer } = { body: Buffer.alloc(0) };
  (mockHttpsRequest as any).mockImplementation(
    (_options: unknown, callback: (res: unknown) => void) => {
      const chunks: Buffer[] = [];
      const req = new Writable({
        write(chunk: Buffer, _enc, done) {
          chunks.push(Buffer.from(chunk));
          done();
        },
      });
      req.on('finish', () => {
        captured.body = Buffer.concat(chunks);
        const payload = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
        const res = {
          statusCode,
          on: (event: string, handler: (...args: unknown[]) => void) => {
            if (event === 'data') handler(Buffer.from(payload));
            if (event === 'end') handler();
          },
        };
        callback(res);
      });
      return req;
    }
  );
  return captured;
}

const { fetchUrlToTempFile } = await import('../../../src/helpers/attachable-file-source');
const { createQuickbooksAttachable } = await import(
  '../../../src/handlers/create-quickbooks-attachable.handler'
);

const MAX = 100 * 1024 * 1024;
const realFetch = globalThis.fetch;
const mockFetch = jest.fn();

beforeEach(() => {
  mockLookup.mockReset();
  mockFetch.mockReset();
  (mockLookup as any).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function okResponse(bytes: Buffer, headers: Record<string, string> = {}) {
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}

describe('fetchUrlToTempFile', () => {
  it('spools the body to a temp file and reports size and content-type', async () => {
    const bytes = Buffer.from('%PDF-1.7 test-bytes');
    (mockFetch as any).mockResolvedValue(okResponse(bytes, { 'content-type': 'application/pdf' }));

    const fetched = await fetchUrlToTempFile('https://example.com/doc.pdf', MAX);
    try {
      expect(fetched.size).toBe(bytes.length);
      expect(fetched.contentTypeHeader).toBe('application/pdf');
      const onDisk = await fs.readFile(fetched.path);
      expect(onDisk.equals(bytes)).toBe(true);
    } finally {
      await fetched.cleanup();
    }
    await expect(fs.stat(fetched.path)).rejects.toThrow(); // cleanup removed it
    await fetched.cleanup(); // second cleanup is a harmless no-op
  });

  it('accepts a literal public IP host without a DNS lookup', async () => {
    const bytes = Buffer.from('by-ip');
    (mockFetch as any).mockResolvedValue(okResponse(bytes));

    const fetched = await fetchUrlToTempFile('https://8.8.8.8/doc.pdf', MAX);
    try {
      expect(fetched.size).toBe(bytes.length);
      expect(mockLookup).not.toHaveBeenCalled();
    } finally {
      await fetched.cleanup();
    }
  });

  it('rejects hostnames that resolve to private addresses', async () => {
    (mockLookup as any).mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.10', family: 4 }, // one private record poisons the set
    ]);
    await expect(fetchUrlToTempFile('https://rebind.example/doc.pdf', MAX)).rejects.toThrow(/blocked/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects hostnames that do not resolve', async () => {
    (mockLookup as any).mockResolvedValue([]);
    await expect(fetchUrlToTempFile('https://nowhere.example/doc.pdf', MAX)).rejects.toThrow(
      /did not resolve/
    );
  });

  it('follows redirects and revalidates each hop', async () => {
    const bytes = Buffer.from('redirected-bytes');
    (mockFetch as any)
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/real.pdf' } })
      )
      .mockResolvedValueOnce(okResponse(bytes));

    const fetched = await fetchUrlToTempFile('https://example.com/doc.pdf', MAX);
    try {
      expect(fetched.size).toBe(bytes.length);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(String((mockFetch as any).mock.calls[1][0])).toBe('https://cdn.example.com/real.pdf');
    } finally {
      await fetched.cleanup();
    }
  });

  it('rejects redirects to blocked addresses', async () => {
    (mockFetch as any).mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/internal.pdf' } })
    );
    await expect(fetchUrlToTempFile('https://example.com/doc.pdf', MAX)).rejects.toThrow(/blocked/);
  });

  it('rejects redirect responses without a Location header', async () => {
    (mockFetch as any).mockResolvedValue(new Response(null, { status: 302 }));
    await expect(fetchUrlToTempFile('https://example.com/doc.pdf', MAX)).rejects.toThrow(
      /missing Location/
    );
  });

  it('gives up after 3 redirects', async () => {
    (mockFetch as any).mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://example.com/loop.pdf' } })
    );
    await expect(fetchUrlToTempFile('https://example.com/doc.pdf', MAX)).rejects.toThrow(
      /exceeded 3 redirects/
    );
  });

  it('rejects non-OK responses', async () => {
    (mockFetch as any).mockResolvedValue(new Response('nope', { status: 404 }));
    await expect(fetchUrlToTempFile('https://example.com/doc.pdf', MAX)).rejects.toThrow(/HTTP 404/);
  });

  it('rejects oversized files declared via Content-Length before downloading', async () => {
    (mockFetch as any).mockResolvedValue(
      okResponse(Buffer.from('x'), { 'content-length': String(MAX + 1) })
    );
    await expect(fetchUrlToTempFile('https://example.com/doc.pdf', MAX)).rejects.toThrow(
      /File too large/
    );
  });

  it('enforces the size cap while streaming when Content-Length is absent', async () => {
    const big = Buffer.alloc(64, 7);
    // Response without an explicit content-length header still carries one
    // when constructed from a buffer, so stream it chunk-wise instead.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(big));
        controller.close();
      },
    });
    (mockFetch as any).mockResolvedValue(new Response(stream, { status: 200 }));
    await expect(fetchUrlToTempFile('https://example.com/doc.pdf', 32)).rejects.toThrow(
      /File too large/
    );
  });

  it('rejects a response with no body', async () => {
    (mockFetch as any).mockResolvedValue(new Response(null, { status: 200 }));
    await expect(fetchUrlToTempFile('https://example.com/doc.pdf', MAX)).rejects.toThrow(/no body/);
  });

  it('rejects an empty body', async () => {
    const empty = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    (mockFetch as any).mockResolvedValue(new Response(empty, { status: 200 }));
    await expect(fetchUrlToTempFile('https://example.com/doc.pdf', MAX)).rejects.toThrow(
      /empty body/
    );
  });

  it('honors QUICKBOOKS_ATTACHABLE_URL_TIMEOUT_MS', async () => {
    process.env.QUICKBOOKS_ATTACHABLE_URL_TIMEOUT_MS = '5000';
    try {
      const bytes = Buffer.from('timed');
      (mockFetch as any).mockResolvedValue(okResponse(bytes));
      const fetched = await fetchUrlToTempFile('https://example.com/doc.pdf', MAX);
      await fetched.cleanup();
      const passedSignal = (mockFetch as any).mock.calls[0][1].signal;
      expect(passedSignal).toBeInstanceOf(AbortSignal);
    } finally {
      delete process.env.QUICKBOOKS_ATTACHABLE_URL_TIMEOUT_MS;
    }
  });
});

describe('createQuickbooksAttachable file-source upload flows', () => {
  let baseDir: string;
  const savedEnv = process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR;
  const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 0x42)]);

  beforeAll(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qbo-attach-flow-'));
    process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR = baseDir;
    await fs.writeFile(path.join(baseDir, 'invoice.pdf'), pdfBytes);
    await fs.writeFile(path.join(baseDir, 'archive.zip'), Buffer.alloc(64, 1));
  });

  afterAll(async () => {
    if (savedEnv === undefined) delete process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR;
    else process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR = savedEnv;
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('streams a file_path source and infers content type from the file name', async () => {
    const captured = mockStreamingUploadResponse(200, { AttachableResponse: [{ Attachable: { Id: '1' } }] });

    const result = await createQuickbooksAttachable({
      file_name: 'invoice.pdf',
      file_path: path.join(baseDir, 'invoice.pdf'),
    });

    expect(result.isError).toBe(false);
    const body = captured.body;
    expect(body.includes(pdfBytes)).toBe(true); // file bytes made it intact
    expect(body.toString('utf8', 0, 600)).toContain('Content-Type: application/pdf');
    expect(body.toString('utf8', 0, 600)).toContain('"ContentType":"application/pdf"');
  });

  it('respects an explicit content_type override', async () => {
    const captured = mockStreamingUploadResponse(200, { ok: true });

    const result = await createQuickbooksAttachable({
      file_name: 'invoice.pdf',
      file_path: path.join(baseDir, 'invoice.pdf'),
      content_type: 'text/plain',
    });

    expect(result.isError).toBe(false);
    expect(captured.body.toString('utf8', 0, 600)).toContain('Content-Type: text/plain');
  });

  it('rejects a file with no inferable, QBO-supported content type', async () => {
    const result = await createQuickbooksAttachable({
      file_name: 'archive.zip',
      file_path: path.join(baseDir, 'archive.zip'),
    });
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/Unsupported content_type/);
  });

  it('uploads a file_url source, using the response content-type as fallback', async () => {
    (mockLookup as any).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const bytes = Buffer.from('%PDF-1.7 from-url');
    (mockFetch as any).mockResolvedValue(
      new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-type': 'application/pdf; charset=binary' },
      })
    );
    const captured = mockStreamingUploadResponse(200, { ok: true });

    const result = await createQuickbooksAttachable({
      file_name: 'no-extension-name', // forces the header fallback
      file_url: 'https://example.com/download/8842',
    });

    expect(result.isError).toBe(false);
    expect(captured.body.includes(bytes)).toBe(true);
    expect(captured.body.toString('utf8', 0, 600)).toContain('Content-Type: application/pdf');
  });

  it('infers the type from the URL path, ignoring query-string extensions', async () => {
    (mockLookup as any).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const bytes = Buffer.from('%PDF-1.7 signed');
    (mockFetch as any).mockResolvedValue(
      new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    );
    const captured = mockStreamingUploadResponse(200, { ok: true });

    const result = await createQuickbooksAttachable({
      file_name: 'download', // no extension: URL path must supply the type
      file_url: 'https://cdn.example.com/doc.pdf?sig=a1b2', // query must not break inference
    });

    expect(result.isError).toBe(false);
    expect(captured.body.toString('utf8', 0, 600)).toContain('Content-Type: application/pdf');
  });

  it('does not let a query-string extension spoof the content type', async () => {
    (mockLookup as any).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    (mockFetch as any).mockResolvedValue(
      new Response(new Uint8Array(Buffer.from('<html>')), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    );

    const result = await createQuickbooksAttachable({
      file_name: 'export',
      file_url: 'https://example.com/export?file=report.pdf', // .pdf only in the query
    });

    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/Unsupported content_type/);
  });

  it('accepts a QBO-supported Content-Type header regardless of case', async () => {
    (mockLookup as any).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const bytes = Buffer.from('%PDF-1.7 mixed-case');
    (mockFetch as any).mockResolvedValue(
      new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-type': 'Application/PDF' }, // IIS-style casing
      })
    );
    const captured = mockStreamingUploadResponse(200, { ok: true });

    const result = await createQuickbooksAttachable({
      file_name: 'download',
      file_url: 'https://example.com/get/123',
    });

    expect(result.isError).toBe(false);
    expect(captured.body.toString('utf8', 0, 600)).toContain('Content-Type: application/pdf');
  });

  it('rejects unsupported base64 content types before decoding', async () => {
    const result = await createQuickbooksAttachable({
      file_name: 'archive.zip',
      base64_content: Buffer.from('PK...').toString('base64'),
    });
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/Unsupported content_type/);
  });

  it('rejects a file_url source whose only type hint is not QBO-supported', async () => {
    (mockLookup as any).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    (mockFetch as any).mockResolvedValue(
      new Response(new Uint8Array(Buffer.from('<html>')), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    );

    const result = await createQuickbooksAttachable({
      file_name: 'download',
      file_url: 'https://example.com/page',
    });

    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/Unsupported content_type/);
  });
});
