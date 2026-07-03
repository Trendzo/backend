# ClosetX — Retailer Signup / Onboarding / Login — API Contract

Covers the full retailer identity lifecycle: signup, login, the application/onboarding flow, admin approval, store setup, and the KYC/compliance surface. All paths are under `/api/v1`. Base URL: `http://localhost:3099/api/v1` (local) or `https://backend-qpmx.onrender.com/api/v1`.

Envelope: success `{ "success": true, "data": ... }`; error `{ "success": false, "error": { "code", "message", "details?" } }`.
Auth: `Authorization: Bearer <token>` where required. Token payload: `{ sub, kind: 'retailer'|'admin'|'consumer', subRole? }`.

## Two onboarding tracks (important)

There are **two coexisting tracks**; a given email/phone flows through exactly one (each blocks the other on email/phone collision):

- **Track A — Application-first (recommended):** public application → admin approve → account (`active`) + store (`onboarding`) are provisioned together.
- **Track B — Signup-first (direct):** retailer self-signs-up → account (`pending_approval`) → admin approves account (`active`) → retailer creates store (`onboarding`) → admin approves store (`active`).

Both converge on the **publish gate**: `retailer.status = 'active'` AND `store.status ∈ {onboarding, active}`. Note a store in `onboarding` already passes — store approval (`onboarding`→`active`) is not strictly required to create/publish products.

## Status enums (source of truth)

| enum | values |
|---|---|
| `retailerAccountStatus` | `pending_approval`, `active`, `terminated` |
| `retailerStoreStatus` | `onboarding`, `active`, `paused`, `suspended`, `terminated` |
| `applicationStatus` | `pending`, `docs_requested`, `approved`, `rejected` |
| `applicationDocumentKind` | `storefront_photo`, `address_proof`, `pan`, `gst_certificate`, `bank_proof`, `other` |
| `retailerSubRole` | `owner`, `manager`, `staff`, `delivery_agent` |
| `kycReverificationStatus` | `pending`, `submitted`, `approved`, `rejected`, `overdue` |
| `kycDocumentStatus` | `missing`, `pending_review`, `verified`, `rejected` |
| `changeRequestField` | `legal_name`, `address`, `bank_account`, `gstin`, `pos_billing_activation` |

Shared field rules (used across bodies):
- **email** — trimmed, lowercased, valid email.
- **password (auth signup/login)** — **4–72** chars.
- **password (application)** — **8–128** chars (different from auth!).
- **phone** — regex `^(\+91)?[6-9][0-9]{9}$` (10 digits, optional `+91`, first digit 6–9).
- **gstin** — trimmed, uppercased, **exactly 15** chars (format otherwise not enforced).
- **pan** — trimmed, uppercased, **exactly 10** chars.

---

# 1. Signup (Track B entry)

## POST /auth/retailer/signup  · public

| field | type | required | rules | invalid → |
|---|---|---|---|---|
| `email` | string | yes | valid email (lowercased) | not an email → `422` |
| `password` | string | yes | 4–72 chars | <4 / >72 → `422` |
| `legalName` | string | yes | trimmed 2–120 | <2 / >120 → `422` |
| `phone` | string | yes | `^(\+91)?[6-9][0-9]{9}$` | wrong format → `422` |
| `gstin` | string | yes | exactly 15 chars | ≠15 → `422` |

Creates a `retailer_accounts` row `status='pending_approval'`, `subRole='owner'`, no store. Returns a **usable JWT immediately** (but publishing is blocked until `active`).

`200`:
```json
{ "success": true, "data": {
  "token": "<jwt>",
  "retailer": { "id":"ret_…", "email":"…", "legalName":"…", "phone":"…", "gstin":"…",
                "status":"pending_approval", "kycVerified": true }
}}
```

Errors: `409 email_already_taken` (email or phone already on an account) · `409 application_pending` / `409 application_rejected` (an application exists for this email/phone; `details.applicationId`) · `422 validation_error`.

---

# 2. Login

## POST /auth/retailer/login  · public

| field | type | required | rules |
|---|---|---|---|
| `email` | string | yes | valid email |
| `password` | string | yes | 4–72 chars |

`200`:
```json
{ "success": true, "data": {
  "token": "<jwt>",
  "retailer": { "id":"ret_…", "email":"…", "legalName":"…", "phone":"…", "gstin":"…",
                "status":"active", "storeId":"str_…|null", "subRole":"owner" }
}}
```
(Login returns `status`/`storeId`/`subRole`; signup returns `kycVerified` and no `storeId`.)

Errors: `401 invalid_credentials` (unknown email or wrong password) · `403 application_pending` (email belongs to an application under review, no account yet; `details.applicationId`) · `403 application_rejected` · `422 validation_error`. A `terminated` retailer can still log in (read-only; every mutating request later returns `403`).

No refresh token — re-login on expiry.

## Password reset (both kinds)
- `POST /auth/password-reset/start` — `{ kind: 'retailer'|'admin', email }`
- `POST /auth/password-reset/complete` — `{ kind, email, code: 6 chars, newPassword: 4–72 }`

---

# 3. Application flow (Track A entry)  · public (empty prefix — NOT under /retailer)

## POST /applications  · public — submit an application

Body = `SubmitApplicationBody`:

| field | type | required | rules |
|---|---|---|---|
| `legalName` | string | yes | 2–120 |
| `storeName` | string | no | 2–120 |
| `gstin` | string | yes | exactly 15 |
| `pan` | string | no | exactly 10 |
| `ownerName` | string | yes | 2–120 |
| `ownerEmail` | string | yes | valid email |
| `ownerPhone` | string | yes | phone regex |
| `addressLine` | string | yes | 5–300 |
| `pincode` | string | yes | `^\d{6}$` |
| `stateCode` | string | yes | `^\d{2}$` |
| `lat` / `lng` | string | no | free string |
| `hours` | object | no | opening-hours map |
| `categories` / `brands` | string[] | no | — |
| `sampleSkus` | any[] | no | — |
| `contactPhone` | string | no | ≤20 |
| `managerName` | string | no | ≤120 |
| `bankLegalName` | string | no | ≤200 |
| `bankAccountNumber` | string | no | ≤20 |
| `bankIfsc` | string | no | ≤11 (uppercased) |
| `documents` | array | no | each `{ kind: <applicationDocumentKind>, url: <url> }` |
| `password` | string | no | **8–128** (if set, admin can approve without a temp password) |

Creates `retailer_applications` `status='pending'` (+ `application_documents`), notifies admins. `200`:
```json
{ "success": true, "data": { "id":"app_…", "status":"pending", "message":"Application submitted successfully" } }
```
Errors: `409 email_already_taken` (an account already exists) · `409 application_pending` / `409 application_rejected` (`details.applicationId`) · `422`.

## GET /applications/check-identity?email=&phone=  · public
Pre-signup availability probe. `200 → { emailTaken, phoneTaken, accountExists, applicationStatus, applicationId }`. Use it to route the user to signup vs "you already applied".

## GET /applications/:id/status?email=<ownerEmail>  · public
`email` must match the application's `ownerEmail` (acts as the secret) else `404`.
`200 → { id, status, submittedAt, decidedAt, decisionReason }`.

## GET /applications/:id/messages?email=<ownerEmail> · POST /applications/:id/messages  · public
Applicant↔admin thread. POST body: `{ applicantEmail, body: 1–2000, attachmentUrls?: url[] }`.

## Resubmit after rejection  · public (email+password gated)
- `POST /applications/:id/fetch-for-resubmit` — `{ email, password }` → returns the prior application to prefill.
- `POST /applications/:id/resubmit` — `ApplicationContentSchema + { email, password }`; only allowed when the application is `rejected`; resets to `pending`, bumps `resubmissionCount`. Any `mustReuploadDocKinds` still missing/unchanged → `422`.

## GET /application/messages  · requireAuth('retailer')
The caller's own application thread (after their account is provisioned).

---

# 4. Admin approval

## Track A — approve/reject an application  (prefix /admin, requireAuth('admin'))

### POST /admin/applications/:id/approve  · perm `retailer.approve`
Body `ApproveBody`:

| field | type | required | rules |
|---|---|---|---|
| `tempPassword` | string | no* | 4–72 (*required only if the applicant set no password) |
| `note` | string | no | ≤500 |
| `platformFeeBp` | integer | no | 0–10000, default 1000 (basis points; 1000 = 10%) |

**Provisions atomically:** `retailer_stores` (`status='onboarding'`) + `retailer_accounts` (`status='active'`, `subRole='owner'`, `storeId` set) + optional `bank_accounts`; application → `approved`.
`200 → { retailerId, storeId, message }`.
Errors: `409 invalid_state` (already approved) · `409 email_already_taken` (account exists by email/phone) · `400 validation_error` (no applicant password and no `tempPassword`).

### POST /admin/applications/:id/reject  · perm `retailer.reject`
Body: `{ reason: 1–500, mustReuploadDocKinds?: <applicationDocumentKind>[] }`. Sets application `rejected` (no account created).

### Other admin application endpoints
- `GET /admin/applications?status=&limit=` · `applications.view`
- `GET /admin/applications/:id` · `applications.view`
- `PATCH /admin/applications/:id/status` · `applications.message` — body `{ status: 'docs_requested', reason?: ≤500 }`
- `POST /admin/applications/:id/messages` · `applications.message` — `{ body: 1–2000, attachmentUrls?: url[] }`
- `POST /admin/applications/:id/verification-checks` · `applications.message` — `{ kind: 'gstin'|'pan'|'bank_penny_drop', status: 'pending'|'in_progress'|'verified'|'failed', rawResponse?, errorCode? }`

## Track B — approve/reject a retailer ACCOUNT  (prefix /admin/retailers, requireAuth('admin'))

- `POST /admin/retailers/:id/approve` — **no body.** Requires account `pending_approval` → sets `active` (no store created). `409 invalid_state` otherwise.
- `POST /admin/retailers/:id/reject` — `{ reason: 1–500 }` → account `terminated`.
- `POST /admin/retailers/:id/suspend` — `{ reason: 1–500 }` → store `suspended` (account must be `active`).
- `POST /admin/retailers/:id/unsuspend` — `{ reason?: ≤500 }` → store `active`.
- `POST /admin/retailers/:id/terminate` · perm `retailer.terminate` — `{ reason: 1–500 }` → account+store `terminated`, `permanentSuspend=true`.
- `GET /admin/retailers?status=&search=&limit=&cursor=` — status filter incl. `approved_no_store` (active account, no store).

Perms: `super_admin` = all; `ops_admin` = approve/reject/suspend but **not** terminate; `support` = read-only.

---

# 5. Store setup

## POST /retailer/store  · requireAuth('retailer') + perm `store.edit_profile`  (Track B)
Body `CreateStoreBody`:

| field | type | required | rules |
|---|---|---|---|
| `legalName` | string | yes | 2–120 |
| `address` | string | yes | 5–500 |
| `stateCode` | string | yes | 2-digit state code |
| `lat` | number | yes | −90..90 |
| `lng` | number | yes | −180..180 |
| `openingHours` | object | no | day → `[{ open:"HH:MM", close:"HH:MM" }]` |
| `contactPhone` | string | no | ≤20 |
| `managerName` | string | no | ≤120 |

One store per retailer (`409 store_already_exists` otherwise). Creates `retailer_stores` `status='onboarding'`, links `retailer_accounts.storeId`, pulls `gstin` from the account. Returns the store row.

## PATCH /retailer/store/profile  · perm `store.edit_profile`
`{ contactPhone?, managerName?, galleryImageUrls?: url[≤10], gstScheme?: 'regular'|'composition' }`.

## Store hours / pause / pickup (retailer, `/retailer/store/...`)
- `GET/PUT /retailer/store/hours` — 7 day keys, each `{ from, to, closed }`.
- `POST /retailer/store/pause` — `{ visibility:'visible'|'hidden', reason?:≤500, pauseUntil?: datetime }` → store `paused`. `POST /retailer/store/resume`.
- `GET/POST /retailer/store/pickup-slots`, `PATCH/DELETE …/:id` — `{ dayOfWeek:0–6, startTime:"HH:MM", endTime:"HH:MM", capacity:1–1000 }`.
- `GET/POST /retailer/store/holiday-closures`, `DELETE …/:date` — `{ date:"YYYY-MM-DD", reason?:≤200 }`.

## Admin store approval  (prefix /admin/stores, requireAuth('admin'))
- `POST /admin/stores/:id/approve` — `{ platformFeeBp?: 0–10000 (default 1500), payoutCadenceDays?: 1–30 (default 7) }`. Requires store `onboarding` AND owner account already `active` → store `active`.
- `POST /admin/stores/:id/reject` — `{ reason: 1–500 }` → store `terminated`.

---

# 6. KYC / compliance (post-onboarding re-verification — NOT the initial gate)

KYC is store-scoped, cycle-based annual re-verification. At MVP signup, KYC is auto-accepted, so it does not block going active.

Retailer (`/retailer`, requireAuth('retailer')):
- `GET /retailer/kyc` · `compliance.view` → current cycle `{ id, status, dueAt, gracePeriodEndsAt, lastVerifiedAt, documents:[{id,kind,label,status,uploadedAt,fileUrl}] }` or `null`.
- `POST /retailer/kyc/:id/documents` · `kyc.respond` — `{ kind: 1–64, url }` → doc `pending_review` (cycle must be `pending`).
- `POST /retailer/kyc/:id/submit` · `kyc.respond` — cycle `pending`→`submitted`.
- `GET/POST /retailer/change-requests` · `change_requests.*` — `{ field: <changeRequestField>, currentValue, requestedValue, reason: 3–500, evidenceUrl? }`.

Admin (`/admin/compliance`, requireAuth('admin')):
- `POST /admin/compliance/stores/:storeId/reverify` · `kyc.review` — opens a cycle. `{ reason: 3–500, dueDays?: 7–90, graceDays?: 7–120 }`.
- `POST /admin/compliance/kyc/:id/decide` · `kyc.decide` — `{ decision:'approved'|'rejected', reason?:≤500 }`.
- `GET /admin/compliance/change-requests`, `POST …/:id/decide` — `{ decision, note? }`.

---

# 7. Polling during onboarding

## GET /retailer/me  · requireAuth('retailer')  — primary onboarding-state poll
```json
{ "success": true, "data": {
  "retailer": { "id","email","legalName","phone","gstin","status","permanentSuspend","suspendReason" },
  "store": null | { "id","legalName","gstin","gstScheme","address","stateCode","lat","lng",
                    "status","platformFeeBp","payoutCadenceDays","posBillingEnabled",
                    "permanentSuspend","suspendReason","pauseReason","contactPhone","managerName","galleryImageUrls" }
}}
```
`store` is `null` until a store exists. Drive the onboarding UI off `retailer.status` + `store?.status`.

Public pre-account polls: `GET /applications/:id/status?email=`, `GET /applications/check-identity`.

---

# 8. End-to-end chronology

## Track A — Application-first
1. Retailer: `POST /applications` (public) → application `pending`.
2. Retailer polls: `GET /applications/:id/status?email=` / `GET /applications/check-identity`.
3. (optional) Admin: `PATCH /admin/applications/:id/status` → `docs_requested`, `POST …/messages`, `POST …/verification-checks`.
4. (if rejected) Retailer: `POST /applications/:id/fetch-for-resubmit` → `POST /applications/:id/resubmit` (→ `pending`).
5. Admin: `POST /admin/applications/:id/approve` → provisions account (`active`) + store (`onboarding`).
6. Retailer: `POST /auth/retailer/login` → now `active` + `storeId` → **passes publish gate**, can create/publish products.
7. (optional) Admin: `POST /admin/stores/:id/approve` → store `onboarding`→`active` (real fees/payout cadence).

## Track B — Signup-first
1. Retailer: `POST /auth/retailer/signup` → account `pending_approval` (JWT issued).
2. Admin: `POST /admin/retailers/:id/approve` → account `active` (no store; shows as `approved_no_store`).
3. Retailer: `POST /retailer/store` → store `onboarding`, `storeId` linked → **passes publish gate**.
4. (optional) Admin: `POST /admin/stores/:id/approve` → store `active` (fully onboarded).

Both converge at: `retailer.status='active'` AND `store.status ∈ {onboarding, active}`.

---

# 9. Error codes

| status | code | when |
|---|---|---|
| 401 | `invalid_credentials` | wrong email/password |
| 401 | `unauthorized` | missing/expired token |
| 403 | `forbidden` | wrong token kind / missing permission / terminated retailer mutating |
| 403 | `application_pending` / `application_rejected` | login/signup where an application exists (`details.applicationId`) |
| 403 | `retailer_not_approved` / `store_not_active` | publish gate not met |
| 404 | `not_found` | application/account/store not found (or email mismatch on public status) |
| 409 | `email_already_taken` | email or phone already used |
| 409 | `application_pending` / `application_rejected` | signup/apply blocked by existing application |
| 409 | `invalid_state` | wrong state (e.g. approve non-`pending_approval`, resubmit non-`rejected`) |
| 422 | `validation_error` | body field rule violated (details include the path) |
