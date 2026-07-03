# ClosetX — AI Catalog BETA API Contract

Full endpoint reference for the AI mockup / try-on / product-creation flow in the
**main backend** (`closetx-backend`, Fastify + TS + Drizzle). All image
generation runs on **Vertex AI** (model `gemini-2.5-flash-image`; virtual try-on
uses `virtual-try-on-001`). The provider is fixed server-side — the client never
selects it.

## Conventions

- **Base URL:** `http://localhost:3099/api/v1` (local) or
  `https://backend-qpmx.onrender.com/api/v1` (Render — requires the Vertex env +
  service-account key configured on the service).
- **Envelope:** success `{ "success": true, "data": ... }`;
  error `{ "success": false, "error": { "code": string, "message": string, "details?": any } }`.
- **Auth:** all endpoints except login/signup and `/health` require
  `Authorization: Bearer <token>`. Image/product endpoints require a **retailer**
  token whose account is `active`.
- **Money:** integer **paise** (1 INR = 100 paise). `49999` = INR 499.99.
- **IDs:** prefixed — `ret_` retailer, `str_` store, `aic_` submission,
  `lst_` listing, `var_` variant, `cat_` category, `brd_` brand.
- **Images:** provided as **pre-uploaded URLs**. Upload the file first via
  `POST /uploads` (Cloudinary) and pass the returned `url`. Uploads cap 5 MB,
  JPEG/PNG/WebP.
- **Generation:** synchronous — the request returns once Vertex + Cloudinary
  finish. A failed generation returns `502`.

## Enumerations

- `mode`: `without_model` | `with_model`
- submission `status`: `submitted` | `processing` | `ready_for_review` | `accepted` | `rejected` | `regenerating` | `failed`
- `gender` (product): `her` | `him` | `unisex`
- `modelGender` (on-model generation): `him` | `her`
- `listingPolicy`: `return` | `replace` | `final_sale`
- listing `status`: `draft` | `active` | `retired` | `taken_down` (BETA publish creates `draft`)
- view names — `without_model`: `front`, `back`, `three-quarter`, `flat-lay`, `on-hanger`;
  `with_model`: `model-front-studio`, `model-three-quarter`, `model-back`, `model-lifestyle`

## Endpoint index

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` (root, not under `/api/v1`) | — | Liveness |
| POST | `/auth/retailer/signup` | — | Create retailer account |
| POST | `/auth/retailer/login` | — | Login → token |
| POST | `/uploads?purpose=listing-gallery` | Bearer | Upload one image → Cloudinary URL |
| GET | `/catalog/categories` | Bearer | Category list (dropdown) |
| GET | `/catalog/brands` | Bearer | Brand list (dropdown) |
| POST | `/retailer/ai-catalog-beta/submissions` | Bearer | Generate mockups + create submission |
| GET | `/retailer/ai-catalog-beta/submissions` | Bearer | List submissions (store-scoped) |
| GET | `/retailer/ai-catalog-beta/submissions/:id` | Bearer | Get one submission |
| POST | `/retailer/ai-catalog-beta/submissions/:id/decision` | Bearer | Approve / reject |
| POST | `/retailer/ai-catalog-beta/submissions/:id/publish` | Bearer | Add details → create product |
| POST | `/retailer/ai-catalog-beta/mockups` | Bearer | Stateless mockups (no DB) |
| POST | `/retailer/ai-catalog-beta/tryon` | Bearer | Virtual try-on |

---

## GET /health

Root path (not under `/api/v1`). `200 → { "success": true, "data": { "status": "ok", "uptime": <sec> } }`.

---

## POST /auth/retailer/signup

`application/json`

| field | type | rules |
|---|---|---|
| `email` | string | valid email |
| `password` | string | 4–72 chars |
| `legalName` | string | 2–120 chars |
| `phone` | string | `^(\+91)?[6-9][0-9]{9}$` |
| `gstin` | string | 15 chars |

`200 → { token, retailer: { id, email, legalName, phone, gstin, status:"pending_approval", kycVerified:true } }`
Errors: `409 email_already_taken` / `application_pending` / `application_rejected`, `422 validation_error`.

## POST /auth/retailer/login

`application/json` — `{ "email", "password" }`

`200 → { token, retailer: { id, email, legalName, phone, gstin, status, storeId, subRole } }`
Errors: `401 invalid_credentials`, `403 application_pending` / `application_rejected`.
Send `Authorization: Bearer <token>` on every call below. No refresh token — re-login on expiry.

---

## POST /uploads?purpose=listing-gallery

`multipart/form-data`, field name `file`. Call once per photo (front, back, design). Max 5 MB, JPEG/PNG/WebP.

`200 → { url, publicId, width, height, format, bytes, resourceType, mimetype, filename }`
Save each `url`. Errors: `422` (missing/too large/unsupported), `503` (Cloudinary not configured).

---

## GET /catalog/categories · GET /catalog/brands

`GET /catalog/categories → { data: [ { id:"cat_…", slug, label, gender } ] }`
`GET /catalog/brands → { data: [ { id:"brd_…", slug, name } ] }`
Active rows only. Used to fill the product-details form.

---

## POST /retailer/ai-catalog-beta/submissions

Generate the mockup set (on Vertex) and persist a submission. `application/json`.

| field | type | required | notes |
|---|---|---|---|
| `mode` | enum | yes | `without_model` or `with_model` |
| `apparelImageUrls` | string[] (1–5) | yes | front photo URL(s) |
| `apparelBackImageUrl` | string (url) | no | real BACK photo — back views render from it (when no design) |
| `designImageUrl` | string (url) | no | graphic printed onto the front first |
| `patternCloseupUrl` | string (url) | no | close-up of the fabric pattern / texture (detail reference) |
| `logoCloseupUrl` | string (url) | no | close-up of the logo / monogram (detail reference) |
| `tagLabelUrl` | string (url) | no | photo of the brand tag / label (detail reference) |
| `modelGender` | enum | no | `him` or `her` — model gender, used only when `mode = with_model` |
| `prompt` | string (≤800) | no | freeform instruction |
| `only` | string[] | no | limit to these view names (cheaper) |

Notes on the optional inputs:
- **Detail close-ups** (`patternCloseupUrl`, `logoCloseupUrl`, `tagLabelUrl`) — upload them like any other image via `POST /uploads` and pass the URLs. They are fed to the model as **extra reference images** (to reproduce the fabric pattern, logo, and brand tag faithfully) and recorded on the submission's `referenceImageUrls`/`rawPhotos`. They are NOT emitted as separate images in `outputUrls`.
- **`modelGender`** — only affects `with_model` generation (adds "the model is a man/woman" to the prompt). Ignored for `without_model`. If omitted, the model is left unspecified.

`200 → data`:
```json
{ "id":"aic_…", "storeId":"str_…", "listingId":null, "mode":"without_model",
  "prompt":"…", "referenceImageUrls":["…"], "rawPhotos":["…"],
  "outputUrls":["…front.png","…back.png"], "status":"ready_for_review", "at":"ISO" }
```
`outputUrls` = the generated mockups. Errors: `429` (too many open drafts, cap 30/store), `502` (generation failed → row `failed`), `404` (store not found).

## GET /retailer/ai-catalog-beta/submissions

Query: `status?` (submission status enum), `limit?` (1–100, default 50).
`200 → data: [ <submission row> … ]` (store-scoped, newest first).

## GET /retailer/ai-catalog-beta/submissions/:id

`200 → data: <submission row>`. `404` if not found / not owned.

## POST /retailer/ai-catalog-beta/submissions/:id/decision

`application/json` — `{ "decision": "accept" | "reject", "revisionNotes?": string }`
Precondition: status `ready_for_review`.
`200 → { id, status: "accepted" | "rejected" }`. Errors: `404`, `400` (wrong state).

## POST /retailer/ai-catalog-beta/submissions/:id/publish

Add product details and create the product. Precondition: status `accepted`. `application/json`.

| field | type | required | default | notes |
|---|---|---|---|---|
| `name` | string | yes | — | product name |
| `categoryId` | string | yes | — | from `/catalog/categories` |
| `brandId` | string | yes | — | from `/catalog/brands` |
| `gender` | enum | yes | — | `her` \| `him` \| `unisex` |
| `pricePaise` | int | yes | — | > 0 |
| `selectedImageUrls` | string[] | no | all `outputUrls` | the mockups the user PICKED (subset) → listing gallery |
| `stock` | int | no | 0 | variant stock |
| `description` | string | no | — | short description |
| `listingPolicy` | enum | no | `return` | `return`\|`replace`\|`final_sale` |
| `compareAtPrice` | int | no | — | must be > `pricePaise` |
| `occasion` | string[] | no | `[]` | |
| `ageGroups` | string[] | no | `[]` | |
| `hsn` | string | no | auto | GST HSN |

`200 → data`:
```json
{ "listing": { "id":"lst_…", "status":"draft", "categoryId":"…","brandId":"…",
               "gender":"…","galleryUrls":["…selected…"], "variantMode":"single", … },
  "variant":  { "id":"var_…", "pricePaise":49999, "stock":10, "attributesLabel":"Default", … } }
```
The **"select mockups"** step = `selectedImageUrls`. Product is created `draft` (not consumer-visible until published through the normal listings flow). Errors: `400` (validation / not accepted), `404` (submission/category/brand), `409` (already published).

---

## POST /retailer/ai-catalog-beta/mockups

Stateless mockups — same generation as a submission, but **no DB row, no product**. Same body as `submissions` (including `apparelBackImageUrl`, `designImageUrl`, the detail close-ups `patternCloseupUrl` / `logoCloseupUrl` / `tagLabelUrl`, and `modelGender`).

`200 → data`:
```json
{ "printed": "url|null", "images": [ { "name":"front", "url":"…" } ] }
```
`printed` = the design-on-apparel image (null if no `designImageUrl`).
One call = one `mode`. For product + model sets, call twice (`without_model`, then `with_model`).

---

## POST /retailer/ai-catalog-beta/tryon

Customer virtual try-on via Vertex `virtual-try-on-001`. `application/json`.

| field | type | required | notes |
|---|---|---|---|
| `personImageUrl` | string | yes | selfie / person photo URL |
| `garmentImageUrls` | string[] (1–2) | yes | garment URLs; applied in order (e.g. top then bottom) |

`200 → data`:
```json
{ "result": "…final.png", "steps": [ "…step1.png", "…step2.png" ] }
```
`result` = final image; `steps` = each layering stage. Errors: `502` (VTO failed), `422`.

---

## Error codes

| status | meaning |
|---|---|
| 400 / 422 | validation failed / bad request |
| 401 | missing / invalid / expired token |
| 403 | wrong token kind, no permission, or retailer not `active` |
| 404 | submission / category / brand / store not found |
| 409 | wrong submission state (e.g. publish before accept) |
| 429 | too many open drafts (cap 30 per store) |
| 502 | Vertex generation / try-on failed |
| 503 | provider not configured (Vertex or Cloudinary env missing) |

---

## Full sequence (new mockup → product)

1. `POST /auth/retailer/login` → token.
2. `POST /uploads` for the **front** and **back** photos (and optional design) → collect URLs.
3. `POST /retailer/ai-catalog-beta/submissions` with `apparelImageUrls:[front]`, `apparelBackImageUrl:back` (+ `designImageUrl?`) → `outputUrls` (the mockups), `status:ready_for_review`.
4. (optional) `GET …/submissions/:id` to review.
5. `POST …/submissions/:id/decision {"decision":"accept"}`.
6. `GET /catalog/categories` + `/catalog/brands` → pick `categoryId`, `brandId`.
7. `POST …/submissions/:id/publish` with the chosen `selectedImageUrls` + product details → `{ listing, variant }`. Product created (`draft`).

---

## Differences vs the MVP (behaviour, not capability)

Every MVP capability exists here. What changed:

1. **Auth required.** MVP was open; here you must be a logged-in retailer with `status = active`. No token → `401`; inactive → `403`.
2. **Images are pre-uploaded URLs.** MVP accepted raw file uploads on each call; here upload via `POST /uploads` first, then pass the Cloudinary URLs.
3. **Storage.** MVP wrote to local `/files`; here images live on Cloudinary (returned as `https` URLs).
4. **Mockups are one `mode` per call.** MVP `/api/mockups` could return product + model in one call (`views=both`); here call `/mockups` twice (or `submissions` twice) — once per `mode`.
5. **Old MVP paths are gone.** `/api/mockups` and `/api/tryon` do not exist; use `/retailer/ai-catalog-beta/mockups` and `/retailer/ai-catalog-beta/tryon`.
