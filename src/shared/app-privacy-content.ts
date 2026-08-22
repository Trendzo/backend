import { env } from '@/config/env.js';
import type { PrivacyApp } from '@/db/schema/legal-pages.js';

/**
 * Built-in default privacy policies, ONE PER APP. These are the fallback the public
 * `/privacy/:app` page renders until an admin edits the policy in the CMS (which stores
 * an override row in `app_privacy_policies`). Each app collects different data, so the
 * three policies genuinely differ — that is what Google Play's per-app review expects.
 *
 * Content is authored as sections and rendered to sanitized-safe HTML by `sectionsToHtml`.
 * No user input flows in here; the admin-edited override is sanitized on write.
 */

type Section = { heading: string; paragraphs?: string[]; bullets?: string[] };

export type DefaultPolicy = {
  title: string;
  effectiveDate: string;
  sections: Section[];
};

const EFFECTIVE = '22 August 2026';

function esc(v: string): string {
  return v
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/** Render authored sections to the same HTML shape the public legal pages use. */
export function sectionsToHtml(sections: Section[]): string {
  return sections
    .map((s) => {
      const paras = (s.paragraphs ?? []).map((p) => `<p>${esc(p)}</p>`).join('');
      const bullets = s.bullets?.length
        ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
        : '';
      return `<h2>${esc(s.heading)}</h2>${paras}${bullets}`;
    })
    .join('');
}

const company = () => env.PUBLIC_COMPANY_NAME;
const supportEmail = () => env.PUBLIC_SUPPORT_EMAIL;

/** Shared closing sections (rights, security, retention, contact) reused by all three. */
function commonTail(subject: string): Section[] {
  return [
    {
      heading: 'How we protect your data',
      paragraphs: [
        `Data is encrypted in transit (HTTPS) and stored on access-controlled infrastructure. Uploaded media is served over a content-delivery network with the origin locked down. We limit staff access to what each role needs.`,
      ],
    },
    {
      heading: 'How long we keep it',
      paragraphs: [
        `We keep ${subject} for as long as your account is active. After deletion we anonymize or remove personal data, except records we must retain for tax, invoicing, accounting, fraud-prevention or other legal obligations, and only for as long as the law requires.`,
      ],
    },
    {
      heading: 'Your rights',
      bullets: [
        'Access, correct or export the personal data we hold about you.',
        'Delete your account from within the app (Profile → Delete account) or by contacting us.',
        'Withdraw optional permissions (such as location or camera) in your device settings.',
      ],
    },
    {
      heading: 'Children',
      paragraphs: [`The app is not directed at children under 18 and we do not knowingly collect their data.`],
    },
    {
      heading: 'Changes to this policy',
      paragraphs: [
        `We may update this policy as the app evolves. Material changes are reflected here with a new effective date; continued use after an update means you accept the revised policy.`,
      ],
    },
    {
      heading: 'Contact & grievances',
      paragraphs: [
        `For any privacy question, or to exercise a right above, email ${supportEmail()}. We acknowledge complaints within 24 hours and aim to resolve them within 15 days, in line with applicable Indian IT rules.`,
      ],
    },
  ];
}

const CUSTOMER: DefaultPolicy = {
  title: 'Privacy Policy — Shopping App',
  effectiveDate: EFFECTIVE,
  sections: [
    {
      heading: 'About this policy',
      paragraphs: [
        `This policy explains how ${company()} handles your data in the shopping app, where you browse and buy from local fashion retailers. It applies only to the shopping app; the retailer and delivery-partner apps have their own policies.`,
      ],
    },
    {
      heading: 'Information we collect',
      bullets: [
        'Account details: your name, phone number and email used to sign in via OTP.',
        'Orders and payments: items purchased, order history, and payment status (card/UPI details are handled by our payment gateway, not stored by us).',
        'Delivery address and approximate location, used to show nearby stores and to deliver orders.',
        'Photos you upload for virtual try-on, processed to generate the try-on image.',
        'Device and usage data: app version, device type and diagnostic logs.',
      ],
    },
    {
      heading: 'How we use it',
      bullets: [
        'To create your account, show nearby stores, and process and deliver your orders.',
        'To run virtual try-on on images you choose to upload.',
        'To provide support, prevent fraud, and improve the app.',
        'To send order and account notifications.',
      ],
    },
    {
      heading: 'Location data',
      paragraphs: [
        `With your permission we use your approximate or precise location to surface stores and products near you and to set your delivery address. You can deny or revoke this permission in your device settings; core browsing still works, but nearby results may be less accurate.`,
      ],
    },
    {
      heading: 'Sharing',
      bullets: [
        'With the retailer fulfilling your order and the delivery partner delivering it, limited to what they need.',
        'With our payment gateway to process payments.',
        'With service providers (hosting, media delivery, notifications) under contract.',
        'When required by law. We do not sell your personal data.',
      ],
    },
    ...commonTail('your account, order and usage data'),
  ],
};

const RETAILER: DefaultPolicy = {
  title: 'Privacy Policy — Retailer App',
  effectiveDate: EFFECTIVE,
  sections: [
    {
      heading: 'About this policy',
      paragraphs: [
        `This policy explains how ${company()} handles data in the retailer app, used by fashion store owners and staff to run their catalog, inventory, point of sale and payouts. It applies only to the retailer app.`,
      ],
    },
    {
      heading: 'Information we collect',
      bullets: [
        'Business and account details: store name, owner/staff name, phone, email and role.',
        'KYC and compliance documents you submit for verification (identity, business registration, GSTIN, bank details for payouts).',
        'Catalog and inventory data, product images, and point-of-sale transactions you record.',
        'Payout and settlement information tied to your store.',
        'Device and usage data: app version, device type and diagnostic logs.',
      ],
    },
    {
      heading: 'How we use it',
      bullets: [
        'To onboard and verify your store, and to enable listings, inventory, POS and orders.',
        'To calculate and disburse payouts and produce invoices and statements.',
        'To provide support, prevent fraud, and meet tax and regulatory obligations.',
      ],
    },
    {
      heading: 'Camera and media',
      paragraphs: [
        `With your permission the app uses the camera and photo library so you can capture product images and upload catalog media and KYC documents. You can revoke these permissions in device settings.`,
      ],
    },
    {
      heading: 'Sharing',
      bullets: [
        'With customers, limited to store and product information you publish.',
        'With payment and settlement providers to process payouts.',
        'With government and tax authorities as required (e.g. GST filings).',
        'With service providers under contract. We do not sell your personal data.',
      ],
    },
    ...commonTail('your business, KYC, catalog and transaction data'),
  ],
};

const DRIVER: DefaultPolicy = {
  title: 'Privacy Policy — Delivery Partner App',
  effectiveDate: EFFECTIVE,
  sections: [
    {
      heading: 'About this policy',
      paragraphs: [
        `This policy explains how ${company()} handles data in the delivery-partner app, used to accept, pick up and deliver orders. It applies only to the delivery-partner app.`,
      ],
    },
    {
      heading: 'Information we collect',
      bullets: [
        'Account details: your name, phone number and email used to sign in via OTP.',
        'Vehicle and document details: driving licence, registration certificate and insurance you upload for verification.',
        'Precise location while you are online, used to assign, navigate and confirm pickups and deliveries.',
        'Delivery activity: offers accepted, trips, proof-of-delivery photos and signatures.',
        'Earnings and cash-collection records, and device/diagnostic data.',
      ],
    },
    {
      heading: 'Location data (important)',
      paragraphs: [
        `While you are on duty, the app collects your precise location — including in the background during an active delivery — to match you with nearby orders, provide navigation, share live status with the customer and store, and confirm pickup and delivery. Location collection stops when you go offline. You can revoke the permission in device settings, but you will not be able to receive or complete deliveries without it.`,
      ],
    },
    {
      heading: 'How we use it',
      bullets: [
        'To verify you, assign deliveries, and enable navigation and proof of delivery.',
        'To calculate earnings and reconcile cash collected on delivery.',
        'To provide support, ensure safety, and prevent fraud.',
      ],
    },
    {
      heading: 'Sharing',
      bullets: [
        'With customers and stores, limited to your first name, live status and location during an active delivery.',
        'With payment providers to disburse earnings.',
        'When required by law. We do not sell your personal data.',
      ],
    },
    ...commonTail('your account, verification documents, location history and delivery data'),
  ],
};

const DEFAULTS: Record<PrivacyApp, DefaultPolicy> = {
  customer: CUSTOMER,
  retailer: RETAILER,
  driver: DRIVER,
};

export function defaultPolicy(app: PrivacyApp): DefaultPolicy {
  return DEFAULTS[app];
}

/** Default body as HTML (used to seed the admin editor and the public fallback). */
export function defaultPolicyHtml(app: PrivacyApp): string {
  return sectionsToHtml(DEFAULTS[app].sections);
}

export const PRIVACY_APP_LABELS: Record<PrivacyApp, string> = {
  customer: 'Shopping app',
  retailer: 'Retailer app',
  driver: 'Delivery partner app',
};
