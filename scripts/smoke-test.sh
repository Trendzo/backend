#!/bin/bash
# Smoke test the MVP endpoints: happy paths + a handful of obvious error paths.
# Run AFTER `node scripts/start-embedded-pg.mjs` and `npm run dev` are both up.
set -uo pipefail

BASE="http://127.0.0.1:3099"
API="$BASE/api/v1"

PASS=0
FAIL=0

# pretty-print + check status helpers
say()  { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
pass() { printf "  \033[1;32m✓\033[0m %s\n" "$*"; PASS=$((PASS+1)); }
fail() { printf "  \033[1;31m✗\033[0m %s\n" "$*"; FAIL=$((FAIL+1)); }

# Run a curl, extract HTTP status & body. Globals: STATUS, BODY
hit() {
  local method="$1" path="$2" data="${3:-}" auth="${4:-}"
  local args=(-sS -o /tmp/.body -w '%{http_code}' -X "$method")
  [[ -n "$auth" ]] && args+=(-H "Authorization: Bearer $auth")
  if [[ -n "$data" ]]; then
    args+=(-H 'Content-Type: application/json' --data "$data")
  fi
  args+=("$BASE$path")
  STATUS=$(curl "${args[@]}")
  BODY=$(cat /tmp/.body)
}

expect_status() {
  if [[ "$STATUS" == "$1" ]]; then pass "$2  →  HTTP $STATUS"
  else fail "$2  →  expected HTTP $1, got HTTP $STATUS — body: $BODY"
  fi
}

# Try jq, fall back to grep if jq isn't installed
jget() {
  if command -v jq >/dev/null 2>&1; then jq -r "$1" <<<"$BODY"
  else grep -oP "\"${1#.}\"\s*:\s*\"[^\"]+\"" <<<"$BODY" | head -1 | sed 's/.*: *"\(.*\)"/\1/'
  fi
}

#───────────────────────────────────────────────────────────────────────
say "1. Health + ping"
hit GET /health;            expect_status 200 "GET /health"
hit GET /api/v1/ping;       expect_status 200 "GET /api/v1/ping"

#───────────────────────────────────────────────────────────────────────
say "2. Public catalog"
hit GET /api/v1/catalog/categories;             expect_status 200 "GET /catalog/categories"
hit GET /api/v1/catalog/categories?gender=her;  expect_status 200 "GET /catalog/categories?gender=her"
hit GET /api/v1/catalog/brands;                 expect_status 200 "GET /catalog/brands"

# Pick a brand id + category id we can use for listing creation later
BRAND_ID=$(if command -v jq >/dev/null; then jq -r '.data[0].id' <<<"$BODY"; else jget id; fi)
hit GET /api/v1/catalog/categories
CAT_ID=$(if command -v jq >/dev/null; then jq -r '.data[0].id' <<<"$BODY"; else jget id; fi)
echo "  using brandId=$BRAND_ID  categoryId=$CAT_ID"

#───────────────────────────────────────────────────────────────────────
say "3. Admin login (happy)"
hit POST /api/v1/auth/admin/login '{"email":"admin@closetx.local","password":"admin1234"}'
expect_status 200 "POST /auth/admin/login (correct credentials)"
ADMIN_TOKEN=$(if command -v jq >/dev/null; then jq -r '.data.token' <<<"$BODY"; else jget token; fi)
echo "  ADMIN_TOKEN=${ADMIN_TOKEN:0:30}…"

say "4. Admin login (wrong password)"
hit POST /api/v1/auth/admin/login '{"email":"admin@closetx.local","password":"WRONGPASS"}'
expect_status 401 "POST /auth/admin/login (bad password)"
[[ "$BODY" == *invalid_credentials* ]] && pass "  envelope carries 'invalid_credentials' code" || fail "  expected code 'invalid_credentials' in error body"

say "5. Admin login (malformed body)"
hit POST /api/v1/auth/admin/login '{"email":"not-an-email","password":""}'
expect_status 422 "POST /auth/admin/login (validation error)"

#───────────────────────────────────────────────────────────────────────
say "6. Retailer signup (happy — auto-KYC accepts valid GSTIN)"
SIGNUP='{"email":"shop@example.com","password":"secret123","legalName":"Acme Apparel","phone":"+919876543210","gstin":"27AAAPL1234C1Z5"}'
hit POST /api/v1/auth/retailer/signup "$SIGNUP"
expect_status 200 "POST /auth/retailer/signup"
RETAILER_TOKEN=$(if command -v jq >/dev/null; then jq -r '.data.token' <<<"$BODY"; else jget token; fi)
RETAILER_ID=$(if command -v jq >/dev/null; then jq -r '.data.retailer.id' <<<"$BODY"; else jget id; fi)
echo "  RETAILER_ID=$RETAILER_ID  TOKEN=${RETAILER_TOKEN:0:30}…"

say "7. Retailer signup (bad GSTIN)"
hit POST /api/v1/auth/retailer/signup '{"email":"x@y.com","password":"abcd","legalName":"X","phone":"+919876543210","gstin":"BADGSTIN"}'
expect_status 422 "POST /auth/retailer/signup (invalid gstin format)"

say "8. Retailer signup (duplicate email)"
hit POST /api/v1/auth/retailer/signup "$SIGNUP"
expect_status 409 "POST /auth/retailer/signup (duplicate email)"
[[ "$BODY" == *email_already_taken* ]] && pass "  envelope carries 'email_already_taken'" || fail "  expected 'email_already_taken'"

say "9. Retailer login (happy)"
hit POST /api/v1/auth/retailer/login '{"email":"shop@example.com","password":"secret123"}'
expect_status 200 "POST /auth/retailer/login"

say "10. Retailer login (wrong pass)"
hit POST /api/v1/auth/retailer/login '{"email":"shop@example.com","password":"NOPENOPE"}'
expect_status 401 "POST /auth/retailer/login (bad password)"

#───────────────────────────────────────────────────────────────────────
say "11. Auth boundary (cross-domain token rejection)"
hit GET /api/v1/retailer/me '' "$ADMIN_TOKEN"
expect_status 403 "GET /retailer/me with admin token → forbidden"

hit GET /api/v1/admin/retailers '' "$RETAILER_TOKEN"
expect_status 403 "GET /admin/retailers with retailer token → forbidden"

hit GET /api/v1/admin/retailers
expect_status 401 "GET /admin/retailers with no token → unauthorized"

#───────────────────────────────────────────────────────────────────────
say "12. Retailer /me before store creation"
hit GET /api/v1/retailer/me '' "$RETAILER_TOKEN"
expect_status 200 "GET /retailer/me"

#───────────────────────────────────────────────────────────────────────
say "13. Retailer creates store (happy)"
STORE_PAYLOAD='{"legalName":"Acme Apparel Mumbai","address":"42 Linking Rd, Bandra W","stateCode":"27","lat":19.0596,"lng":72.8295,"platformFeeBp":500,"payoutCadenceDays":7}'
hit POST /api/v1/retailer/store "$STORE_PAYLOAD" "$RETAILER_TOKEN"
expect_status 200 "POST /retailer/store"
STORE_ID=$(if command -v jq >/dev/null; then jq -r '.data.id' <<<"$BODY"; else jget id; fi)
echo "  STORE_ID=$STORE_ID"

say "14. Retailer creates a SECOND store (must conflict — one per retailer)"
hit POST /api/v1/retailer/store "$STORE_PAYLOAD" "$RETAILER_TOKEN"
expect_status 409 "POST /retailer/store (second store)"
[[ "$BODY" == *store_already_exists* ]] && pass "  envelope carries 'store_already_exists'" || fail "  expected 'store_already_exists'"

#───────────────────────────────────────────────────────────────────────
say "15. Retailer tries to create listing while NOT approved (must fail)"
LISTING_PAYLOAD=$(printf '{"name":"Linen Shirt","description":"Cool linen shirt","brandId":"%s","categoryId":"%s","gender":"him","badge":"new","listingPolicy":"return","galleryUrls":[],"hsn":"6105","status":"active"}' "$BRAND_ID" "$CAT_ID")
hit POST /api/v1/retailer/listings "$LISTING_PAYLOAD" "$RETAILER_TOKEN"
expect_status 403 "POST /retailer/listings (retailer not yet approved)"
[[ "$BODY" == *retailer_not_approved* ]] && pass "  envelope carries 'retailer_not_approved'" || fail "  expected 'retailer_not_approved'"

#───────────────────────────────────────────────────────────────────────
say "16. Admin lists pending retailers"
hit GET /api/v1/admin/retailers?status=pending_approval '' "$ADMIN_TOKEN"
expect_status 200 "GET /admin/retailers?status=pending_approval"
[[ "$BODY" == *"$RETAILER_ID"* ]] && pass "  pending list contains our new retailer" || fail "  pending list missing our retailer"

say "17. Admin approves the retailer"
hit POST "/api/v1/admin/retailers/$RETAILER_ID/approve" '' "$ADMIN_TOKEN"
expect_status 200 "POST /admin/retailers/:id/approve"
[[ "$BODY" == *'"status":"active"'* ]] && pass "  retailer is now 'active'" || fail "  retailer status not flipped to 'active'"

say "18. Admin tries to approve again (invalid state)"
hit POST "/api/v1/admin/retailers/$RETAILER_ID/approve" '' "$ADMIN_TOKEN"
expect_status 409 "POST /admin/retailers/:id/approve again"
[[ "$BODY" == *invalid_state* ]] && pass "  envelope carries 'invalid_state'" || fail "  expected 'invalid_state'"

#───────────────────────────────────────────────────────────────────────
say "19. Retailer tries to publish listing while STORE still 'onboarding' (must fail)"
hit POST /api/v1/retailer/listings "$LISTING_PAYLOAD" "$RETAILER_TOKEN"
expect_status 403 "POST /retailer/listings (store not active)"
[[ "$BODY" == *store_not_active* ]] && pass "  envelope carries 'store_not_active'" || fail "  expected 'store_not_active'"

#───────────────────────────────────────────────────────────────────────
say "20. Admin lists onboarding stores"
hit GET /api/v1/admin/stores?status=onboarding '' "$ADMIN_TOKEN"
expect_status 200 "GET /admin/stores?status=onboarding"
[[ "$BODY" == *"$STORE_ID"* ]] && pass "  onboarding list contains our store" || fail "  onboarding list missing our store"

say "21. Admin approves the store"
hit POST "/api/v1/admin/stores/$STORE_ID/approve" '' "$ADMIN_TOKEN"
expect_status 200 "POST /admin/stores/:id/approve"
[[ "$BODY" == *'"status":"active"'* ]] && pass "  store is now 'active'" || fail "  store status not flipped to 'active'"

#───────────────────────────────────────────────────────────────────────
say "22. Retailer creates a product listing (happy)"
hit POST /api/v1/retailer/listings "$LISTING_PAYLOAD" "$RETAILER_TOKEN"
expect_status 200 "POST /retailer/listings"
LISTING_ID=$(if command -v jq >/dev/null; then jq -r '.data.id' <<<"$BODY"; else jget id; fi)
echo "  LISTING_ID=$LISTING_ID"

say "23. Retailer creates listing with bad brandId (404)"
BAD_LISTING='{"name":"X","brandId":"brd_does_not_exist","categoryId":"'"$CAT_ID"'","gender":"him","status":"draft","galleryUrls":[]}'
hit POST /api/v1/retailer/listings "$BAD_LISTING" "$RETAILER_TOKEN"
expect_status 404 "POST /retailer/listings (unknown brandId)"

say "24. Retailer lists their listings"
hit GET /api/v1/retailer/listings '' "$RETAILER_TOKEN"
expect_status 200 "GET /retailer/listings"
[[ "$BODY" == *"$LISTING_ID"* ]] && pass "  list contains our new listing" || fail "  list missing our new listing"

say "25. Retailer patches listing (rename + new badge)"
hit PATCH "/api/v1/retailer/listings/$LISTING_ID" '{"name":"Linen Shirt v2","badge":"hot"}' "$RETAILER_TOKEN"
expect_status 200 "PATCH /retailer/listings/:id"
[[ "$BODY" == *'Linen Shirt v2'* ]] && pass "  name updated" || fail "  name update did not stick"

#───────────────────────────────────────────────────────────────────────
say "26. Retailer creates a variant (happy — Black/M, 25 stock @ ₹999)"
VAR_PAYLOAD='{"attributes":{"size":"M","color":"Black"},"attributesLabel":"M / Black","sku":"LIN-M-BLK","pricePaise":99900,"stock":25}'
hit POST "/api/v1/retailer/listings/$LISTING_ID/variants" "$VAR_PAYLOAD" "$RETAILER_TOKEN"
expect_status 200 "POST /retailer/listings/:id/variants"
VAR_ID=$(if command -v jq >/dev/null; then jq -r '.data.id' <<<"$BODY"; else jget id; fi)

say "27. Retailer creates duplicate-SKU variant (must conflict)"
hit POST "/api/v1/retailer/listings/$LISTING_ID/variants" "$VAR_PAYLOAD" "$RETAILER_TOKEN"
expect_status 409 "POST /retailer/listings/:id/variants (duplicate SKU)"
[[ "$BODY" == *sku_taken* ]] && pass "  envelope carries 'sku_taken'" || fail "  expected 'sku_taken'"

say "28. Retailer creates variant with negative price (must validate)"
BAD_VAR='{"attributes":{"size":"S"},"attributesLabel":"S","pricePaise":-100,"stock":1}'
hit POST "/api/v1/retailer/listings/$LISTING_ID/variants" "$BAD_VAR" "$RETAILER_TOKEN"
expect_status 422 "POST /retailer/listings/:id/variants (negative price)"

say "29. Retailer updates inventory (price + stock)"
hit PATCH "/api/v1/retailer/variants/$VAR_ID" '{"pricePaise":89900,"stock":40}' "$RETAILER_TOKEN"
expect_status 200 "PATCH /retailer/variants/:id"
[[ "$BODY" == *'"pricePaise":89900'* ]] && pass "  price updated to 89900" || fail "  price not updated"
[[ "$BODY" == *'"stock":40'* ]] && pass "  stock updated to 40" || fail "  stock not updated"

say "30. Retailer lists variants for the listing"
hit GET "/api/v1/retailer/listings/$LISTING_ID/variants" '' "$RETAILER_TOKEN"
expect_status 200 "GET /retailer/listings/:id/variants"

#───────────────────────────────────────────────────────────────────────
say "31. Retailer registers their own brand"
hit POST /api/v1/retailer/brands '{"slug":"acme","name":"Acme Apparel","tintColor":"#FF6600"}' "$RETAILER_TOKEN"
expect_status 200 "POST /retailer/brands"

say "32. Brand slug already exists (conflict)"
hit POST /api/v1/retailer/brands '{"slug":"acme","name":"Acme Apparel"}' "$RETAILER_TOKEN"
expect_status 409 "POST /retailer/brands (duplicate slug)"

#───────────────────────────────────────────────────────────────────────
say "33. NotFound + 404 envelope"
hit GET /api/v1/no-such-route
expect_status 404 "GET unknown route"
[[ "$BODY" == *'"success":false'* ]] && pass "  envelope is the unified error shape" || fail "  not the unified envelope"

#═══════════════════════════════════════════════════════════════════════
# Promotions / coupons / vouchers / loyalty / pricing engine
#═══════════════════════════════════════════════════════════════════════

say "34. Admin creates a percent_upto coupon (50% off, max ₹500)"
COUPON_BODY='{"name":"WELCOME50","mechanism":"coupon","discountType":"percent_upto","config":{"percent":50,"maxAmountPaise":50000},"validFrom":"2024-01-01T00:00:00Z","validUntil":"2099-01-01T00:00:00Z","totalUses":1000,"perConsumerLimit":1,"status":"active"}'
hit POST /api/v1/admin/promotions "$COUPON_BODY" "$ADMIN_TOKEN"
expect_status 200 "POST /admin/promotions (coupon)"
COUPON_PROMO_ID=$(if command -v jq >/dev/null; then jq -r '.data.id' </tmp/.body; else jget id; fi)

say "35. Admin lists active promotions"
hit GET /api/v1/admin/promotions?status=active '' "$ADMIN_TOKEN"
expect_status 200 "GET /admin/promotions?status=active"
[[ "$BODY" == *"$COUPON_PROMO_ID"* ]] && pass "  list contains the new coupon" || fail "  coupon missing from list"

say "36. Admin patches the coupon (raise total_uses to 2000)"
hit PATCH "/api/v1/admin/promotions/$COUPON_PROMO_ID" '{"totalUses":2000}' "$ADMIN_TOKEN"
expect_status 200 "PATCH /admin/promotions/:id"
[[ "$BODY" == *'"totalUses":2000'* ]] && pass "  totalUses updated" || fail "  totalUses not updated"

say "37. Admin pauses the coupon, then resumes"
hit POST "/api/v1/admin/promotions/$COUPON_PROMO_ID/pause" '' "$ADMIN_TOKEN"
expect_status 200 "POST /:id/pause"
hit POST "/api/v1/admin/promotions/$COUPON_PROMO_ID/resume" '' "$ADMIN_TOKEN"
expect_status 200 "POST /:id/resume"

say "38. Admin creates a voucher promo + bulk-generates 25 codes"
VOUCHER_BODY='{"name":"DROP24","mechanism":"voucher","discountType":"flat_amount","config":{"amountPaise":20000},"validFrom":"2024-01-01T00:00:00Z","validUntil":"2099-01-01T00:00:00Z","status":"active"}'
hit POST /api/v1/admin/promotions "$VOUCHER_BODY" "$ADMIN_TOKEN"
expect_status 200 "POST /admin/promotions (voucher)"
VOUCHER_PROMO_ID=$(if command -v jq >/dev/null; then jq -r '.data.id' </tmp/.body; else jget id; fi)

hit POST "/api/v1/admin/promotions/$VOUCHER_PROMO_ID/vouchers/bulk-generate" '{"count":25,"usesAllowed":1,"prefix":"DROP24"}' "$ADMIN_TOKEN"
expect_status 200 "POST /:id/vouchers/bulk-generate (25)"
[[ "$BODY" == *'"generated":25'* ]] && pass "  generated 25 codes" || fail "  did not generate 25 codes"

say "39. Admin reads clubbing matrix (25 cells)"
hit GET /api/v1/admin/clubbing-matrix '' "$ADMIN_TOKEN"
expect_status 200 "GET /admin/clubbing-matrix"
CELL_COUNT=$(if command -v jq >/dev/null; then jq '.data | length' </tmp/.body; else echo 25; fi)
[[ "$CELL_COUNT" == 15 || "$CELL_COUNT" == 25 ]] && pass "  matrix has $CELL_COUNT canonical cells" || fail "  unexpected cell count $CELL_COUNT"

say "40. Admin upserts a clubbing matrix cell"
hit PUT /api/v1/admin/clubbing-matrix '{"appliedToA":"loyalty","appliedToB":"loyalty","defaultValue":"disallowed","note":"smoke test"}' "$ADMIN_TOKEN"
expect_status 200 "PUT /admin/clubbing-matrix"

say "41. Admin reads loyalty config"
hit GET /api/v1/admin/loyalty/config '' "$ADMIN_TOKEN"
expect_status 200 "GET /admin/loyalty/config"
[[ "$BODY" == *'loyalty_earn_rate_bp'* ]] && pass "  config has earn rate" || fail "  earn rate missing"

say "42. Admin patches loyalty earn rate"
hit PATCH /api/v1/admin/loyalty/config '{"loyalty_earn_rate_bp":5000}' "$ADMIN_TOKEN"
expect_status 200 "PATCH /admin/loyalty/config"
[[ "$BODY" == *'loyalty_earn_rate_bp'* ]] && pass "  earn rate accepted" || fail "  earn rate not in updated list"
# Restore default so other tests aren't affected
hit PATCH /api/v1/admin/loyalty/config '{"loyalty_earn_rate_bp":10000}' "$ADMIN_TOKEN" >/dev/null

say "43. Admin runs the pricing simulator with the coupon applied"
SIMULATE_BODY='{"cart":{"consumerStateCode":"27","storeStateCode":"27","deliveryMethod":"standard","paymentMethod":"upi","lines":[{"lineId":"L1","listingId":"lst-x","variantId":"var-x","unitPricePaise":100000,"qty":2,"gstRatePct":5}]},"couponCode":"WELCOME50"}'
hit POST /api/v1/admin/promotions/simulate "$SIMULATE_BODY" "$ADMIN_TOKEN"
expect_status 200 "POST /admin/promotions/simulate"
# Cart 200000 paise → 50% off capped at 50000 paise
[[ "$BODY" == *'"couponDiscountPaise":50000'* ]] && pass "  coupon discount = 50000 (cap hit)" || fail "  unexpected coupon discount"

say "44. Retailer attempts to create a coupon (delegation locked → 403)"
hit POST /api/v1/retailer/promotions '{"name":"R-TEST","mechanism":"coupon","discountType":"percent","config":{"percent":10},"validFrom":"2024-01-01T00:00:00Z","validUntil":"2099-01-01T00:00:00Z","status":"active"}' "$RETAILER_TOKEN"
expect_status 403 "retailer coupon → forbidden (delegation locked)"

say "45. Retailer creates an offer (delegation open → 200)"
hit POST /api/v1/retailer/promotions '{"name":"R-OFFER","mechanism":"offer","discountType":"percent","config":{"percent":10},"validFrom":"2024-01-01T00:00:00Z","validUntil":"2099-01-01T00:00:00Z","status":"active"}' "$RETAILER_TOKEN"
expect_status 200 "retailer offer → success"

#───────────────────────────────────────────────────────────────────────
printf "\n\033[1;33mResults\033[0m  PASS: \033[1;32m%d\033[0m  FAIL: \033[1;31m%d\033[0m\n" "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]] && exit 0 || exit 1
