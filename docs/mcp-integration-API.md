# ClosetX — MCP Integration Guide (Third-Party Agents)

This guide lets an external platform's AI agent query the ClosetX commerce catalog
through a single endpoint. It uses the Model Context Protocol (MCP). You do not install
anything from us; you point an MCP client (or plain HTTPS calls) at our endpoint and
authenticate with a bearer key.

The surface is **read-only**: browse products, read live offers and coupons, and resolve
brands, categories, collections, facets, reviews, and size scales. There are no write
operations (no cart, checkout, or account actions).

---

## 1. Endpoint and authentication

| | |
|---|---|
| **URL** | `https://backend-qpmx.onrender.com/mcp` (local dev: `http://localhost:3099/mcp`) |
| **Method** | `POST` (only) |
| **Auth header** | `Authorization: Bearer <YOUR_API_KEY>` — **required on every request** |
| **Content-Type** | `application/json` |
| **Accept** | `application/json, text/event-stream` — **both**, required |

> Note: this endpoint is at the host root (`/mcp`), **not** under `/api/v1`. Do not prepend a version path.

Your API key is issued to you separately (out of band). Treat it as a secret; do not embed
it in client-side code shipped to end users. A missing, malformed, or wrong key returns
`401 Unauthorized` with a `WWW-Authenticate: Bearer` header. `GET`/`DELETE` on the endpoint
return `405 Method Not Allowed`.

---

## 2. Protocol and transport

- **Protocol:** MCP over **Streamable HTTP**, JSON-RPC 2.0 message bodies.
- **Protocol version:** `2025-06-18`.
- **Stateless:** every POST is a self-contained request/response. There is no session id to
  track and no server-initiated streaming. Each call must carry the auth header.
- **Response framing:** responses are returned as a Server-Sent-Events stream
  (`content-type: text/event-stream`). Each response contains one `message` event whose
  `data:` line is the JSON-RPC reply:

  ```
  HTTP/1.1 200 OK
  content-type: text/event-stream

  event: message
  data: {"result":{ ... },"jsonrpc":"2.0","id":1}
  ```

  A standard MCP client library parses this for you. If you call the endpoint with raw
  HTTPS, read the line beginning with `data: `, strip that prefix, and `JSON.parse` the rest.

### Two ways to integrate

- **A. MCP client (recommended).** Any MCP-capable agent framework (Claude, OpenAI Agents,
  LangChain/LangGraph, the MCP SDKs, MCP Inspector, etc.) can add a remote Streamable-HTTP
  server. Configure the URL and the bearer header; the client handles the handshake, tool
  discovery, and SSE parsing.

- **B. Raw HTTPS.** POST JSON-RPC bodies yourself. Because the endpoint is stateless you may
  call `tools/list` and `tools/call` directly without a prior `initialize`.

---

## 3. Methods

Three JSON-RPC methods are used: `initialize`, `tools/list`, `tools/call`.

### 3.1 initialize (handshake — optional for raw HTTPS)

Request:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "your-agent", "version": "1.0.0" }
  }
}
```
Result (`result` field of the reply):
```json
{
  "protocolVersion": "2025-06-18",
  "capabilities": { "tools": { "listChanged": true } },
  "serverInfo": { "name": "closetx-commerce", "version": "0.1.0" },
  "instructions": "ClosetX commerce read API. Use these tools to browse products, read offers and coupons, and resolve brands, categories, and curated collections. All tools are read-only. IDs returned by one tool (categoryId, storeId, listing id, collection slug) are the inputs for the others."
}
```

### 3.2 tools/list (discover tools)

Request:
```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }
```
Returns `{ "tools": [ { "name", "title", "description", "inputSchema" }, ... ] }`. `inputSchema`
is a JSON Schema (draft-07) object per tool. The full catalog is documented in section 5.

### 3.3 tools/call (invoke a tool)

Request:
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "search_products",
    "arguments": { "gender": "her", "limit": 5 }
  }
}
```

### Tool result shape

Every tool result has the same envelope:
```json
{
  "content": [ { "type": "text", "text": "<JSON string of the data>" } ],
  "structuredContent": { "data": <the actual payload> },
  "isError": false
}
```
- **`structuredContent.data`** is the machine-readable payload — use this. It is an array for
  list tools and an object for single-item tools.
- **`content[0].text`** is the same payload as a pretty-printed JSON string (convenient for LLMs).
- **`isError: true`** signals a handled tool error (for example, an unknown product id). The
  message is in `content[0].text`, formatted `Error [<code>]: <message>` (for example,
  `Error [not_found]: Product not found`). This is distinct from a JSON-RPC protocol error
  (see section 7).

---

## 4. Capabilities at a glance

| Area | Tools |
|---|---|
| Products | `search_products`, `get_product`, `list_product_reviews`, `list_facets` |
| Offers and coupons | `list_active_promotions` |
| Catalog metadata | `list_categories`, `list_brands`, `list_size_scales` |
| Collections | `list_collections`, `get_collection` |

Typical flow: `list_categories` or `list_facets` to discover ids → `search_products` to browse
→ `get_product` for detail → `list_active_promotions` for applicable discounts.

---

## 5. Tools reference

Only active, publicly visible listings and live promotions are returned. Products from
paused-hidden, suspended, or terminated stores are never included.

### 5.1 search_products

Browse active product listings with their shoppable variants. Newest first, paginated.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `gender` | `her` \| `him` \| `unisex` | no | `unisex` listings also appear under `her` and `him` |
| `categoryId` | string | no | from `list_categories` |
| `storeId` | string | no | restrict to one store |
| `search` | string (1–120) | no | case-insensitive name match |
| `limit` | integer (1–100) | no | default 50 |
| `offset` | integer (≥0) | no | default 0 |

`structuredContent.data` is an array of product objects:
```json
{
  "id": "lst_abc123",
  "storeId": "str_abc123",
  "name": "Linen Shirt",
  "description": "Breathable summer shirt",
  "gender": "her",
  "listingPolicy": "return",
  "galleryUrls": ["https://.../a.jpg", "https://.../b.jpg"],
  "occasion": ["casual"],
  "brand": { "id": "brd_abc123", "name": "Aria" },
  "category": { "id": "cat_abc123", "label": "Shirts", "slug": "shirts" },
  "store": { "id": "str_abc123", "legalName": "Aria Retail Pvt Ltd" },
  "ratingAvg": 4.3,
  "ratingCount": 27,
  "groups": [
    { "id": "vgrp_abc123", "name": "Sky Blue", "colorHex": "#7FB2FF", "isDefault": true }
  ],
  "variants": [
    {
      "id": "var_abc123",
      "groupId": "vgrp_abc123",
      "attributes": { "size": "M" },
      "label": "Sky Blue / M",
      "imageUrls": ["https://.../m.jpg"],
      "pricePaise": 129900,
      "compareAtPricePaise": 159900,
      "discountPct": 19,
      "available": 12
    }
  ]
}
```
A listing with zero shoppable variants is omitted.

### 5.2 get_product

Fetch one active product listing by id. Same object shape as `search_products` items.

| Argument | Type | Required |
|---|---|---|
| `id` | string | yes |

Returns `isError: true` with code `not_found` if the id does not exist or its store is not visible.

### 5.3 list_product_reviews

Active reviews for a listing, newest first, paginated.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `listingId` | string | yes | |
| `limit` | integer (1–100) | no | default 20 |
| `offset` | integer (≥0) | no | default 0 |

`structuredContent.data` is an array of:
```json
{ "id": "rev_abc123", "rating": 5, "body": "Great fit", "createdAt": "2026-05-01T10:00:00.000Z", "author": "Priya" }
```
`author` is a first name only; no other reviewer PII is exposed.

### 5.4 list_facets

Faceted counts over active listings, for building browse navigation. Each facet excludes its
own dimension from its counts.

| Argument | Type | Required |
|---|---|---|
| `gender` | `her` \| `him` \| `unisex` | no |
| `categoryId` | string | no |
| `storeId` | string | no |
| `search` | string (1–120) | no |

`structuredContent.data`:
```json
{
  "total": 128,
  "genders": [ { "gender": "her", "count": 74 }, { "gender": "him", "count": 54 } ],
  "categories": [ { "categoryId": "cat_abc123", "label": "Shirts", "slug": "shirts", "count": 22 } ]
}
```

### 5.5 list_active_promotions

All promotions live right now — auto-applied offers and typeable coupon codes.

No arguments.

`structuredContent.data` is an array of:
```json
{
  "id": "prm_abc123",
  "code": "WELCOME10",
  "name": "WELCOME10",
  "mechanism": "coupon",
  "discountType": "flat_amount",
  "appliedTo": "coupon",
  "config": { "amountPaise": 50000 },
  "storeId": null,
  "validUntil": "2026-09-11T00:00:00.000Z"
}
```
- `mechanism`: `coupon` (shopper types `code` at checkout) or `offer` (auto-applied; `code` is `null`).
- `discountType` + `config` together define the discount. Examples: `flat_amount` →
  `config.amountPaise`; `percentage` → `config.percent` (and often `config.maxAmountPaise`).
- `storeId` `null` means platform-wide; otherwise the promotion is scoped to that store.

> Coupon eligibility and final applicability (minimum order, clubbing rules, per-user limits)
> are resolved at checkout on our side. This tool lists what is live, not a guarantee a given
> cart qualifies.

### 5.6 list_categories

Product categories, ordered for navigation. Build a tree client-side via `parentId`.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `gender` | `her` \| `him` \| `unisex` | no | |
| `activeOnly` | boolean | no | default `true` |

`structuredContent.data` is an array of:
```json
{ "id": "cat_abc123", "slug": "shirts", "label": "Shirts", "parentId": null, "iconName": "shirt-outline", "tintColor": "#FFE66D", "imageUrl": "https://.../shirts.jpg", "gender": "unisex", "sortOrder": 10, "isActive": true }
```

### 5.7 list_brands

Brands, alphabetical.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `activeOnly` | boolean | no | default `true` |

`structuredContent.data` is an array of:
```json
{ "id": "brd_abc123", "slug": "aria", "name": "Aria", "tintColor": "#222222", "logoUrl": "https://.../aria.png", "domain": "https://aria.example", "isActive": true }
```

### 5.8 list_size_scales

Size scales, optionally narrowed to a category (universal scales plus any matching the
category or its ancestors).

| Argument | Type | Required |
|---|---|---|
| `categoryId` | string | no |

`structuredContent.data` is an array of:
```json
{ "id": "ssc_abc123", "name": "Alpha", "values": ["XS","S","M","L","XL"], "categorySlugs": ["shirts"], "sortOrder": 10, "isActive": true }
```

### 5.9 list_collections

Curated collections that are live now, with piece count and bundle price.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `kind` | `outfit` \| `occasion` \| `drop` \| `edit` \| `trend` | no | |
| `gender` | `her` \| `him` \| `unisex` | no | |
| `featured` | boolean | no | |

`structuredContent.data` is an array of collection objects. Each carries at least:
```json
{ "id": "col_abc123", "slug": "summer-linen", "kind": "edit", "gender": "her", "isFeatured": true, "startsAt": null, "endsAt": null, "listingCount": 8, "pricePaise": 999200 }
```
`listingCount` and `pricePaise` (sum of each member's cheapest variant) are computed; other
collection metadata fields may also be present.

### 5.10 get_collection

One active collection by slug, with its resolved member listings.

| Argument | Type | Required |
|---|---|---|
| `slug` | string | yes |

`structuredContent.data` is the collection object plus `listings`, an array of product objects
shaped exactly like `search_products` items. Returns `isError: true` (`not_found`) if the slug
is unknown or the collection is not currently live.

---

## 6. Data conventions

- **Money:** integer **paise** (₹1 = 100 paise). `pricePaise` 129900 = ₹1,299.00.
  `compareAtPricePaise` (nullable) is the strike-through price and is greater than `pricePaise`
  when present. `discountPct` is the rounded percentage off.
- **Availability:** `available = stock − reserved`, precomputed per variant. `available` 0 means
  currently unbuyable.
- **IDs** are opaque strings with a type prefix: `lst_` listing, `var_` variant, `vgrp_` variant
  group, `brd_` brand, `cat_` category, `str_` store, `col_` collection, `prm_` promotion. Pass
  them back verbatim; do not parse them.
- **Gender:** `her`, `him`, `unisex`. `unisex` listings surface under both `her` and `him`.
- **Timestamps:** ISO-8601 UTC strings (for example `2026-09-11T00:00:00.000Z`).
- **Images:** absolute HTTPS URLs, safe to hotlink.

---

## 7. Errors

| Layer | How it appears | Example |
|---|---|---|
| Auth | HTTP `401`, body `{ "success": false, "error": { "code": "unauthorized", "message": "..." } }`, plus `WWW-Authenticate: Bearer` | missing/wrong key |
| Method | HTTP `405`, body `{ "success": false, "error": { "code": "method_not_allowed", ... } }` | `GET`/`DELETE` on `/mcp` |
| Missing `Accept` type | HTTP `406` | omit `text/event-stream` from `Accept` |
| Protocol (JSON-RPC) | `200` with a `result` that is an error result, or a JSON-RPC `error` object | unknown method, unknown tool name, invalid arguments |
| Tool (handled) | `200`, `result.isError: true`, message in `content[0].text` | `Error [not_found]: Product not found` |

Unknown tool names and schema-invalid arguments come back as a tool error result
(`isError: true`) rather than crashing the call.

---

## 8. Quick start (raw HTTPS)

List tools:
```bash
curl -sN https://backend-qpmx.onrender.com/mcp \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Call a tool (live offers and coupons):
```bash
curl -sN https://backend-qpmx.onrender.com/mcp \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_active_promotions","arguments":{}}}'
```

Search products:
```bash
curl -sN https://backend-qpmx.onrender.com/mcp \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_products","arguments":{"gender":"her","limit":5}}}'
```

Each response is an SSE stream; parse the `data:` line as JSON and read `result.structuredContent.data`.

Interactive testing: `npx @modelcontextprotocol/inspector`, then connect to the URL above using
transport "Streamable HTTP" and add the `Authorization` header.

---

## 9. Notes

- The tool set is read-only today. Authenticated per-user data (orders, cart, wallet) and any
  write actions are not exposed on this endpoint.
- The tool list may grow; new tools are additive. Discover them at runtime via `tools/list`
  rather than hardcoding the set. `serverInfo.version` reflects the deployed version.
- For access, a production key, or integration support, contact your ClosetX technical contact.
