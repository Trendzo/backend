/**
 * GET /retailer/billing-statements/:id/pdf — GET /billing-statements lists PAYOUT ids while the
 * PDFs live on monthly billing_statements rows; the pdf route must work for both kinds of id.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, pool } from '@/db/client.js';
import { bankAccounts, billingStatements, payouts } from '@/db/schema/index.js';
import { buildApp } from '@/app.js';
import { newId } from '@/shared/ids.js';
import {
  bearer,
  makeAccount,
  makeStore,
  tokenWithoutSubRole,
} from './helpers/retailer-fixtures.js';

type App = ReturnType<typeof buildApp>;
const data = (res: { body: string }) => JSON.parse(res.body).data;
const err = (res: { body: string }) => JSON.parse(res.body).error;

let app: App;
let storeId: string;
let bankId: string;
let ownerId: string;
let ownerToken: string;
let staffToken: string;

const pdf = (id: string, token = ownerToken) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/retailer/billing-statements/${id}/pdf`,
    headers: bearer(token),
  });

async function makePayout(
  forStore: string,
  bank: string,
  cycleStart: string,
  cycleEnd: string,
  statementUrl: string | null = null,
): Promise<string> {
  const id = newId('pyo');
  await db.insert(payouts).values({
    id,
    storeId: forStore,
    cycleStart: new Date(cycleStart),
    cycleEnd: new Date(cycleEnd),
    grossPaise: 100_000n,
    commissionPaise: 10_000n,
    netPaise: 90_000n,
    bankAccountId: bank,
    status: 'pending',
    statementUrl,
  });
  return id;
}

async function makeStatement(forStore: string, period: string, pdfUrl: string | null): Promise<string> {
  const id = newId('bst');
  await db.insert(billingStatements).values({
    id,
    storeId: forStore,
    legalEntityId: `LE_${forStore}`,
    period,
    pdfUrl,
    status: 'closed',
  });
  return id;
}

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  storeId = await makeStore();
  const owner = await makeAccount(storeId, 'owner');
  ownerId = owner.id;
  ownerToken = owner.token;
  staffToken = (await makeAccount(storeId, 'staff')).token; // staff lack payouts.view
  bankId = newId('bnk');
  await db.insert(bankAccounts).values({
    id: bankId,
    storeId,
    accountNumber: '1234567890',
    ifsc: 'HDFC0000001',
    legalName: 'Fixture Store',
    isDefault: true,
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('GET /retailer/billing-statements/:id/pdf', () => {
  it('401 anonymous; 403 without payouts.view (floor staff)', async () => {
    const id = await makeStatement(storeId, '2026-01', 'https://files.test/stmt-2026-01.pdf');
    expect((await app.inject({ method: 'GET', url: `/api/v1/retailer/billing-statements/${id}/pdf` })).statusCode).toBe(401);
    expect((await pdf(id, staffToken)).statusCode).toBe(403);
    expect((await pdf(id, tokenWithoutSubRole(ownerId))).statusCode).toBe(403);
  });

  it('keeps working for a billing_statements id (unchanged contract)', async () => {
    const id = await makeStatement(storeId, '2026-02', 'https://files.test/stmt-2026-02.pdf');
    const res = await pdf(id);
    expect(res.statusCode).toBe(200);
    expect(data(res)).toEqual({
      statementId: id,
      period: '2026-02',
      pdfUrl: 'https://files.test/stmt-2026-02.pdf',
    });
  });

  it('409 for a billing_statements row whose PDF is not rendered yet', async () => {
    const id = await makeStatement(storeId, '2026-03', null);
    const res = await pdf(id);
    expect(res.statusCode).toBe(409);
    expect(err(res).code).toBe('invalid_state');
  });

  it('resolves a PAYOUT id (what GET /billing-statements lists) to the monthly statement of the month its cycle ended in', async () => {
    const stmtId = await makeStatement(storeId, '2026-04', 'https://files.test/stmt-2026-04.pdf');
    const payoutId = await makePayout(storeId, bankId, '2026-04-10T00:00:00Z', '2026-04-24T00:00:00Z');

    // the id the list endpoint hands out is the payout id
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/retailer/billing-statements',
      headers: bearer(ownerToken),
    });
    expect((data(list) as Array<{ id: string }>).map((r) => r.id)).toContain(payoutId);

    const res = await pdf(payoutId);
    expect(res.statusCode).toBe(200);
    expect(data(res)).toEqual({
      statementId: stmtId,
      payoutId,
      period: '2026-04',
      pdfUrl: 'https://files.test/stmt-2026-04.pdf',
    });
  });

  it('a payout cycle straddling two months belongs to the month it ENDED in (UTC, like the monthly close)', async () => {
    await makeStatement(storeId, '2026-05', 'https://files.test/stmt-2026-05.pdf');
    const juneId = await makeStatement(storeId, '2026-06', 'https://files.test/stmt-2026-06.pdf');
    const payoutId = await makePayout(storeId, bankId, '2026-05-25T00:00:00Z', '2026-06-08T00:00:00Z');
    const res = await pdf(payoutId);
    expect(res.statusCode).toBe(200);
    expect(data(res)).toMatchObject({ statementId: juneId, period: '2026-06', payoutId });
  });

  it('prefers the payout\'s own statementUrl when it has one', async () => {
    const payoutId = await makePayout(
      storeId,
      bankId,
      '2026-07-01T00:00:00Z',
      '2026-07-15T00:00:00Z',
      'https://files.test/payout-own.pdf',
    );
    const res = await pdf(payoutId);
    expect(res.statusCode).toBe(200);
    expect(data(res)).toMatchObject({
      statementId: payoutId,
      payoutId,
      pdfUrl: 'https://files.test/payout-own.pdf',
    });
  });

  it('409 for a payout with no rendered statement yet (no url, no monthly pdf)', async () => {
    const payoutId = await makePayout(storeId, bankId, '2026-08-01T00:00:00Z', '2026-08-15T00:00:00Z');
    expect((await pdf(payoutId)).statusCode).toBe(409);
    // an unrendered monthly row for that month still counts as "not yet"
    await makeStatement(storeId, '2026-08', null);
    expect((await pdf(payoutId)).statusCode).toBe(409);
  });

  it('404 for an unknown id and for another store\'s statement / payout', async () => {
    expect((await pdf('bst_missing')).statusCode).toBe(404);

    const otherStore = await makeStore();
    const otherBank = newId('bnk');
    await db.insert(bankAccounts).values({
      id: otherBank,
      storeId: otherStore,
      accountNumber: '9999999999',
      ifsc: 'HDFC0000001',
      legalName: 'Other',
      isDefault: true,
    });
    const foreignStatement = await makeStatement(otherStore, '2026-09', 'https://files.test/foreign.pdf');
    const foreignPayout = await makePayout(
      otherStore,
      otherBank,
      '2026-09-01T00:00:00Z',
      '2026-09-15T00:00:00Z',
      'https://files.test/foreign-payout.pdf',
    );
    expect((await pdf(foreignStatement)).statusCode).toBe(404);
    expect((await pdf(foreignPayout)).statusCode).toBe(404);
  });
});
