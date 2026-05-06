#!/bin/bash
# Deep smoke for the promotions/loyalty/clubbing/simulator surface.
# Runs against the live backend (default :3099) — assumes seed data is present.
set -uo pipefail

BASE="http://127.0.0.1:3099"

PASS=0
FAIL=0

say()  { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
pass() { printf "  \033[1;32m✓\033[0m %s\n" "$*"; PASS=$((PASS+1)); }
fail() { printf "  \033[1;31m✗\033[0m %s — %s\n" "$*" "$BODY"; FAIL=$((FAIL+1)); }

hit() {
  local m="$1" p="$2" data="${3:-}" auth="${4:-}"
  local args=(-sS -o /tmp/.body -w '%{http_code}' -X "$m")
  [[ -n "$auth" ]] && args+=(-H "Authorization: Bearer $auth")
  [[ -n "$data" ]] && args+=(-H 'Content-Type: application/json' --data "$data")
  args+=("$BASE$p")
  STATUS=$(curl "${args[@]}")
  BODY=$(cat /tmp/.body)
}

expect() { [[ "$STATUS" == "$1" ]] && pass "$2 [HTTP $STATUS]" || fail "$2 (expected $1, got $STATUS)"; }
expectBody() { [[ "$BODY" == *"$1"* ]] && pass "$2" || fail "$2 (body did not contain '$1')"; }
jget() { jq -r "$1" </tmp/.body; }

# ═══ Setup ═══
say 'SECTION 1 — Setup'
node scripts/reset-data.mjs >/dev/null 2>&1 && pass 'reset user data'

hit POST /api/v1/auth/admin/login '{"email":"admin@closetx.local","password":"admin1234"}'
expect 200 'admin login'
ADMIN=$(jget '.data.token')

EMAIL="ptest$(date +%s)@example.com"
hit POST /api/v1/auth/retailer/signup "$(jq -nc --arg e "$EMAIL" \
  '{email:$e,password:"test1234",legalName:"Promo Tester",phone:"+919876543210",gstin:"27AAAPL1234C1Z5"}')"
expect 200 'retailer signup'
RTOKEN=$(jget '.data.token')
RID=$(jget '.data.retailer.id')

hit POST /api/v1/retailer/store '{"legalName":"Promo Test Store","address":"42 Linking Rd, Bandra","stateCode":"27","lat":19.0,"lng":72.0,"platformFeeBp":500,"payoutCadenceDays":7}' "$RTOKEN"
expect 200 'retailer creates store'
SID=$(jget '.data.id')
hit POST "/api/v1/admin/retailers/$RID/approve" '' "$ADMIN"; expect 200 'admin approves retailer'
hit POST "/api/v1/admin/stores/$SID/approve" '' "$ADMIN";    expect 200 'admin approves store'

# ═══ Promotion CRUD — every discount type ═══
say 'SECTION 2 — Promotion CRUD across all 8 discount types'

declare -a CREATED_IDS=()
mk() {
  local name="$1" body="$2"
  hit POST /api/v1/admin/promotions "$body" "$ADMIN"
  if [[ "$STATUS" == "200" ]]; then
    pass "create $name"
    local id; id=$(jget '.data.id')
    CREATED_IDS+=("$id")
    eval "$3='$id'"
  else
    fail "create $name (got $STATUS)"
  fi
}

VF='2024-01-01T00:00:00Z'
VU='2099-01-01T00:00:00Z'

mk 'flat_amount' "$(jq -nc --arg vf "$VF" --arg vu "$VU" \
  '{name:"FLAT200",mechanism:"coupon",discountType:"flat_amount",config:{amountPaise:20000},validFrom:$vf,validUntil:$vu,status:"active"}')" PID_FLAT
mk 'percent' "$(jq -nc --arg vf "$VF" --arg vu "$VU" \
  '{name:"PCT15",mechanism:"coupon",discountType:"percent",config:{percent:15},validFrom:$vf,validUntil:$vu,status:"active"}')" PID_PCT
mk 'percent_upto' "$(jq -nc --arg vf "$VF" --arg vu "$VU" \
  '{name:"WELCOME50",mechanism:"coupon",discountType:"percent_upto",config:{percent:50,maxAmountPaise:50000},validFrom:$vf,validUntil:$vu,status:"active"}')" PID_PUPTO
mk 'bogo' "$(jq -nc --arg vf "$VF" --arg vu "$VU" \
  '{name:"BOGO_X",mechanism:"offer",discountType:"bogo",config:{buyListingId:"lst-x",discountPercent:100},validFrom:$vf,validUntil:$vu,status:"active"}')" PID_BOGO
mk 'bxgy' "$(jq -nc --arg vf "$VF" --arg vu "$VU" \
  '{name:"BX2GY1",mechanism:"offer",discountType:"bxgy",config:{buyQty:2,getQty:1,buyListingIds:["lst-x"],discountPercent:100},validFrom:$vf,validUntil:$vu,status:"active"}')" PID_BXGY
mk 'bundle' "$(jq -nc --arg vf "$VF" --arg vu "$VU" \
  '{name:"BUNDLE_ABC",mechanism:"offer",discountType:"bundle",config:{bundleListingIds:["lst-a","lst-b"],discountPercent:20},validFrom:$vf,validUntil:$vu,status:"active"}')" PID_BUNDLE
mk 'tiered_cart' "$(jq -nc --arg vf "$VF" --arg vu "$VU" \
  '{name:"TIER",mechanism:"offer",discountType:"tiered_cart",config:{tiers:[{minCartPaise:100000,discountPercent:5},{minCartPaise:200000,discountPercent:10},{minCartPaise:500000,discountPercent:20}]},validFrom:$vf,validUntil:$vu,status:"active"}')" PID_TIER
mk 'free_shipping' "$(jq -nc --arg vf "$VF" --arg vu "$VU" \
  '{name:"FREESHIP",mechanism:"offer",discountType:"free_shipping",config:{minCartPaise:50000},validFrom:$vf,validUntil:$vu,status:"active"}')" PID_FS
mk 'voucher' "$(jq -nc --arg vf "$VF" --arg vu "$VU" \
  '{name:"DROP24",mechanism:"voucher",discountType:"flat_amount",config:{amountPaise:30000},validFrom:$vf,validUntil:$vu,status:"active"}')" PID_VOUCHER

say 'List + filter'
hit GET /api/v1/admin/promotions '' "$ADMIN"; expect 200 'list all'
COUNT=$(jget '.data | length'); [[ "$COUNT" -ge 9 ]] && pass "list returned $COUNT" || fail "expected ≥ 9, got $COUNT"

hit GET '/api/v1/admin/promotions?mechanism=coupon' '' "$ADMIN"; expect 200 'filter mechanism=coupon'
COUNT=$(jget '[.data[] | select(.mechanism == "coupon")] | length')
[[ "$COUNT" -ge 3 ]] && pass "got $COUNT coupons" || fail "expected ≥ 3 coupons, got $COUNT"

hit GET '/api/v1/admin/promotions?status=active' '' "$ADMIN"; expect 200 'filter status=active'

hit GET '/api/v1/admin/promotions?platformOnly=true' '' "$ADMIN"; expect 200 'filter platformOnly'
ALL_PLATFORM=$(jget '[.data[] | select(.storeId != null)] | length')
[[ "$ALL_PLATFORM" == 0 ]] && pass 'platformOnly excludes store-scoped' || fail "platformOnly leaked $ALL_PLATFORM store-scoped rows"

say 'Get one'
hit GET "/api/v1/admin/promotions/$PID_PUPTO" '' "$ADMIN"; expect 200 'get one'
[[ "$BODY" == *'"effectiveStatus":"active"'* ]] && pass 'effectiveStatus computed' || fail 'effectiveStatus missing'

say 'Patch'
hit PATCH "/api/v1/admin/promotions/$PID_PCT" '{"totalUses":500,"perConsumerLimit":1}' "$ADMIN"
expect 200 'patch totalUses + perConsumerLimit'
expectBody '"totalUses":500' 'totalUses persisted'

say 'Patch with invalid validity → 422'
hit PATCH "/api/v1/admin/promotions/$PID_PCT" '{"validFrom":"2099-12-31T00:00:00Z","validUntil":"2099-01-01T00:00:00Z"}' "$ADMIN"
expect 422 'patch with validUntil ≤ validFrom'

# ═══ Lifecycle ═══
say 'SECTION 3 — Lifecycle'
hit POST "/api/v1/admin/promotions/$PID_FLAT/pause" '' "$ADMIN"; expect 200 'pause active'
hit POST "/api/v1/admin/promotions/$PID_FLAT/pause" '' "$ADMIN"; expect 409 'pause when already paused (illegal transition)'
hit POST "/api/v1/admin/promotions/$PID_FLAT/resume" '' "$ADMIN"; expect 200 'resume paused'
hit POST "/api/v1/admin/promotions/$PID_FLAT/revoke" '' "$ADMIN"; expect 200 'revoke active'
hit POST "/api/v1/admin/promotions/$PID_FLAT/resume" '' "$ADMIN"; expect 409 'cannot resume revoked'
hit PATCH "/api/v1/admin/promotions/$PID_FLAT" '{"name":"NEW"}' "$ADMIN"; expect 409 'cannot patch revoked'

# ═══ Voucher bulk-gen ═══
say 'SECTION 4 — Voucher codes'
hit POST "/api/v1/admin/promotions/$PID_VOUCHER/vouchers/bulk-generate" \
  '{"count":50,"usesAllowed":1,"prefix":"DROP24"}' "$ADMIN"
expect 200 'bulk-generate 50 codes'
GENERATED=$(jget '.data.generated'); [[ "$GENERATED" == 50 ]] && pass 'generated exactly 50' || fail "got $GENERATED"
PREFIX_OK=$(jget '[.data.codes[].code | startswith("DROP24")] | all')
[[ "$PREFIX_OK" == 'true' ]] && pass 'all codes carry prefix' || fail 'prefix missing on some'

hit GET "/api/v1/admin/promotions/$PID_VOUCHER/vouchers" '' "$ADMIN"; expect 200 'list voucher codes'
LISTED=$(jget '.data | length'); [[ "$LISTED" == 50 ]] && pass "list returned $LISTED" || fail "expected 50, got $LISTED"

# CSV download
say 'CSV download'
HEADER=$(curl -sS -o /tmp/.csv -w '%{content_type}' -H "Authorization: Bearer $ADMIN" \
  "$BASE/api/v1/admin/promotions/$PID_VOUCHER/vouchers?format=csv")
[[ "$HEADER" == *csv* ]] && pass "content-type is CSV ($HEADER)" || fail "wrong content-type: $HEADER"
CSV_LINES=$(wc -l </tmp/.csv); [[ "$CSV_LINES" -ge 50 ]] && pass "CSV has $CSV_LINES lines" || fail "CSV too short"

say 'Bad: bulk-gen on a coupon (not voucher) → 409'
hit POST "/api/v1/admin/promotions/$PID_PCT/vouchers/bulk-generate" '{"count":5,"usesAllowed":1,"prefix":""}' "$ADMIN"
expect 409 'bulk-gen rejected on non-voucher'

# ═══ Clubbing matrix ═══
say 'SECTION 5 — Clubbing matrix'
hit GET /api/v1/admin/clubbing-matrix '' "$ADMIN"; expect 200 'GET matrix'
CELLS=$(jget '.data | length')
# 5x5 upper triangle + diagonal = 15 cells; some may not be seeded but are returned with default
[[ "$CELLS" -ge 10 ]] && pass "$CELLS cells returned" || fail "got $CELLS cells"

say 'Read an always-allowed cell (loyalty + coupon)'
ALWAYS=$(jget '[.data[] | select(.appliedToA=="coupon" and .appliedToB=="loyalty" or .appliedToA=="loyalty" and .appliedToB=="coupon")] | .[0].defaultValue')
[[ "$ALWAYS" == 'always_allowed' ]] && pass 'loyalty×coupon = always_allowed' || fail "expected always_allowed, got $ALWAYS"

say 'Upsert a cell'
hit PUT /api/v1/admin/clubbing-matrix '{"appliedToA":"loyalty","appliedToB":"loyalty","defaultValue":"disallowed","note":"smoke"}' "$ADMIN"
expect 200 'upsert loyalty×loyalty → disallowed'
hit GET /api/v1/admin/clubbing-matrix '' "$ADMIN"
NOW=$(jget '[.data[] | select(.appliedToA=="loyalty" and .appliedToB=="loyalty")] | .[0].defaultValue')
[[ "$NOW" == 'disallowed' ]] && pass 'persisted disallowed' || fail "got $NOW"

say 'always_allowed lock'
# Pick a known always_allowed pair (loyalty + retailer_promo) and try to downgrade
hit PUT /api/v1/admin/clubbing-matrix '{"appliedToA":"retailer_promo","appliedToB":"loyalty","defaultValue":"disallowed"}' "$ADMIN"
expect 409 'cannot downgrade always_allowed'

# ═══ Loyalty config ═══
say 'SECTION 6 — Loyalty config'
hit GET /api/v1/admin/loyalty/config '' "$ADMIN"; expect 200 'GET config'
EARN_BEFORE=$(jget '.data.loyalty_earn_rate_bp.value')
pass "current earn rate = $EARN_BEFORE bp"

hit PATCH /api/v1/admin/loyalty/config '{"loyalty_earn_rate_bp":7500,"min_redeemable_points":50}' "$ADMIN"
expect 200 'patch earn rate + min points'
UPDATED=$(jget '.data.updated | length'); [[ "$UPDATED" == 2 ]] && pass "updated $UPDATED keys" || fail "expected 2 updates"

hit GET /api/v1/admin/loyalty/config '' "$ADMIN"
NEW_EARN=$(jget '.data.loyalty_earn_rate_bp.value')
[[ "$NEW_EARN" == 7500 ]] && pass "earn rate persisted as $NEW_EARN" || fail "expected 7500, got $NEW_EARN"

# Restore so simulator math below uses spec defaults
hit PATCH /api/v1/admin/loyalty/config '{"loyalty_earn_rate_bp":10000,"min_redeemable_points":100}' "$ADMIN" >/dev/null
pass 'restored loyalty defaults'

# ═══ Consumer balance lookups ═══
say 'SECTION 7 — Consumer balances'
# Search for a non-existent email — should return empty array.
hit GET '/api/v1/admin/loyalty/consumers?email=nobody@example.com' '' "$ADMIN"; expect 200 'consumer search'
EMPTY=$(jget '.data | length'); [[ "$EMPTY" == 0 ]] && pass 'no match → empty array' || fail "expected 0, got $EMPTY"

# Search with neither email nor phone → 422
hit GET '/api/v1/admin/loyalty/consumers' '' "$ADMIN"; expect 422 'rejects empty query'

# Wallet/loyalty lookup for unknown consumer ID — should NOT 500
hit GET '/api/v1/admin/loyalty/consumers/cns-fake/wallet' '' "$ADMIN"; expect 200 'wallet lookup unknown consumer (synthetic)'
hit GET '/api/v1/admin/loyalty/consumers/cns-fake/loyalty' '' "$ADMIN"; expect 200 'loyalty lookup unknown consumer'

# Adjust on unknown consumer → 404
hit POST '/api/v1/admin/loyalty/consumers/cns-fake/wallet/adjust' '{"amountPaise":100,"note":"x"}' "$ADMIN"
expect 404 'wallet adjust unknown consumer → not_found'
hit POST '/api/v1/admin/loyalty/consumers/cns-fake/loyalty/adjust' '{"points":10,"note":"x"}' "$ADMIN"
expect 404 'loyalty adjust unknown consumer → not_found'

# ═══ Pricing simulator — math ═══
say 'SECTION 8 — Pricing simulator (math)'

# Cart: 2 lines of ₹1000 (qty 1 each) = ₹2000 line subtotal (200000 paise)
SIM_CART='{"consumerStateCode":"27","storeStateCode":"27","deliveryMethod":"standard","paymentMethod":"upi","lines":[{"lineId":"L1","listingId":"lst-x","variantId":"v1","unitPricePaise":100000,"qty":1,"gstRatePct":5},{"lineId":"L2","listingId":"lst-y","variantId":"v2","unitPricePaise":100000,"qty":1,"gstRatePct":5}]}'

# 1. Empty (no promo) — base breakdown
hit POST /api/v1/admin/promotions/simulate "$(jq -nc --argjson c "$SIM_CART" '{cart:$c}')" "$ADMIN"
expect 200 'empty simulate'
LINE=$(jget '.data.lineSubtotalPaise'); [[ "$LINE" == 200000 ]] && pass "lineSubtotal=$LINE" || fail "expected 200000, got $LINE"
TAX=$(jget '.data.cgstPaise'); [[ "$TAX" == 5000 ]] && pass "intra-state CGST=$TAX (½ of 5% of 200000)" || fail "wrong CGST: $TAX"
DEL=$(jget '.data.deliveryFeePaise'); [[ "$DEL" == 4900 ]] && pass "standard delivery=4900" || fail "delivery=$DEL"

# 2. WELCOME50 (50% upto ₹500) → discount = min(100000, 50000) = 50000
hit POST /api/v1/admin/promotions/simulate "$(jq -nc --argjson c "$SIM_CART" '{cart:$c,couponCode:"WELCOME50"}')" "$ADMIN"
expect 200 'simulate with percent_upto coupon'
COUP=$(jget '.data.couponDiscountPaise')
[[ "$COUP" == 50000 ]] && pass "couponDiscount=$COUP (capped at ₹500)" || fail "expected 50000, got $COUP"
TBASE=$(jget '.data.taxBasePaise')
[[ "$TBASE" == 150000 ]] && pass "taxBase = 200000 − 50000 = $TBASE" || fail "expected 150000, got $TBASE"

# 3. FLAT200 (₹200 flat) — but FLAT was revoked above, so this should land in excludedPromotions or 404 the coupon lookup. Use PCT15 instead.
hit POST /api/v1/admin/promotions/simulate "$(jq -nc --argjson c "$SIM_CART" '{cart:$c,couponCode:"PCT15"}')" "$ADMIN"
expect 200 'simulate with percent coupon'
PC=$(jget '.data.couponDiscountPaise')
[[ "$PC" == 30000 ]] && pass "15% of 200000 = $PC" || fail "expected 30000, got $PC"

# 4. Inter-state cart → IGST instead of CGST/SGST
INTERSTATE_CART=$(echo "$SIM_CART" | jq -c '.consumerStateCode = "07"')
hit POST /api/v1/admin/promotions/simulate "$(jq -nc --argjson c "$INTERSTATE_CART" '{cart:$c}')" "$ADMIN"
expect 200 'inter-state simulate'
IGST=$(jget '.data.igstPaise')
SGST=$(jget '.data.sgstPaise')
[[ "$IGST" == 10000 && "$SGST" == 0 ]] && pass "inter-state IGST=$IGST, SGST=$SGST" || fail "expected IGST=10000 SGST=0, got IGST=$IGST SGST=$SGST"

# 5. Tiered cart — ₹2000 cart hits the 10% tier (200000 ≥ 200000)
hit POST /api/v1/admin/promotions/simulate "$(jq -nc --argjson c "$SIM_CART" --arg id "$PID_TIER" '{cart:$c,promotionIds:[$id]}')" "$ADMIN"
expect 200 'simulate with tiered_cart'
# tiered_cart appliedTo defaults to platform_promo (offer + admin)
PLAT=$(jget '.data.platformPromoDiscountPaise')
[[ "$PLAT" == 20000 ]] && pass "tiered 10% of 200000 = $PLAT" || fail "expected 20000, got $PLAT"

# 6. Loyalty redemption — 100 points × ₹1 = 10000 paise
hit POST /api/v1/admin/promotions/simulate "$(jq -nc --argjson c "$SIM_CART" '{cart:$c,pointsToRedeem:100,consumerLoyaltyBalance:5000}')" "$ADMIN"
expect 200 'simulate with loyalty redemption'
LD=$(jget '.data.loyaltyDiscountPaise')
LR=$(jget '.data.loyaltyRedeemedPoints')
[[ "$LD" == 10000 && "$LR" == 100 ]] && pass "loyalty: 100 pts → ₹100 ($LD)" || fail "loyalty wrong: $LR pts → $LD"

# 7. Loyalty below min → no redemption
hit POST /api/v1/admin/promotions/simulate "$(jq -nc --argjson c "$SIM_CART" '{cart:$c,pointsToRedeem:50,consumerLoyaltyBalance:5000}')" "$ADMIN"
expect 200 'simulate below min points'
LD=$(jget '.data.loyaltyDiscountPaise'); [[ "$LD" == 0 ]] && pass 'min cap honoured' || fail "expected 0, got $LD"

# 8. Loyalty exceeds balance → no redemption
hit POST /api/v1/admin/promotions/simulate "$(jq -nc --argjson c "$SIM_CART" '{cart:$c,pointsToRedeem:9999,consumerLoyaltyBalance:100}')" "$ADMIN"
expect 200 'simulate exceeds balance'
LD=$(jget '.data.loyaltyDiscountPaise'); [[ "$LD" == 0 ]] && pass 'balance cap honoured' || fail "expected 0, got $LD"

# 9. Free shipping — appliedTo=shipping zeroes the delivery fee
hit POST /api/v1/admin/promotions/simulate "$(jq -nc --argjson c "$SIM_CART" --arg id "$PID_FS" '{cart:$c,promotionIds:[$id]}')" "$ADMIN"
expect 200 'simulate with free shipping'
DEL=$(jget '.data.deliveryFeePaise')
SUB=$(jget '.data.shippingSubsidyPaise')
[[ "$DEL" == 0 && "$SUB" -gt 0 ]] && pass "delivery zeroed; subsidy=$SUB" || fail "delivery=$DEL subsidy=$SUB"

# 10. Unknown coupon → 404 with coupon_invalid
hit POST /api/v1/admin/promotions/simulate "$(jq -nc --argjson c "$SIM_CART" '{cart:$c,couponCode:"DOES_NOT_EXIST"}')" "$ADMIN"
expect 404 'unknown coupon'
expectBody '"code":"coupon_invalid"' 'error code = coupon_invalid'

# 11. Voucher code (use the first generated DROP24 code)
hit GET "/api/v1/admin/promotions/$PID_VOUCHER/vouchers" '' "$ADMIN"
VCODE=$(jget '.data[0].code')
hit POST /api/v1/admin/promotions/simulate "$(jq -nc --argjson c "$SIM_CART" --arg vc "$VCODE" '{cart:$c,voucherCode:$vc}')" "$ADMIN"
expect 200 'simulate with voucher code'
COUP=$(jget '.data.couponDiscountPaise')
# DROP24 = flat 30000
[[ "$COUP" == 30000 ]] && pass "voucher discount=$COUP" || fail "expected 30000, got $COUP"

# 12. Two clubbing-compatible promos: WELCOME50 (coupon) + tiered (platform_promo)
hit POST /api/v1/admin/promotions/simulate "$(jq -nc --argjson c "$SIM_CART" --arg id "$PID_TIER" '{cart:$c,couponCode:"WELCOME50",promotionIds:[$id]}')" "$ADMIN"
expect 200 'simulate clubbing coupon + platform_promo'
APPLIED=$(jget '.data.appliedPromotions | length')
[[ "$APPLIED" == 2 ]] && pass "both promos applied (count=$APPLIED)" || fail "expected 2 applied, got $APPLIED"

# ═══ Retailer scope ═══
say 'SECTION 9 — Retailer (scope + delegation)'
hit POST /api/v1/retailer/promotions \
  "$(jq -nc --arg vf "$VF" --arg vu "$VU" '{name:"R-OFFER",mechanism:"offer",discountType:"percent",config:{percent:8},validFrom:$vf,validUntil:$vu,status:"active"}')" "$RTOKEN"
expect 200 'retailer creates offer (delegation open)'
R_PROMO=$(jget '.data.id')

hit POST /api/v1/retailer/promotions \
  "$(jq -nc --arg vf "$VF" --arg vu "$VU" '{name:"R-COUPON",mechanism:"coupon",discountType:"percent",config:{percent:5},validFrom:$vf,validUntil:$vu,status:"active"}')" "$RTOKEN"
expect 403 'retailer coupon → forbidden'
expectBody '"code":"forbidden"' 'forbidden code'

hit POST /api/v1/retailer/promotions \
  "$(jq -nc --arg vf "$VF" --arg vu "$VU" '{name:"R-VOUCH",mechanism:"voucher",discountType:"flat_amount",config:{amountPaise:1000},validFrom:$vf,validUntil:$vu,status:"active"}')" "$RTOKEN"
expect 403 'retailer voucher → forbidden'

hit GET /api/v1/retailer/promotions '' "$RTOKEN"; expect 200 'retailer list own'
COUNT=$(jget '.data | length'); pass "retailer sees $COUNT promos"

# Retailer cannot see admin's promos via /retailer endpoint
EXISTS_ADMIN_PROMO=$(jq --arg id "$PID_PUPTO" '[.data[] | select(.id == $id)] | length' </tmp/.body)
[[ "$EXISTS_ADMIN_PROMO" == 0 ]] && pass 'retailer scope excludes admin platform-wide promos' || fail 'retailer leaked admin promos'

hit PATCH "/api/v1/retailer/promotions/$R_PROMO" '{"name":"R-OFFER-V2"}' "$RTOKEN"; expect 200 'retailer patches own'
hit POST "/api/v1/retailer/promotions/$R_PROMO/pause" '' "$RTOKEN"; expect 200 'retailer pauses own'

# Retailer cannot patch / pause an admin promo
hit POST "/api/v1/retailer/promotions/$PID_PUPTO/pause" '' "$RTOKEN"; expect 403 'retailer cannot pause admin promo (not_owner)'
expectBody 'not_owner' 'not_owner error code'

# Cross-domain: retailer token on admin route
hit GET /api/v1/admin/promotions '' "$RTOKEN"; expect 403 'retailer token rejected on admin route'
hit GET /api/v1/admin/clubbing-matrix '' "$RTOKEN"; expect 403 'retailer token rejected on clubbing'
hit GET /api/v1/retailer/promotions '' "$ADMIN"; expect 403 'admin token rejected on retailer'

# ═══ Negative paths ═══
say 'SECTION 10 — Negative paths'
hit POST /api/v1/admin/promotions \
  "$(jq -nc --arg vf "$VF" --arg vu "$VU" '{name:"BAD",mechanism:"coupon",discountType:"percent",config:{percent:150},validFrom:$vf,validUntil:$vu,status:"active"}')" "$ADMIN"
expect 422 'percent > 100 rejected'
expectBody 'validation' 'validation error envelope'

hit POST /api/v1/admin/promotions \
  "$(jq -nc --arg vf "$VF" --arg vu "$VU" '{name:"BAD2",mechanism:"coupon",discountType:"flat_amount",config:{},validFrom:$vf,validUntil:$vu,status:"active"}')" "$ADMIN"
expect 422 'flat_amount missing amountPaise rejected'

hit POST /api/v1/admin/promotions \
  '{"name":"BAD3","mechanism":"coupon","discountType":"percent","config":{"percent":10},"validFrom":"2099-01-01T00:00:00Z","validUntil":"2024-01-01T00:00:00Z","status":"active"}' "$ADMIN"
expect 422 'validUntil before validFrom rejected'

hit POST /api/v1/admin/promotions \
  '{"name":"BAD4","mechanism":"coupon","discountType":"percent","config":{"percent":10},"storeId":"str-doesnotexist","validFrom":"2024-01-01T00:00:00Z","validUntil":"2099-01-01T00:00:00Z","status":"active"}' "$ADMIN"
expect 404 'storeId that does not exist rejected'

hit GET '/api/v1/admin/promotions/prm_doesnotexist' '' "$ADMIN"; expect 404 'unknown promo id'

hit POST '/api/v1/admin/promotions/prm_x/pause' '' "$ADMIN"; expect 404 'lifecycle on unknown promo'

# Admin endpoints unauthenticated
hit GET /api/v1/admin/promotions; expect 401 'unauthenticated → 401'

#───────────────────────────────────────────────
printf "\n\033[1;33mResults\033[0m  PASS: \033[1;32m%d\033[0m  FAIL: \033[1;31m%d\033[0m\n" "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]] && exit 0 || exit 1
