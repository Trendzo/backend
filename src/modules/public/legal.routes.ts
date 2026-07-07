import type { FastifyPluginAsync } from 'fastify';
import { env } from '@/config/env.js';

const updated = '7 July 2026';

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

  app.get('/privacy', (_req, reply) => {
    void reply.type('text/html; charset=utf-8').send(
      layout(
        'Privacy Policy',
        `
      <h1>Privacy Policy</h1><p class="meta">Effective and last updated: ${updated}</p>
      <p>This policy explains how ${escapeHtml(env.PUBLIC_COMPANY_NAME)} processes information when retailers use ${escapeHtml(env.PUBLIC_APP_NAME)}.</p>
      <h2>Information we collect</h2><ul>
        <li>Account and contact details, including name, email address, phone number and user identifier.</li>
        <li>Business onboarding and compliance details, including store address, GSTIN, PAN, bank and KYC information.</li>
        <li>Garment, model and storefront photos, generated images, catalog content, support messages and other content you submit.</li>
        <li>Approximate or precise store location coordinates, device identifiers needed for notifications, and basic security/diagnostic records.</li>
        <li>Orders, invoices, inventory, POS, settlement and payout records created through the service.</li>
      </ul>
      <h2>How we use information</h2><p>We use it to authenticate users, review retailer applications, provide AI catalog generation, publish and manage catalogs, operate inventory and POS features, send service messages, provide support, prevent abuse, comply with tax and legal duties, and maintain service security.</p>
      <h2>Service providers</h2><p>Information is shared only as needed with hosting and database providers, cloud media storage, OTP delivery/verification providers, AI image-generation providers, and authorities where legally required. We do not sell personal information and do not use it for cross-app tracking.</p>
      <h2>Retention</h2><p>Account profile data is kept while the account is active. After deletion, credentials and personal profile data are revoked or anonymized and uploaded media is removed from active access. GST, invoice, order, payout, accounting, fraud-prevention and audit records may be retained for the period required by Indian tax and other applicable laws.</p>
      <h2>Security and international processing</h2><p>We use access controls, encrypted HTTPS transport and restricted service credentials. Providers may process data in other countries subject to contractual and legal safeguards. No system can guarantee absolute security.</p>
      <h2>Your choices</h2><p>You may access and export available account data in the app, request corrections, or delete your account from Profile → Delete account. You may also use the <a href="/account-deletion">account deletion instructions</a>.</p>
      <h2>Children</h2><p>This business service is not directed to children under 18.</p>
      <h2>Changes</h2><p>We may update this policy and will publish the revised effective date here.</p>
      ${contactBlock()}`,
      ),
    );
  });

  app.get('/terms', (_req, reply) => {
    void reply.type('text/html; charset=utf-8').send(
      layout(
        'Terms of Service',
        `
      <h1>Terms of Service</h1><p class="meta">Effective and last updated: ${updated}</p>
      <p>These terms govern retailer use of ${escapeHtml(env.PUBLIC_APP_NAME)}. By creating an account or using the service, you agree to them.</p>
      <h2>Eligibility and accounts</h2><p>You must be at least 18, be authorized to act for the retailer, provide accurate information, protect account credentials, and maintain required business and tax registrations.</p>
      <h2>Permitted use</h2><p>You may use the service for lawful retail catalog, inventory and point-of-sale operations. You must have the rights and permissions needed for every garment, person, logo, trademark, photo and other item you upload.</p>
      <h2>AI-generated content</h2><p>AI output may be inaccurate or unsuitable. You are responsible for reviewing output before publication and for ensuring product listings accurately represent the goods offered.</p>
      <h2>Prohibited use</h2><p>Do not upload unlawful, infringing, deceptive, abusive or non-consensual content; attempt unauthorized access; interfere with the service; or use generated material to mislead customers.</p>
      <h2>Retail operations</h2><p>You remain responsible for product quality, pricing, inventory accuracy, receipts, taxes, refunds, customer obligations and compliance with applicable laws.</p>
      <h2>Suspension and termination</h2><p>We may restrict or terminate access for abuse, security risk, legal non-compliance or material breach. You may delete your account in the app. Legally required transaction and tax records may be retained.</p>
      <h2>Availability and liability</h2><p>The service is provided on an “as available” basis. To the extent permitted by law, we are not liable for indirect or consequential loss, and total liability will not exceed amounts paid for the service during the preceding six months.</p>
      <h2>Changes and governing law</h2><p>We may update these terms with notice through the service or this page. Indian law applies, subject to mandatory consumer and commercial protections.</p>
      ${contactBlock()}`,
      ),
    );
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
