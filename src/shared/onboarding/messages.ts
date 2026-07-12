/**
 * Single canonical wire shape for an onboarding clarification message, used by EVERY
 * endpoint that returns them (admin getApplication, public getPublicMessages, authed
 * getOwnApplicationMessages) so the app + dashboard render one consistent shape.
 *
 * Historically each endpoint returned a different shape (raw rows vs ad-hoc maps),
 * which broke author attribution and attachment/timestamp rendering.
 */
export type ApplicationMessageRow = {
  id: string;
  applicationId: string;
  authorKind: string; // 'admin' | 'applicant'
  body: string;
  attachmentUrls: string[] | null;
  fieldKey: string | null;
  at: Date;
};

export type SerializedApplicationMessage = {
  id: string;
  applicationId: string;
  /** 'admin' | 'applicant' — the client renders 'applicant' as "You" in the retailer view. */
  authorKind: 'admin' | 'applicant';
  authorLabel: string;
  body: string;
  attachments: string[];
  fieldKey: string | null;
  createdAt: string;
};

export function serializeApplicationMessage(m: ApplicationMessageRow): SerializedApplicationMessage {
  const authorKind = m.authorKind === 'admin' ? 'admin' : 'applicant';
  return {
    id: m.id,
    applicationId: m.applicationId,
    authorKind,
    authorLabel: authorKind === 'admin' ? 'ClosetX admin' : 'Applicant',
    body: m.body,
    attachments: m.attachmentUrls ?? [],
    fieldKey: m.fieldKey ?? null,
    createdAt: m.at.toISOString(),
  };
}
