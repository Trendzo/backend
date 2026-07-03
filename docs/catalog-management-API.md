# ClosetX — Catalog Management API Contract (Products, Variants, Inventory, Stock, Pricing)

Comprehensive reference for the retailer catalog surface. All paths under `/api/v1`. Base URL: `https://backend-qpmx.onrender.com/api/v1` (or `http://localhost:3099/api/v1`).

## Conventions

- **Envelope:** success `{ "success": true, "data": ... }`; error `{ "success": false, "error": { "code", "message", "details?" } }`.
- **Auth:** retailer routes need `Authorization: Bearer <token>` (kind `retailer`). Public metadata routes (`/catalog/*`) need none.
- **Permissions (sub-role):** `owner` = all; `manager` = all catalog; `staff` = **read-only** for catalog (`listings.view`, `attribute_templates.view`, `inventory.view`) — cannot create/edit/publish/retire, cannot edit stock/price; `delivery_agent` = none. Gate write UI behind owner/manager.
- **Money:** integer **paise** (₹1 = 100). `pricePaise > 0`. `compareAtPrice` (nullable) must be **> pricePaise**.
- **Availability:** `available = stock − reserved` (computed, never sent as a column).
- **IDs:** `lst_` listing, `var_` variant, `vgrp_` group, `brd_` brand, `cat_` category, `iadj_` adjustment.
- **Errors:** Zod failures → `422 validation_error` (with `details` path). `AppError`s carry their own code/status (table at the end).
- **Terminated/suspended retailer:** read-only — any non-GET returns `403 forbidden`.

## Enums

| enum | values |
|---|---|
| listing `status` | `draft`, `active`, `retired`, `taken_down` (retailer can set only draft/active/retired) |
| `variantMode` | `single`, `color_size`, `custom` |
| `listingPolicy` | `return`, `replace`, `final_sale` |
| `gender` | `her`, `him`, `unisex` |
| `ageGroups` items | `0-2`, `3-7`, `8-12`, `13-17`, `18-24`, `25-40`, `40+` |
| attribute axis `type` | `enum`, `free_text`, `numeric`, `color` |
| inventory `flag` | `low`, `out`, `oversold`, `in_stock`, `all` |
| `inventoryAdjustmentReason` | `manual_edit`, `csv_import`, `order_reservation`, `order_confirmation`, `order_cancellation`, `return_restock`, `damage_writeoff`, `audit_correction`, `pos_sale`, `pos_return_restock`, `pos_void_restock` |

---

# A. Catalog metadata (form pickers)

### GET /catalog/categories?gender=&activeOnly=true  · public
Flat array of category rows (build the tree client-side via `parentId`). Row: `{ id, slug, label, parentId|null, iconName|null, tintColor|null, imageUrl|null, gender, sortOrder, isActive }`. Ordered by `sortOrder,label`.

### GET /catalog/brands?activeOnly=true  · public
Array of brand rows `{ id, slug, name, tintColor|null, logoUrl|null, domain|null, isActive }`, ordered by `name`.

### GET /catalog/size-scales?categoryId=  · public
Array of `{ id, name, values: string[], categorySlugs: string[], sortOrder, isActive }`. With `categoryId`, returns universal scales + those matching the category or any ancestor. Free-typed sizes are also allowed (not restricted to a scale).

### POST /retailer/brands  · `listings.create`
Retailer self-serve brand create. Body: `{ slug (lowercase, `^[a-z0-9]+(?:-[a-z0-9]+)*$`), name (1–120), tintColor? (#RRGGBB), logoUrl? (url), domain? (url) }`. `200 → data`: the brand row. Errors: `409 invalid_state` (slug or case-insensitive name already exists).

### Attribute templates (custom variant axes)  · base `/retailer/attribute-templates`
- `GET /retailer/attribute-templates` · `attribute_templates.view` → `[{ id, name, isPlatformDefault, ownerStoreId, axes: [{ name, type, allowedValues }], usedByListingCount, usageCount, lastUsedAt|null }]` (store templates first by recency, then platform by usage).
- `GET /retailer/attribute-templates/:id` · `attribute_templates.view`.
- `POST /retailer/attribute-templates` · `attribute_templates.edit` — `{ name (1–120), axes: [{ name (1–80), type: enum|free_text|numeric|color, allowedValues: string[] }] (≥1) }` → `{ id }`. `409` on duplicate name (per store).
- `PATCH /retailer/attribute-templates/:id` · `attribute_templates.edit` — `{ name?, axes?, force? }`. Editing axes that orphan existing variants → `409` with `{ affected:[{listingId,listingName,variantCount}] }` unless `force:true` (then those variants get `attributesOutOfTemplate=true`). Platform-default templates are read-only (`403`).
- `DELETE /retailer/attribute-templates/:id` · `attribute_templates.edit` — `403` if platform-default, `409` if in use.

---

# B. Listings

All under `/retailer`, `requireAuth('retailer')`.

### POST /retailer/listings  · `listings.create`  — create (always `draft`)
Body `CreateListingBody`:

| field | type | required | rules |
|---|---|---|---|
| `name` | string | yes | 1–200 (trimmed) |
| `brandId` | string | yes | must exist (`brd_…`) |
| `categoryId` | string | yes | must exist (`cat_…`) |
| `gender` | enum | yes | her/him/unisex |
| `description` | string | no | ≤2000 |
| `descriptionLong` | string | no | ≤110000 raw; sanitized HTML; post-sanitize ≤100 KB |
| `listingPolicy` | enum | no (def `return`) | return/replace/final_sale |
| `galleryUrls` | url[] | no (def []) | ≤20 |
| `occasion` | string[] | no (def []) | ≤10, each 1–40 |
| `ageGroups` | enum[] | no (def []) | subset of age-range enum |
| `hsn` | string | no (auto) | ≤8; auto-filled from category if blank |
| `templateId` | string | no | if set, `variantMode` must be `custom` |
| `variantMode` | enum | no | default `custom` if templateId else `single` |

`200 → data`: the listing row (see shapes §F). A default variant group is created automatically. Errors: `403 retailer_not_approved`/`store_not_active`, `404 not_found` (brand/category/template), `422` (template/mode mismatch, long-desc too long).

### GET /retailer/listings?status=&sort=  · `listings.view`
`status ∈ draft|active|retired|taken_down` (optional); `sort ∈ updated_desc|name_asc`. `200 → data`: array of listings, each with `variants[]`, `variantGroups[]`, `brand`, `category`; `taken_down` items also carry `takedownReason`.

### GET /retailer/listings/:id  · `listings.view`
Single listing + `variants[]` + `variantGroups[]` + `brand` + `category` (+`takedownReason`). `404`/`403` if not found/owned.

### PATCH /retailer/listings/:id  · `listings.edit`
Body = any subset of the create fields (all optional) **plus** `status ∈ draft|active|retired` and `descriptionLong`/`templateId` nullable to clear. Setting `status:'active'` runs the publish checks (§E) → `409 cannot_publish_incomplete` if not ready. Guards → `409 invalid_state` (change template with variants present; switch to `single` with named color groups; change policy under delegation mode). `200 → data`: updated listing row.

### DELETE /retailer/listings/:id  · `listings.retire`
**Draft only** (else `409 invalid_state` — use retire via PATCH). Blocked if any variant has `reserved>0` or order history. `200 → { id, deleted: true }`.

### POST /retailer/listings/bulk-status  · `listings.publish`
`{ ids: string[] (1–100), status: active|draft|retired }`. Non-owned/non-publishable listings are **soft-skipped**. `200 → { updated, skipped }`.

### GET /retailer/listings/:id/audit  · `listings.view`
Newest-first audit entries `{ id, listingId, action, actorKind, actorId, before, after, at, note }`.

### GET /retailer/audit/recent-price-changes  · `listings.view`
Recent `variant.edit` rows that changed price: `[{ id, listingId, variantId|null, beforePaise, afterPaise, actorKind, actorId, at }]`.

> CSV exports (full product + variant, and inventory-only) are documented separately in `catalog-export-API.md`.

---

# C. Variants & groups (the 3 modes)

Identity (`attributes`/`attributesLabel`) is **server-derived** on `single`/`color_size`; only `custom` sends it. Sending the wrong identity for the mode → `422`.

## Mode `single` — one default variant
### PUT /retailer/listings/:listingId/default-variant  · `listings.edit`
Idempotent (create then update in place). Body: `{ sku? (1–64), pricePaise (>0), compareAtPrice? (>price, null clears), stock (≥0, def 0), imageUrls (url[], def []) }`. `200 → data`: the variant. Requires `variantMode='single'`.

## Mode `color_size` — color groups + sizes
- `POST /retailer/listings/:listingId/groups` · `listings.edit` — `{ name (1–60), colorHex? (#RRGGBB), sortOrder? }` → group row. (Blocked on `custom`.)
- `PATCH /retailer/groups/:id` · `listings.edit` — `{ name?, colorHex?(null clears), sortOrder?, isActive? }`. Renaming cascades identity to child variants. Default group can't be renamed.
- `DELETE /retailer/groups/:id` · `listings.edit` — not the last group; no reserved/order-history children. `→ { id, deleted:true, variantsDeleted }`.
- `POST /retailer/listings/:listingId/groups/:groupId/variants` · `listings.edit` — `{ size (1–40), sku?, pricePaise, compareAtPrice?, stock, imageUrls }`. Backend composes `{color, size}` label. Client sends only `size` (+ price/stock/sku/images).
- `POST /retailer/listings/:listingId/groups/:groupId/variants/bulk` · `listings.edit` — `{ variants: [ …GroupVariantInput ] (1–100) }`. No duplicate size in the batch.

## Mode `custom` — template axes (flat, default group)
- `POST /retailer/listings/:listingId/variants` · `listings.edit` — `{ attributes: Record<string,string>, attributesLabel (1–120), groupId?, sku?, pricePaise, compareAtPrice?, stock, imageUrls }`.
- `POST /retailer/listings/:listingId/variants/bulk` · `listings.edit` — `{ variants: [ …CreateVariantBody-without-groupId ] (1–100) }`.

## Common variant ops
- `GET /retailer/listings/:listingId/variants` · `listings.view` → variant rows[].
- `GET /retailer/listings/:listingId/effective-pricing` · `listings.view` → per-variant promo-adjusted price `[{ variantId, attributesLabel, basePaise, postPromoSubtotalPaise, effectivePaise, totalDiscountPaise, appliedPromos:[…] }]`.
- `POST /retailer/listings/:listingId/variants/:vid/publish` · `listings.publish` — activates the variant (and publishes the listing if it becomes complete). `409 cannot_publish_incomplete` if the variant/listing isn't ready.
- `GET /retailer/variants/sku-available?sku=&excludeVariantId=` · `listings.view` → `{ available: boolean }` (store-wide SKU check).
- `PATCH /retailer/variants/:id` · `listings.edit` — **this is the stock + price editor.** Body `PatchVariantBody` (≥1 field): `{ pricePaise?, compareAtPrice?(null clears), stock?, sku?(null clears), isActive?, imageUrls?, size?|groupId? (system modes) | attributes?/attributesLabel? (custom) }`. `stock < reserved` → `409`. `compareAtPrice ≤ price` → `422`. Stock change writes an `inventory_adjustments` row (`manual_edit`); price/sku/active changes write a `variant.edit` audit. `200 → data`: updated variant.
- `DELETE /retailer/variants/:id` · `listings.edit` — blocked if `reserved>0`, order history, or it's the last live variant of a published listing. `→ { id, deleted:true }`.

**SKU:** auto-generated (store-unique) when omitted. Duplicate → `409 sku_taken`.
**Gallery rule:** variant `imageUrls` are merged into the listing gallery (cap **20**; overflow → `422`). Editing a listing's `galleryUrls` prunes variant images to the new set.

---

# D. Inventory & stock

All under `/retailer/inventory`, `requireAuth('retailer')`.

### GET /retailer/inventory?q=&status=&flag=&categoryId=&page=1&pageSize=50  · `inventory.view`
`flag ∈ low|out|oversold|in_stock|all` (low = `0 < stock ≤ threshold`, out = `stock=0`, oversold = `stock−reserved<0`). `200 → { rows, total, page, pageSize, lowStockThreshold }`. Each row carries variant `stock, reserved, pricePaise, compareAtPrice`, listing/label info.

### GET /retailer/inventory/adjustments?variantId=&from=&to=&limit=100  · `inventory.view`
Newest-first `inventory_adjustments` rows: `{ id, variantId, delta, newStock, reason, actorKind, actorId, refKind|null, refId|null, at, note|null }`.

### GET /retailer/inventory/:variantId/reservations  · `inventory.view`
Active holds `{ id, qty, ownerKind, ownerId, reservedAt, expiresAt|null }`.

### GET /retailer/inventory/export  · `inventory.export` — CSV download.
### GET /retailer/inventory/template  · `inventory.view` — CSV template.
### GET /retailer/inventory/reports/inventory-health/best-sellers  · `reports.view` — top variants by units sold.

### PATCH /retailer/inventory/settings  · `inventory.adjust`
`{ lowStockThreshold: int 0–100000 }` → `{ lowStockThreshold }`. (Only sets the store threshold; does NOT change variant stock.)

### POST /retailer/inventory/import  · `inventory.import` — CSV bulk (create + stock + price)
Body: `{ rows: ImportRow[] (1–5000), dryRun? }`. `ImportRow = { sku?, productName?, variantLabel?, attributes?, brand?, category?, gender?, pricePaise?, stock }` (needs `sku` OR `productName+variantLabel` OR `productName+attributes`). `dryRun:true` returns the plan without writing. `200 → { dryRun, applied:{ stockUpdates, variantCreates, listingCreates, priceUpdates }, createdListings, createdVariants, updatedVariants, appliedTotal }`. Writes `inventory_adjustments` (`csv_import`) per non-zero delta.

**Stock changes** happen via `PATCH /retailer/variants/:id` (single edit) or CSV import — there is **no separate `/adjust` endpoint** for retailers.

---

# E. Pricing

No dedicated price endpoint. Set/change price via the variant write endpoints (`default-variant`, group/custom variant create, `PATCH /variants/:id`) using `pricePaise` + optional `compareAtPrice`. Rules: integer paise, `pricePaise > 0`, `compareAtPrice > pricePaise` (strike-through "was" price). Reads: `GET …/effective-pricing` (promo-adjusted), `GET /retailer/audit/recent-price-changes`.

---

# F. Status lifecycle & publish rules

- **create → `draft`** always.
- **`draft → active`** (publish) via `PATCH /listings/:id {status:'active'}`, `POST …/variants/:vid/publish`, or `bulk-status`. Requires: retailer `active` + store `onboarding|active`; and the listing is **publishable** — has name, short description, full description, ≥1 gallery image, a return policy, AND ≥1 **complete, effectively-active variant** (variant needs price + SKU + stock + an image, and both it and its group `isActive`). Otherwise `409 cannot_publish_incomplete` (message lists what's missing). First publish flips an `onboarding` store to `active`.
- **`active → draft`** (unpublish) via PATCH/bulk-status.
- **`→ retired`** via PATCH/bulk-status (no gate). Retire (not delete) for listings with history; delete works only on `draft`.
- **`→ taken_down`** is admin/moderation only; retailers see `takedownReason` and (on restore) it returns to `statusBeforeTakedown`.

---

# G. Response shapes

**listing** (`product_listings`): `id, storeId, templateId|null, brandId|null, categoryId, name, description|null, descriptionLong|null, hsn|null, gender, listingPolicy, galleryUrls[], occasion[], ageGroups[], status, variantMode, statusBeforeTakedown|null, ratingAvg (string "0.00"), ratingCount, createdAt, updatedAt`. In list/get also: `variants[]`, `variantGroups[]`, `brand`, `category` (+`takedownReason` when taken down).

**variant** (`variants`): `id, listingId, storeId, groupId, sku|null, barcode|null, attributes (object), attributesLabel, imageUrls[], isActive, stock, reserved, pricePaise, compareAtPrice|null, attributesOutOfTemplate`. (No createdAt/updatedAt; `available = stock − reserved`.)

**group** (`variant_groups`): `id, listingId, storeId, name, colorHex|null, sortOrder, isDefault, isActive, createdAt, updatedAt`.

---

# H. Error codes

| status | code | when |
|---|---|---|
| 401 | `unauthorized` | missing/invalid/expired token |
| 403 | `forbidden` | wrong token kind / missing permission / terminated retailer mutating |
| 403 | `not_owner` | listing/variant belongs to another store |
| 403 | `retailer_not_approved` / `store_not_active` | publish gate not met |
| 404 | `not_found` | listing/variant/group/brand/category/template not found |
| 409 | `invalid_state` | wrong state (delete non-draft, stock<reserved, dup combo, mode guards, last-live-variant, etc.) |
| 409 | `cannot_publish_incomplete` | publish attempted but requirements unmet (message lists them) |
| 409 | `sku_taken` | SKU already exists in the store |
| 422 | `validation_error` | Zod body/param failed, or identity-mode mismatch / gallery overflow / compareAt≤price / long-desc too long |
