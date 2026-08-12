import { env } from '@/config/env.js';

/**
 * The single Privacy Policy covering ALL Trendzo apps (shopping, retailer, delivery
 * partner) and the web portal. This is the authoritative full text served at the
 * public /privacy URL — the one submitted to the app stores.
 *
 * It is deliberately NOT read from `retailer_terms`: that table holds the SHORT
 * acceptance digest shown in-app at the retailer legal gate, which is a summary and
 * is not a valid store-listing privacy policy on its own. Store reviewers must land
 * on a complete, dated, non-draft document — see shared/terms.ts for the digest.
 *
 * Bump PRIVACY_POLICY_EFFECTIVE whenever the substance changes.
 */
export const PRIVACY_POLICY_EFFECTIVE = '12 August 2026';

export type PolicySection = {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
};

export function privacyPolicySections(): PolicySection[] {
  const brand = env.PUBLIC_COMPANY_NAME;
  const email = env.PUBLIC_SUPPORT_EMAIL;

  return [
    {
      heading: 'About this policy',
      paragraphs: [
        `This Privacy Policy explains what personal information ${brand} collects, why we collect it, who we share it with, and the choices you have. It applies to every ${brand} product:`,
      ],
      bullets: [
        `the ${brand} shopping app, used by customers to browse and buy from partner fashion stores;`,
        `the ${brand} retailer app, used by approved retailers to run their store, catalog, inventory and point of sale;`,
        `${brand} Partner, used by delivery partners to pick up, deliver and return orders;`,
        `our websites and web portal at the addresses we publish.`,
      ],
    },
    {
      heading: 'Information you give us',
      paragraphs: [
        'What we ask for depends on which app you use and what you do in it.',
      ],
      bullets: [
        'All users: your name, mobile number, and where you provide it, your email address. We sign you in with a one-time password sent to your mobile number.',
        'Customers: delivery addresses, contact details for a delivery, and the contents of your cart and orders.',
        'Retailers: store name and address, business and tax details including GSTIN and PAN, bank account details for payouts, and the identity and compliance documents required to verify a store.',
        'Delivery partners: vehicle type and registration number, driving licence details, vehicle registration certificate, insurance details, and identity documents required to onboard you. Identity numbers are stored in masked form where we are able to do so.',
        'Content you upload: product photographs, catalog images, video, delivery proof photographs, and any text you submit such as descriptions, notes or support messages.',
      ],
    },
    {
      heading: 'Information created when you use Trendzo',
      bullets: [
        'Orders, invoices, returns, exchanges, point-of-sale sales, settlements and payout records.',
        'Delivery records: pickup and drop events, delivery confirmation codes, proof-of-delivery photographs, and cash-on-delivery amounts collected and deposited.',
        'Location. The Partner app collects the delivery partner’s precise device location while the app is in use, to offer nearby orders and to show pickup and drop points. We do not collect location in the background when the app is closed. The retailer app records a store’s location as part of store setup.',
        'Support and safety records: messages you send us, reports you raise, and records we keep to investigate disputes, fraud or misuse.',
      ],
    },
    {
      heading: 'Information from your device',
      bullets: [
        'A push notification token, so we can send you order and service notifications.',
        'Device and app information such as app version, device model and operating system version, used to keep the app working and to diagnose faults.',
        'Basic log information such as the time of a request and the app it came from.',
      ],
    },
    {
      heading: 'Device permissions we ask for',
      paragraphs: [
        'We ask for a permission only when a feature needs it. You can refuse or withdraw any permission in your device settings, though the related feature will then not work.',
      ],
      bullets: [
        'Location — to offer delivery partners nearby orders and guide them to pickups and drops, and to set a retailer’s store location. Used while the app is in use.',
        'Camera — to photograph products for a catalog, to capture proof of delivery, and to upload identity or compliance documents.',
        'Photos and media — to let you upload images you have already taken.',
        'Phone — to let you place a call to a customer, a store, or our support desk from inside the app. We do not read your call logs or contacts.',
        'Notifications — to alert you to new orders, deliveries and account or service messages.',
      ],
    },
    {
      heading: 'How we use your information',
      bullets: [
        'To create and manage your account and to sign you in.',
        'To operate the service: to list products, take and fulfil orders, arrange pickups and deliveries, process returns and exchanges, and run retailer point-of-sale and inventory.',
        'To process payments, generate invoices, calculate commissions and make payouts.',
        'To verify retailers and delivery partners, including checking the documents they submit, as required to operate a marketplace lawfully.',
        'To communicate with you about your account, orders and deliveries, and to answer your support requests.',
        'To keep the service safe: to detect and prevent fraud, misuse and abuse, to investigate disputes, and to enforce our terms.',
        'To fix problems and improve the apps, using diagnostic and usage information.',
        'To meet our legal obligations, including tax, invoicing and record-keeping duties under Indian law.',
      ],
    },
    {
      heading: 'Who we share information with',
      paragraphs: ['We do not sell your personal information. We share it only as set out below.'],
      bullets: [
        'Service providers who operate parts of the platform for us, under contract and only for that purpose: cloud hosting, media and file storage, SMS and one-time password delivery, push notification delivery, maps, and payment processing.',
        'Between users, only as far as an order requires it. A retailer receives the delivery details needed to fulfil an order. A delivery partner receives the pickup and drop details and the contact number needed to complete the delivery. A customer sees the assigned delivery partner’s name and vehicle. Everyone receiving this information may use it only to complete that order.',
        'Authorities, regulators, or other parties where we are required to by law, or where it is necessary to establish, exercise or defend a legal claim, or to protect the safety of any person.',
        'A successor entity, if we reorganise, merge or sell part of our business. We will tell you before your information becomes subject to a different privacy policy.',
      ],
    },
    {
      heading: 'Payments',
      paragraphs: [
        'Online payments are handled by a licensed payment processor. Card numbers, UPI credentials, net-banking credentials and similar payment secrets are entered with that processor and are not stored by us. We keep a record of the payment status, amount and reference so we can service your order, invoice it and handle refunds.',
        'Where an order is paid by cash on delivery, we record the amount due, the amount collected by the delivery partner, and the partner’s subsequent cash deposit.',
      ],
    },
    {
      heading: 'How long we keep information',
      bullets: [
        'Account and profile information is kept while your account is open.',
        'When an account is closed or deleted, we revoke access and anonymise or delete the personal details associated with it.',
        'Transaction records — orders, invoices, tax records, payouts, settlements and related audit trails — are kept for the period Indian tax and company law requires, even after an account is closed. These records may include your name and contact details because the law requires an invoice to carry them.',
        'Records needed to resolve an open dispute, investigate fraud, or comply with a legal request are kept until that matter is resolved.',
      ],
    },
    {
      heading: 'Deleting your account',
      paragraphs: [
        'You can ask us to delete your account at any time, from inside the app or from the web. Full instructions are on our account deletion page, linked at the foot of this page.',
        `If you cannot reach the app, email ${email} from the address or with the mobile number registered on the account. We may need to verify that the account is yours before we act.`,
        'When we delete an account we revoke access immediately and anonymise or remove personal details. Records we are legally required to retain, as described above, are kept for the required period and no longer.',
      ],
    },
    {
      heading: 'How we protect information',
      paragraphs: [
        'All traffic between the apps and our servers is encrypted in transit. Access to production data is restricted to the people who need it, credentials are held in a managed secret store, and administrative actions are logged. No method of transmission or storage is completely secure, and we cannot guarantee absolute security.',
      ],
    },
    {
      heading: 'Your rights and choices',
      bullets: [
        'You can access and correct most of your information directly in the app.',
        'You can ask us for a copy of the personal information we hold about you.',
        'You can ask us to correct information that is wrong or incomplete.',
        'You can ask us to delete your account and the personal information associated with it, subject to the retention rules above.',
        'You can withdraw a device permission at any time in your device settings.',
        'You can turn off notifications in your device settings. We will still contact you about essential account, order and security matters.',
      ],
      paragraphs: [`To exercise any of these, contact us at ${email}.`],
    },
    {
      heading: 'Children',
      paragraphs: [
        `${brand} is not directed at children and is not intended for anyone under 18. Retailer and delivery partner accounts are available only to adults. We do not knowingly collect personal information from children. If you believe a child has given us personal information, contact us and we will delete it.`,
      ],
    },
    {
      heading: 'Where your information is stored',
      paragraphs: [
        'Your information is stored and processed on servers operated by our cloud and storage providers. Some of these providers operate infrastructure outside India. Where information is transferred outside India, we require the provider to protect it under contract and to process it only on our instructions.',
      ],
    },
    {
      heading: 'Changes to this policy',
      paragraphs: [
        'We update this policy when our practices change. The effective date at the top of this page tells you when the current version took effect. If a change materially affects you, we will give notice in the app or by message before it takes effect.',
      ],
    },
  ];
}
