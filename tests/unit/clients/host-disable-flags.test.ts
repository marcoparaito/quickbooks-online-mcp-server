/**
 * Regression test for the host-injected tool-gating flags.
 *
 * The client module loads the token store with dotenv.config({ override: true })
 * at import time — BEFORE main() registers any tools. Without protection, a
 * .env shipped next to the module (e.g. QUICKBOOKS_DISABLE_WRITE=false) would
 * silently clobber the host's env block, so a host that spawned the server as
 * read-only (QUICKBOOKS_DISABLE_WRITE=true) would still get all create_* tools
 * registered. This file proves the host flags survive the dotenv override pass.
 *
 * dotenv must genuinely parse a token-store file for the test to mean anything,
 * so fs is left unmocked and the store is a real temp file. Only the modules
 * with heavyweight constructors/side effects are mocked, following the pattern
 * of token-store-path.test.ts.
 */
import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';

// A real .env the module-level dotenv.config() will read: it tries to turn all
// write/update tools back ON and delete tools OFF.
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-host-flags-'));
const STORE_PATH = path.join(storeDir, '.env');
fs.writeFileSync(
  STORE_PATH,
  [
    'QUICKBOOKS_CLIENT_ID=env-file-client-id',
    'QUICKBOOKS_CLIENT_SECRET=env-file-client-secret',
    'QUICKBOOKS_REFRESH_TOKEN=env-file-refresh-token',
    'QUICKBOOKS_REALM_ID=12345',
    'QUICKBOOKS_DISABLE_WRITE=false',
    'QUICKBOOKS_DISABLE_UPDATE=false',
    'QUICKBOOKS_DISABLE_DELETE=true',
    '',
  ].join('\n'),
);

// Host-injected env (what an MCP host config's env block produces):
// the host believes this server is write-disabled.
process.env.QUICKBOOKS_TOKEN_STORE_PATH = STORE_PATH;
process.env.QUICKBOOKS_DISABLE_WRITE = 'true';
delete process.env.QUICKBOOKS_DISABLE_UPDATE; // host silent → .env may apply
process.env.QUICKBOOKS_DISABLE_DELETE = ''; // empty placeholder → .env may apply

jest.unstable_mockModule('intuit-oauth', () => {
  class MockOAuthClient {
    static scopes = { Accounting: 'com.intuit.quickbooks.accounting' };
    refreshUsingToken = jest.fn();
    createToken = jest.fn();
    authorizeUri = jest.fn(() => 'https://mock');
    constructor(_cfg: Record<string, unknown>) {}
  }
  return { default: MockOAuthClient };
});
jest.unstable_mockModule('node-quickbooks', () => ({
  default: class MockQuickBooks { constructor(..._args: unknown[]) {} },
}));
jest.unstable_mockModule('open', () => ({ default: jest.fn(async () => undefined) }));

// Importing the client runs dotenv.config({ override: true }) at module scope —
// the exact moment the defect fired.
await import('../../../src/clients/quickbooks-client');
const { isToolDisabled, RegisterTool } = await import('../../../src/helpers/register-tool');

afterAll(() => {
  delete process.env.QUICKBOOKS_TOKEN_STORE_PATH;
  delete process.env.QUICKBOOKS_DISABLE_WRITE;
  delete process.env.QUICKBOOKS_DISABLE_UPDATE;
  delete process.env.QUICKBOOKS_DISABLE_DELETE;
  fs.rmSync(storeDir, { recursive: true, force: true });
});

describe('host-injected DISABLE flags vs .env override', () => {
  it('keeps the host-set QUICKBOOKS_DISABLE_WRITE=true despite .env saying false', () => {
    expect(process.env.QUICKBOOKS_DISABLE_WRITE).toBe('true');
  });

  it('still lets the .env supply flags the host did not set (sanity: dotenv did run)', () => {
    // Proves the override pass actually loaded THIS file — i.e. the WRITE flag
    // above survived a real clobber attempt, not a dotenv that never ran.
    expect(process.env.QUICKBOOKS_CLIENT_ID).toBe('env-file-client-id');
    expect(process.env.QUICKBOOKS_DISABLE_UPDATE).toBe('false');
  });

  it('treats an empty-string host placeholder as unset (token store wins)', () => {
    expect(process.env.QUICKBOOKS_DISABLE_DELETE).toBe('true');
  });

  it('suppresses create_* tool registration under the host flag', () => {
    expect(isToolDisabled('create_invoice')).toBe(true);

    const tool = jest.fn();
    const server = { tool } as any;
    const definition = {
      name: 'create_invoice',
      description: 'test',
      schema: z.object({}),
      handler: jest.fn(),
    } as any;
    RegisterTool(server, definition);
    expect(tool).not.toHaveBeenCalled();

    // Read and (per .env) update tools still register — the gate is
    // per-category, not a blanket kill switch.
    RegisterTool(server, { ...definition, name: 'get_invoice' });
    RegisterTool(server, { ...definition, name: 'update_invoice' });
    expect(tool).toHaveBeenCalledTimes(2);
  });
});
