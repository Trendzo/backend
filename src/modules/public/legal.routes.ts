import type { FastifyPluginAsync } from 'fastify';
import { env } from '@/config/env.js';
import { db } from '@/db/client.js';
import { currentLegalDoc, LEGAL_DOC_LABELS, type LegalDocKind } from '@/shared/terms.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function layout(title: string, content: string): string {
  const app = escapeHtml(env.PUBLIC_APP_NAME);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ${app}</title>
<style>
:root{color-scheme:light;--ink:#181a18;--muted:#626760;--paper:#f7f4ec;--card:#fff;--line:#dedbd2;--accent:#d9f570}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header,main,footer{max-width:820px;margin:auto;padding:24px}header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}
.brand{font-weight:800;font-size:19px}nav a{margin-left:14px}main{padding-top:48px;padding-bottom:56px}h1{font-size:clamp(34px,7vw,58px);line-height:1.05;margin:0 0 12px}h2{font-size:22px;margin-top:34px}h3{font-size:17px;margin-top:24px}p,li{color:var(--muted)}a{color:var(--ink);font-weight:650}.meta{font-size:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px;margin:22px 0}.button{display:inline-block;background:var(--accent);padding:11px 17px;border-radius:999px;text-decoration:none}footer{border-top:1px solid var(--line);font-size:14px;color:var(--muted)}
@media(max-width:620px){header{display:block}.brand{display:block;margin-bottom:10px}nav a{margin:0 12px 0 0}main{padding-top:36px}}
</style></head><body><header><span class="brand">${app}</span><nav><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a></nav></header><main>${content}</main><footer>© 2026 ${escapeHtml(env.PUBLIC_COMPANY_NAME)} · <a href="/account-deletion">Account deletion</a></footer></body></html>`;
}

/**
 * Render the CURRENT admin-published document (same source the in-app gates show)
 * as the public page body. Plain text → paragraphs; numbered lines keep their breaks.
 */
async function legalDocContent(kind: LegalDocKind): Promise<string> {
  const doc = await currentLegalDoc(db, kind);
  const paragraphs = doc.shortText
    .split(/\r?\n\r?\n/)
    .map((block) => `<p>${escapeHtml(block).replaceAll(/\r?\n/g, '<br>')}</p>`)
    .join('');
  return `
      <h1>${escapeHtml(LEGAL_DOC_LABELS[kind])}</h1>
      <p class="meta">Version: ${escapeHtml(doc.label)}</p>
      <div class="card">${paragraphs}</div>
      ${contactBlock()}`;
}

function contactBlock(): string {
  const email = escapeHtml(env.PUBLIC_SUPPORT_EMAIL);
  const phone = env.PUBLIC_SUPPORT_PHONE
    ? `<li>Phone: ${escapeHtml(env.PUBLIC_SUPPORT_PHONE)}</li>`
    : '';
  const address = env.PUBLIC_BUSINESS_ADDRESS
    ? `<li>Address: ${escapeHtml(env.PUBLIC_BUSINESS_ADDRESS)}</li>`
    : '';
  return `<div class="card"><h2>Contact</h2><ul><li>Email: <a href="mailto:${email}">${email}</a></li>${phone}${address}</ul><p>We normally respond within two business days.</p></div>`;
}

const publicLegalRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', (_req, reply) => {
    void reply
      .type('text/html; charset=utf-8')
      .send(
        layout(
          env.PUBLIC_APP_NAME,
          `<h1>Retail catalog creation, made practical.</h1><p>${escapeHtml(env.PUBLIC_APP_NAME)} helps approved fashion retailers photograph garments, create AI-assisted catalog mockups, manage products and inventory, and operate point-of-sale workflows.</p><p><a class="button" href="/support">Get support</a></p>`,
        ),
      );
  });

  // Both legal pages render the CURRENT admin-published document (retailer_terms
  // table via currentLegalDoc) — publishing from /admin/terms updates these too.
  app.get('/privacy', async (_req, reply) => {
    void reply
      .type('text/html; charset=utf-8')
      .send(layout('Privacy Policy', await legalDocContent('privacy')));
  });

  app.get('/terms', async (_req, reply) => {
    void reply
      .type('text/html; charset=utf-8')
      .send(layout('Terms of Service', await legalDocContent('terms')));
  });

  app.get('/support', (_req, reply) => {
    const email = escapeHtml(env.PUBLIC_SUPPORT_EMAIL);
    void reply
      .type('text/html; charset=utf-8')
      .send(
        layout(
          'Support',
          `<h1>Support</h1><p>Get help with sign-in, retailer review, KYC, catalog generation, inventory, POS, exports, privacy, or account deletion.</p><div class="card"><h2>Email support</h2><p><a class="button" href="mailto:${email}?subject=Trendzo%20Mockup%20Support">${email}</a></p><p>Include your account email or phone, a short description, and screenshots where useful. Never send passwords or OTPs.</p></div><h2>Self-service</h2><ul><li><a href="/privacy">Privacy Policy</a></li><li><a href="/terms">Terms of Service</a></li><li><a href="/account-deletion">Delete an account</a></li></ul>`,
        ),
      );
  });

  app.get('/account-deletion', (_req, reply) => {
    void reply
      .type('text/html; charset=utf-8')
      .send(
        layout(
          'Account deletion',
          `<h1>Delete your account</h1><p>You can initiate deletion without contacting support.</p><div class="card"><h2>In the iOS app</h2><ol><li>Sign in.</li><li>Open <strong>Profile</strong>.</li><li>Tap <strong>Delete account</strong>.</li><li>Review the retention notice and confirm deletion.</li></ol></div><h2>What happens</h2><p>Access is revoked immediately. Personal account details are anonymized and catalog/media content is removed from active access. Records required for GST, invoices, orders, payouts, accounting, fraud prevention or legal compliance are retained only as required.</p><h2>Cannot access the app?</h2><p>Email <a href="mailto:${escapeHtml(env.PUBLIC_SUPPORT_EMAIL)}?subject=Account%20deletion%20request">${escapeHtml(env.PUBLIC_SUPPORT_EMAIL)}</a> from the address associated with the account. We may verify ownership before acting.</p>`,
        ),
      );
  });
};

export default publicLegalRoutes;
