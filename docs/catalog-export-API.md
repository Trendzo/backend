# ClosetX — Catalog CSV Export (API + Frontend Integration)

Standalone reference for the retailer CSV exports. Two endpoints: a **full product + variant** export and a lighter **inventory-only** export. Base URL: `https://backend-qpmx.onrender.com/api/v1` (or `http://localhost:3099/api/v1`).

**Important:** these endpoints return a **CSV file**, not the usual JSON envelope. On success the body is `text/csv` with a `Content-Disposition: attachment` header. On error (401/403/etc.) the body IS the usual JSON envelope `{ success:false, error:{ code, message } }`. Both require `Authorization: Bearer <token>` (retailer).

---

## 1. GET /retailer/listings/export  — full product + variant CSV

Permission `listings.view` (available to all retailer roles, incl. staff).
Downloads the store's **entire catalog**: **one row per variant** (listing/group columns repeat across a listing's variants). A listing with no variants still emits one row with the variant columns blank, so nothing is silently dropped.

- Format: UTF-8 with BOM; multi-value fields pipe (`|`) joined; RFC-4180 quoting for cells containing commas/quotes/newlines.
- Filename: `Content-Disposition: attachment; filename="products-<storeId>-<YYYY-MM-DD>.csv"`.
- Optional query filters: `status` (`draft|active|retired|taken_down`), `categoryId`.
  Example: `GET /retailer/listings/export?status=active`.

**Columns (38, in order):**

| group | columns |
|---|---|
| listing | `listing_id`, `product_name`, `status`, `variant_mode`, `brand_slug`, `brand_name`, `category_slug`, `category_label`, `gender`, `listing_policy`, `hsn`, `description`, `occasion` (\|-joined), `age_groups` (\|-joined), `gallery_urls` (\|-joined), `rating_avg`, `rating_count`, `created_at` (ISO), `updated_at` (ISO) |
| variant group | `group_id`, `group_name`, `color_hex`, `group_is_default`, `group_is_active` |
| variant | `variant_id`, `sku`, `barcode`, `attributes` (`k=v` \|-joined, sorted), `attributes_label`, `price_paise`, `price_inr` (paise/100, 2-dp), `compare_at_price_paise`, `stock`, `reserved`, `available` (stock−reserved), `is_active`, `image_urls` (\|-joined), `attributes_out_of_template` |

---

## 2. GET /retailer/inventory/export  — inventory-only CSV

Permission `inventory.export`. Lighter export focused on stock/price. Same download mechanics/format.

- Filename: `inventory-<storeId>-<YYYY-MM-DD>.csv`.
- Optional query filters: `q` (search), `status` (`draft|active|retired|taken_down`), `flag` (`low|out|oversold|in_stock|all`), `categoryId`, and `cols` (comma-separated subset of the columns below; a SKU/identifier column is always ensured).
- Columns: `sku`, `product_name`, `variant_label`, `attributes` (`k=v` \|-joined), `brand`, `category`, `gender`, `price_paise`, `stock`, `reserved`, `status`.

Use this for stock reconciliation / re-import; use **§1** when you need full product detail.

---

## 3. Frontend integration (how to trigger the download)

**You cannot use a plain `<a href download>`** — these endpoints require the `Authorization` header, which a normal link navigation won't send. Fetch with the header, read the response as a **blob**, and trigger the download from an object URL. Read the filename from `Content-Disposition` (fallback to a default).

```js
async function downloadCsv(path, token, fallbackName = 'export.csv') {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    // error bodies are JSON envelopes: { success:false, error:{ code, message } }
    let msg = `Export failed (${res.status})`;
    try { const j = await res.json(); msg = j?.error?.message ?? msg; } catch {}
    throw new Error(msg); // show via the app's normal error toast
  }
  const cd = res.headers.get('Content-Disposition') || '';
  const filename = /filename="?([^"]+)"?/.exec(cd)?.[1] ?? fallbackName;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
```

Usage — pass the screen's active filters so the file matches what's on screen:

```js
// Products screen — full product export, honoring current filters
const qs = new URLSearchParams();
if (statusFilter) qs.set('status', statusFilter);
if (categoryId)   qs.set('categoryId', categoryId);
await downloadCsv(`/retailer/listings/export?${qs.toString()}`, token, 'products.csv');

// Inventory screen — inventory-only export
await downloadCsv('/retailer/inventory/export', token, 'inventory.csv');
```

**axios variant:** `axios.get(path, { headers:{ Authorization:`Bearer ${token}` }, responseType: 'blob' })`, then build the object URL from `res.data` the same way and read `res.headers['content-disposition']` for the filename.

**UX / behavior:**
- Show a loading state on the export button while the request is in flight (exports can be large — hundreds/thousands of rows) and disable re-clicks until it resolves.
- On error, surface `error.message` via the standard error toast.
- No role gating needed on the **product** export button (`listings.view` — all roles). The **inventory** export needs `inventory.export`; hide its button for roles that lack it if you gate by permission elsewhere.
- Optional: an "Export all" vs "Export current view (filtered)" choice, where "all" omits the query filters.

---

## Prompt (paste to the frontend team's Claude)

> Add an **Export CSV** action to the catalog UI (already integrated with our backend at `https://backend-qpmx.onrender.com/api/v1`, Bearer auth). Do NOT add new styling — reuse existing button/toolbar components. Endpoints return a CSV file (not JSON): `GET /api/v1/retailer/listings/export` (full product + variant; optional `?status=&categoryId=`; permission `listings.view`) on the Products screen, and `GET /api/v1/retailer/inventory/export` (inventory-only; permission `inventory.export`) on the Inventory screen. Pass the screen's active filters into the query so the file matches the current view. Because these need the `Authorization: Bearer <token>` header, you cannot use a plain `<a href download>` — fetch with the header, read the response as a blob, derive the filename from the `Content-Disposition` header (fallback default), create an object URL, click a temporary anchor, then revoke the URL (see the `downloadCsv` helper in `catalog-export-API.md`; axios: `responseType: 'blob'`). Error responses are JSON envelopes `{ success:false, error:{ code, message } }` — show `error.message` via our normal toast. Add a loading state on the button and disable re-clicks while downloading. Deliverable: Export CSV buttons on the Products and Inventory screens using a shared download helper, honoring current filters, with loading/error states, matching current UI.
