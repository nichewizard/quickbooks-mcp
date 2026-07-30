import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { mockQuickbooksClient, mockQuickbooksClientClass } from '../../mocks/quickbooks.mock';

// ESM-compatible module mocking (handler pulls in the QBO client at import).
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { inferContentType, isBlockedIp, resolveLocalFile, fetchUrlToTempFile } = await import(
  '../../../src/helpers/attachable-file-source'
);
const { createQuickbooksAttachable } = await import(
  '../../../src/handlers/create-quickbooks-attachable.handler'
);

const MAX = 100 * 1024 * 1024;

describe('inferContentType', () => {
  it('maps known extensions to QBO MIME types', () => {
    expect(inferContentType('receipt.pdf')).toBe('application/pdf');
    expect(inferContentType('book.XLSX')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(inferContentType('photo.jpg')).toBe('image/jpg');
  });

  it('uses the first candidate with a known extension', () => {
    expect(inferContentType('noext', 'C:\\docs\\bill.pdf')).toBe('application/pdf');
    expect(inferContentType(undefined, 'https://x.example/f.png')).toBe('image/png');
  });

  it('returns null when nothing matches', () => {
    expect(inferContentType('archive.zip', 'noext')).toBeNull();
    expect(inferContentType()).toBeNull();
  });
});

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1', // v4-mapped loopback
  ])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::6810:84e5', '::ffff:8.8.8.8'])(
    'allows public %s',
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    }
  );

  it('treats unparseable addresses as blocked', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
    expect(isBlockedIp('::ffff:junk')).toBe(true);
    expect(isBlockedIp('::ffff:abcd')).toBe(true); // valid IPv6, non-IPv4 mapped suffix
  });

  it('blocks private v4 embedded in IPv4-compatible and NAT64 IPv6 forms', () => {
    expect(isBlockedIp('::127.0.0.1')).toBe(true); // dotted IPv4-compatible
    expect(isBlockedIp('::7f00:1')).toBe(true); // hex IPv4-compatible loopback
    expect(isBlockedIp('64:ff9b::7f00:1')).toBe(true); // NAT64 loopback, hex
    expect(isBlockedIp('64:ff9b::10.0.0.1')).toBe(true); // NAT64 private, dotted
    expect(isBlockedIp('::808:808')).toBe(false); // IPv4-compatible 8.8.8.8 — public
    expect(isBlockedIp('64:ff9b::808:808')).toBe(false); // NAT64 8.8.8.8 — public
    expect(isBlockedIp('::7f')).toBe(true); // single hex group -> 0.0.0.127 (0.0.0.0/8)
    expect(isBlockedIp('64:ff9b::')).toBe(false); // bare NAT64 prefix, no embedded v4
    expect(isBlockedIp('::2:3:4:5:6:7')).toBe(false); // too many groups to embed a v4
  });
});

describe('fetchUrlToTempFile URL validation', () => {
  it('rejects non-https URLs', async () => {
    await expect(fetchUrlToTempFile('http://example.com/f.pdf', MAX)).rejects.toThrow(/https/);
  });

  it('rejects invalid URLs', async () => {
    await expect(fetchUrlToTempFile('not a url', MAX)).rejects.toThrow(/not a valid URL/);
  });

  it('rejects literal loopback addresses', async () => {
    await expect(fetchUrlToTempFile('https://127.0.0.1/f.pdf', MAX)).rejects.toThrow(/blocked/);
  });

  it('rejects the cloud metadata address', async () => {
    await expect(fetchUrlToTempFile('https://169.254.169.254/latest/meta-data', MAX)).rejects.toThrow(
      /blocked/
    );
  });

  it('rejects literal private IPv6 addresses', async () => {
    await expect(fetchUrlToTempFile('https://[::1]/f.pdf', MAX)).rejects.toThrow(/blocked/);
  });
});

describe('resolveLocalFile', () => {
  let baseDir: string;
  let outsideDir: string;
  const savedEnv = process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR;

  beforeAll(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qbo-attach-base-'));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qbo-attach-out-'));
    process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR = baseDir;
    await fs.writeFile(path.join(baseDir, 'inside.pdf'), Buffer.alloc(1024, 1));
    await fs.writeFile(path.join(baseDir, 'empty.pdf'), Buffer.alloc(0));
    await fs.writeFile(path.join(outsideDir, 'outside.pdf'), Buffer.alloc(64, 1));
  });

  afterAll(async () => {
    if (savedEnv === undefined) delete process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR;
    else process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR = savedEnv;
    await fs.rm(baseDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it('accepts a file inside the base directory and returns its size', async () => {
    const resolved = await resolveLocalFile(path.join(baseDir, 'inside.pdf'), MAX);
    expect(resolved.size).toBe(1024);
  });

  it('accepts a native Windows-style path with spaces in nested folders', async () => {
    const nested = path.join(baseDir, 'Company Shared', 'Group Finance - Documents');
    await fs.mkdir(nested, { recursive: true });
    const target = path.join(nested, 'SIGNED Quote (Rev 2).pdf');
    await fs.writeFile(target, Buffer.alloc(2048, 3));
    // Pass the path exactly as an agent would: OS-native separators, spaces,
    // parentheses — no escaping or normalization by the caller.
    const resolved = await resolveLocalFile(target, MAX);
    expect(resolved.size).toBe(2048);
  });

  it('accepts a file in any directory of a multi-entry whitelist', async () => {
    process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR = `${baseDir};${outsideDir}`;
    try {
      const resolved = await resolveLocalFile(path.join(outsideDir, 'outside.pdf'), MAX);
      expect(resolved.size).toBe(64);
    } finally {
      process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR = baseDir;
    }
  });

  it('defaults to profile + temp directories when no whitelist is configured', async () => {
    delete process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR;
    try {
      // baseDir lives under os.tmpdir(), which the default whitelist includes.
      const resolved = await resolveLocalFile(path.join(baseDir, 'inside.pdf'), MAX);
      expect(resolved.size).toBe(1024);
    } finally {
      process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR = baseDir;
    }
  });

  it('skips whitelist entries that do not exist', async () => {
    process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR = `${path.join(baseDir, 'no-such-dir')};${baseDir}`;
    try {
      const resolved = await resolveLocalFile(path.join(baseDir, 'inside.pdf'), MAX);
      expect(resolved.size).toBe(1024);
    } finally {
      process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR = baseDir;
    }
  });

  it('rejects a file outside every allowed base directory', async () => {
    await expect(resolveLocalFile(path.join(outsideDir, 'outside.pdf'), MAX)).rejects.toThrow(
      /outside the allowed base directories/
    );
  });

  it('rejects path traversal that escapes the base directory', async () => {
    const sneaky = path.join(baseDir, '..', path.basename(outsideDir), 'outside.pdf');
    await expect(resolveLocalFile(sneaky, MAX)).rejects.toThrow(/outside the allowed base directories/);
  });

  it('rejects a missing file', async () => {
    await expect(resolveLocalFile(path.join(baseDir, 'nope.pdf'), MAX)).rejects.toThrow(
      /not found or not readable/
    );
  });

  it('rejects an empty file', async () => {
    await expect(resolveLocalFile(path.join(baseDir, 'empty.pdf'), MAX)).rejects.toThrow(/empty/);
  });

  it('rejects a directory', async () => {
    await expect(resolveLocalFile(baseDir, MAX)).rejects.toThrow(/not a regular file/);
  });

  it('rejects relative paths', async () => {
    await expect(resolveLocalFile('inside.pdf', MAX)).rejects.toThrow(/must be an absolute path/);
  });

  it('denies dotfiles and files inside dot-directories', async () => {
    await fs.writeFile(path.join(baseDir, '.env'), Buffer.from('SECRET=1'));
    await fs.mkdir(path.join(baseDir, '.ssh'), { recursive: true });
    await fs.writeFile(path.join(baseDir, '.ssh', 'id_rsa'), Buffer.from('key'));
    await expect(resolveLocalFile(path.join(baseDir, '.env'), MAX)).rejects.toThrow(/dotfiles/);
    await expect(resolveLocalFile(path.join(baseDir, '.ssh', 'id_rsa'), MAX)).rejects.toThrow(
      /dotfiles/
    );
  });

  it('denies credential files by name', async () => {
    await fs.writeFile(path.join(baseDir, 'prod.env'), Buffer.from('SECRET=1'));
    await fs.writeFile(path.join(baseDir, 'tokens.json'), Buffer.from('{}'));
    await expect(resolveLocalFile(path.join(baseDir, 'prod.env'), MAX)).rejects.toThrow(
      /credential files/
    );
    await expect(resolveLocalFile(path.join(baseDir, 'tokens.json'), MAX)).rejects.toThrow(
      /credential files/
    );
  });

  it("denies files inside the MCP server's own directory", async () => {
    const repoRoot = path.resolve(process.cwd());
    process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR = repoRoot;
    try {
      await expect(resolveLocalFile(path.join(repoRoot, 'package.json'), MAX)).rejects.toThrow(
        /server's own directory/
      );
    } finally {
      process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR = baseDir;
    }
  });

  it('rejects a file larger than the cap', async () => {
    await expect(resolveLocalFile(path.join(baseDir, 'inside.pdf'), 512)).rejects.toThrow(
      /File too large/
    );
  });
});

describe('createQuickbooksAttachable source precedence', () => {
  it('errors when both file_url and file_path are provided', async () => {
    const result = await createQuickbooksAttachable({
      file_name: 'x.pdf',
      file_url: 'https://example.com/x.pdf',
      file_path: 'C:\\somewhere\\x.pdf',
    });
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/not both/);
  });

  it('surfaces file_path validation failures as tool errors', async () => {
    const result = await createQuickbooksAttachable({
      file_name: 'x.pdf',
      file_path: path.join(os.tmpdir(), 'qbo-definitely-missing-file.pdf'),
      base64_content: Buffer.from('ignored').toString('base64'),
    });
    // file_path takes precedence over base64_content, so its failure must
    // surface instead of silently falling back to the base64 bytes.
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/file_path|allowed base directory|not found/);
  });
});
