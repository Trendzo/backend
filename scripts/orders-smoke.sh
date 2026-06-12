#!/bin/bash
# Order-flow smoke. Runs against the live backend (default :3099). Builds: a fresh
# retailer + store + listing + variant, then walks an order through the full standard-
# delivery state machine via the admin "place test order" surface and the retailer
# accept/pack/handover/depart/mark-delivered actions.
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
jget()   { jq -r "$1" </tmp/.body; }

# ═══ Setup ═══
say 'SECTION 1 — Setup (reset, login, fresh retailer + store + listing + variant)'
node scripts/reset-data.mjs >/dev/null 2>&1 && pass 'reset user data'

hit POST /api/v1/auth/admin/login '{"email":"admin@trendzo.local","password":"admin1234"}'
expect 200 'admin login'
ADMIN=$(jget '.data.token')

hit GET /api/v1/catalog/categories '' "$ADMIN"; CAT_ID=$(jget '.data[0].id')
hit GET /api/v1/catalog/brands '' "$ADMIN";    BRAND_ID=$(jget '.data[0].id')

EMAIL="ord$(date +%s)@example.com"
hit POST /api/v1/auth/retailer/signup "$(jq -nc --arg e "$EMAIL" \
  '{email:$e,password:"test1234",legalName:"Order Tester","phone":"+919876543210","gstin":"27AAAPL1234C1Z5"}')"
expect 200 'retailer signup'
RTOKEN=$(jget '.data.token')
RID=$(jget '.data.retailer.id')

hit POST /api/v1/retailer/store '{"legalName":"Order Test Store","address":"42 Linking Rd","stateCode":"27","lat":19.0,"lng":72.0,"platformFeeBp":500,"payoutCadenceDays":7}' "$RTOKEN"
expect 200 'retailer creates store'
SID=$(jget '.data.id')

hit POST "/api/v1/admin/retailers/$RID/approve" '' "$ADMIN"; expect 200 'admin approves retailer'
hit POST "/api/v1/admin/stores/$SID/approve" ''   "$ADMIN"; expect 200 'admin approves store'

# Re-login to refresh retailer token now that account is active.
hit POST /api/v1/auth/retailer/login "$(jq -nc --arg e "$EMAIL" '{email:$e,password:"test1234"}')"
RTOKEN=$(jget '.data.token')

LIST_PAYLOAD=$(jq -nc --arg b "$BRAND_ID" --arg c "$CAT_ID" \
  '{name:"Test Tee",brandId:$b,categoryId:$c,gender:"unisex",badge:"none",listingPolicy:"return",galleryUrls:[],hsn:"6109",status:"active"}')
hit POST /api/v1/retailer/listings "$LIST_PAYLOAD" "$RTOKEN"
expect 200 'create listing'
LID=$(jget '.data.id')

VAR_PAYLOAD='{"attributes":{"size":"M"},"attributesLabel":"M","sku":"TT-M","pricePaise":99900,"stock":10}'
hit POST "/api/v1/retailer/listings/$LID/variants" "$VAR_PAYLOAD" "$RTOKEN"
expect 200 'create variant'
VID=$(jget '.data.id')

# ═══ Test consumer ═══
say 'SECTION 2 — Mint a test consumer + default address'
hit POST /api/v1/admin/consumers/test "$(jq -nc --arg s "$SID" '{storeId:$s,legalName:"Smoke Buyer"}')" "$ADMIN"
expect 200 'mint test consumer'
CID=$(jget '.data.consumer.id')
ADDR_ID=$(jget '.data.addressId')

# ═══ Place order with paymentOutcome=succeeded → routing ═══
say 'SECTION 3 — Place test order (paymentOutcome=succeeded)'
PLACE_PAYLOAD=$(jq -nc --arg s "$SID" --arg c "$CID" --arg a "$ADDR_ID" --arg v "$VID" \
  '{storeId:$s,consumerId:$c,addressId:$a,items:[{variantId:$v,qty:2}],deliveryMethod:"standard",paymentMethod:"upi",paymentOutcome:"succeeded"}')
hit POST /api/v1/admin/test-orders "$PLACE_PAYLOAD" "$ADMIN"
expect 200 'place test order (succeeded)'
OID=$(jget '.data.orderId')
GID=$(jget '.data.groupId')
[[ "$(jget '.data.status')" == "routing" ]] && pass 'order is in routing' || fail 'expected routing'

# ═══ Verify variant.reserved went up by 2 ═══
say 'SECTION 4 — Stock reservation'
hit GET "/api/v1/retailer/listings/$LID/variants" '' "$RTOKEN"
RESERVED=$(jget '.data[0].reserved')
[[ "$RESERVED" == "2" ]] && pass "variant.reserved=$RESERVED" || fail "expected 2, got $RESERVED"

# ═══ Retailer sees the order ═══
say 'SECTION 5 — Retailer sees the order in their list'
hit GET '/api/v1/retailer/orders?status=routing' '' "$RTOKEN"
expect 200 'list routing orders'
LISTED=$(jget '[.data[] | select(.id==$OID)] | length' --arg OID "$OID" 2>/dev/null || jget '.data | length')
[[ "$LISTED" -ge 1 ]] && pass "retailer sees $LISTED routing order(s)" || fail "expected ≥ 1"

# ═══ Walk the happy path ═══
say 'SECTION 6 — Happy path: accept → pack → handover → depart → mark delivered'
hit POST "/api/v1/retailer/orders/$OID/accept" '' "$RTOKEN"; expect 200 'accept'
[[ "$(jget '.data.toStatus')" == 'accepted' ]] && pass 'now accepted' || fail 'not accepted'

hit POST "/api/v1/retailer/orders/$OID/pack" '' "$RTOKEN"; expect 200 'pack'
[[ "$(jget '.data.toStatus')" == 'packed' ]] && pass 'now packed' || fail 'not packed'

hit POST "/api/v1/retailer/orders/$OID/handover" '{"agentName":"Ravi","agentPhone":"+919998887776"}' "$RTOKEN"
expect 200 'handover'
[[ "$(jget '.data.toStatus')" == 'picked_up' ]] && pass 'now picked_up' || fail 'not picked_up'

hit POST "/api/v1/retailer/orders/$OID/depart" '' "$RTOKEN"; expect 200 'depart'
[[ "$(jget '.data.toStatus')" == 'out_for_delivery' ]] && pass 'now out_for_delivery' || fail 'not OFD'

hit POST "/api/v1/retailer/orders/$OID/mark-delivered" '{"note":"Smoke handover"}' "$RTOKEN"
expect 200 'mark delivered'
[[ "$(jget '.data.toStatus')" == 'delivered' ]] && pass 'now delivered' || fail 'not delivered'

# ═══ Stock should now be decremented ═══
say 'SECTION 7 — Stock finalised on delivery'
hit GET "/api/v1/retailer/listings/$LID/variants" '' "$RTOKEN"
STOCK_AFTER=$(jget '.data[0].stock')
RESERVED_AFTER=$(jget '.data[0].reserved')
[[ "$STOCK_AFTER" == "8" ]] && pass "stock decremented to 8" || fail "expected stock=8, got $STOCK_AFTER"
[[ "$RESERVED_AFTER" == "0" ]] && pass "reserved back to 0" || fail "expected reserved=0, got $RESERVED_AFTER"

# ═══ Detail page shows transitions ═══
say 'SECTION 8 — Audit trail'
hit GET "/api/v1/admin/orders/$OID" '' "$ADMIN"
expect 200 'admin order detail'
TRANS_COUNT=$(jget '.data.transitions | length')
[[ "$TRANS_COUNT" -ge 6 ]] && pass "$TRANS_COUNT transitions logged" || fail "expected ≥ 6 transitions, got $TRANS_COUNT"

GROUP_STATUS=$(jget '.data.group.status')
[[ "$GROUP_STATUS" == 'all_delivered' ]] && pass 'group rollup = all_delivered' || fail "got group=$GROUP_STATUS"

# ═══ Idempotency replay ═══
say 'SECTION 9 — Idempotency: replay returns same order'
IDEM="ik-smoke-$(date +%s)"
PLACE2=$(jq -nc --arg s "$SID" --arg c "$CID" --arg a "$ADDR_ID" --arg v "$VID" --arg k "$IDEM" \
  '{storeId:$s,consumerId:$c,addressId:$a,items:[{variantId:$v,qty:1}],deliveryMethod:"standard",paymentMethod:"upi",paymentOutcome:"succeeded",idempotencyKey:$k}')
hit POST /api/v1/admin/test-orders "$PLACE2" "$ADMIN"; expect 200 'first placement'
OID_A=$(jget '.data.orderId')
hit POST /api/v1/admin/test-orders "$PLACE2" "$ADMIN"; expect 200 'replay placement'
OID_B=$(jget '.data.orderId')
ALREADY=$(jget '.data.alreadyExisted')
[[ "$OID_A" == "$OID_B" ]] && pass 'same order id returned' || fail "id changed: $OID_A vs $OID_B"
[[ "$ALREADY" == 'true' ]]   && pass 'flag alreadyExisted=true' || fail "expected alreadyExisted=true"

# ═══ Failed payment ═══
say 'SECTION 10 — paymentOutcome=failed → payment_failed'
PLACE_FAIL=$(jq -nc --arg s "$SID" --arg c "$CID" --arg a "$ADDR_ID" --arg v "$VID" \
  '{storeId:$s,consumerId:$c,addressId:$a,items:[{variantId:$v,qty:1}],deliveryMethod:"standard",paymentMethod:"upi",paymentOutcome:"failed"}')
hit POST /api/v1/admin/test-orders "$PLACE_FAIL" "$ADMIN"; expect 200 'place (failed payment)'
OID_F=$(jget '.data.orderId')
[[ "$(jget '.data.status')" == 'payment_failed' ]] && pass 'order is payment_failed' || fail "expected payment_failed"

# ═══ Cancellation ═══
say 'SECTION 11 — Admin cancels an accepted order; reserved stock released'
PLACE_CANCEL=$(jq -nc --arg s "$SID" --arg c "$CID" --arg a "$ADDR_ID" --arg v "$VID" \
  '{storeId:$s,consumerId:$c,addressId:$a,items:[{variantId:$v,qty:3}],deliveryMethod:"standard",paymentMethod:"upi",paymentOutcome:"succeeded"}')
hit POST /api/v1/admin/test-orders "$PLACE_CANCEL" "$ADMIN"; expect 200 'place to cancel'
OID_C=$(jget '.data.orderId')
hit POST "/api/v1/retailer/orders/$OID_C/accept" '' "$RTOKEN"; expect 200 'accept (to-cancel order)'

hit GET "/api/v1/retailer/listings/$LID/variants" '' "$RTOKEN"
RESERVED_BEFORE=$(jget '.data[0].reserved')
# Expect 5: 1 from section 9 (idempotent succeeded order, never delivered) + 1 from section 10 (payment_failed
# order that still reserved at placement) + 3 from this section's order.
[[ "$RESERVED_BEFORE" == "5" ]] && pass "reserved=5 before cancel (residual from sections 9+10 plus 3 here)" \
  || fail "expected 5, got $RESERVED_BEFORE"

hit POST "/api/v1/admin/orders/$OID_C/cancel" '{"reason":"Test cancellation from smoke"}' "$ADMIN"; expect 200 'admin cancels'
hit GET "/api/v1/admin/orders/$OID_C" '' "$ADMIN"
[[ "$(jget '.data.status')" == 'cancelled' ]] && pass 'order cancelled' || fail 'not cancelled'

hit GET "/api/v1/retailer/listings/$LID/variants" '' "$RTOKEN"
RESERVED_REL=$(jget '.data[0].reserved')
# 5 - 3 (from this cancellation) = 2 (residuals from sections 9 + 10 still held)
[[ "$RESERVED_REL" == "2" ]] && pass "reserved -3 (back to 2 residual)" || fail "expected 2, got $RESERVED_REL"

# ═══ Cross-domain auth boundary ═══
say 'SECTION 12 — Cross-domain auth boundary'
hit GET '/api/v1/admin/orders' '' "$RTOKEN"; expect 403 'retailer cannot list admin orders'
hit GET "/api/v1/retailer/orders" '' "$ADMIN"; expect 403 'admin cannot list retailer orders'

# ═══ Out-of-stock ═══
say 'SECTION 13 — Out-of-stock rejection'
PLACE_OOS=$(jq -nc --arg s "$SID" --arg c "$CID" --arg a "$ADDR_ID" --arg v "$VID" \
  '{storeId:$s,consumerId:$c,addressId:$a,items:[{variantId:$v,qty:9999}],deliveryMethod:"standard",paymentMethod:"upi",paymentOutcome:"succeeded"}')
hit POST /api/v1/admin/test-orders "$PLACE_OOS" "$ADMIN"
expect 409 'reject overdraft'
[[ "$BODY" == *order_stock_unavailable* ]] && pass 'envelope carries order_stock_unavailable' || fail 'expected order_stock_unavailable'

# ═══ Try-and-Buy door visit ═══
say 'SECTION 14 — Try-and-Buy door visit'
# Need 3 quantities of stock for this scenario.
hit PATCH "/api/v1/retailer/listings/$LID/variants/$VID" '{"stock":20}' "$RTOKEN" 2>/dev/null
# (Ignore — endpoint may not exist; we have plenty of stock anyway.)
PLACE_TNB=$(jq -nc --arg s "$SID" --arg c "$CID" --arg a "$ADDR_ID" --arg v "$VID" \
  '{storeId:$s,consumerId:$c,addressId:$a,items:[{variantId:$v,qty:3}],deliveryMethod:"try_and_buy",paymentMethod:"upi",paymentOutcome:"succeeded"}')
hit POST /api/v1/admin/test-orders "$PLACE_TNB" "$ADMIN"
expect 200 'place try_and_buy order'
TNB_OID=$(jget '.data.orderId')

# Walk to out_for_delivery
hit POST "/api/v1/retailer/orders/$TNB_OID/accept" '' "$RTOKEN"; expect 200 'tnb accept'
hit POST "/api/v1/retailer/orders/$TNB_OID/pack" '' "$RTOKEN"; expect 200 'tnb pack'
hit POST "/api/v1/retailer/orders/$TNB_OID/handover" '{}' "$RTOKEN"; expect 200 'tnb handover'
hit POST "/api/v1/retailer/orders/$TNB_OID/depart" '' "$RTOKEN"; expect 200 'tnb depart'

# Open door
hit POST "/api/v1/admin/orders/$TNB_OID/door/open" '' "$ADMIN"; expect 200 'open door'
[[ "$(jget '.data.toStatus')" == 'at_door' ]] && pass 'order at_door' || fail 'expected at_door'

# Extend (one-shot)
hit POST "/api/v1/admin/orders/$TNB_OID/door/extend" '{"reason":"Customer needs 5 more min"}' "$ADMIN"
expect 200 'extend door once'
hit POST "/api/v1/admin/orders/$TNB_OID/door/extend" '{"reason":"Trying again"}' "$ADMIN"
expect 409 'extend twice rejected'
[[ "$BODY" == *door_visit_extension_exhausted* ]] && pass 'envelope carries extension_exhausted' || fail 'wrong code'

# Get the order_item id we created (only one item; qty=3 stays as one row).
hit GET "/api/v1/admin/orders/$TNB_OID" '' "$ADMIN"
ITEM_ID=$(jget '.data.items[0].id')

# Close door — mark the single item as 'returned'.
CLOSE_BODY=$(jq -nc --arg i "$ITEM_ID" '{items:[{orderItemId:$i,decision:"returned",reason:"Wrong size"}]}')
hit POST "/api/v1/admin/orders/$TNB_OID/door/close" "$CLOSE_BODY" "$ADMIN"
expect 200 'close door (all returned)'
[[ "$(jget '.data.toStatus')" == 'returning_to_store' ]] && pass 'order returning_to_store (no kept)' || fail 'expected returning_to_store'
RETURN_COUNT=$(jget '.data.returnIds | length')
[[ "$RETURN_COUNT" == 1 ]] && pass 'one return row created' || fail "expected 1 return row, got $RETURN_COUNT"
DOOR_RETURN_ID=$(jget '.data.returnIds[0]')

# A new TnB order to test the kept-some path.
PLACE_TNB2=$(jq -nc --arg s "$SID" --arg c "$CID" --arg a "$ADDR_ID" --arg v "$VID" \
  '{storeId:$s,consumerId:$c,addressId:$a,items:[{variantId:$v,qty:1}],deliveryMethod:"try_and_buy",paymentMethod:"upi",paymentOutcome:"succeeded"}')
hit POST /api/v1/admin/test-orders "$PLACE_TNB2" "$ADMIN"; expect 200 'tnb #2 place'
TNB2_OID=$(jget '.data.orderId')
hit POST "/api/v1/retailer/orders/$TNB2_OID/accept" '' "$RTOKEN" >/dev/null
hit POST "/api/v1/retailer/orders/$TNB2_OID/pack" '' "$RTOKEN" >/dev/null
hit POST "/api/v1/retailer/orders/$TNB2_OID/handover" '{}' "$RTOKEN" >/dev/null
hit POST "/api/v1/retailer/orders/$TNB2_OID/depart" '' "$RTOKEN" >/dev/null
hit POST "/api/v1/admin/orders/$TNB2_OID/door/open" '' "$ADMIN" >/dev/null
hit GET "/api/v1/admin/orders/$TNB2_OID" '' "$ADMIN"
ITEM2_ID=$(jget '.data.items[0].id')
CLOSE2_BODY=$(jq -nc --arg i "$ITEM2_ID" '{items:[{orderItemId:$i,decision:"kept"}]}')
hit POST "/api/v1/admin/orders/$TNB2_OID/door/close" "$CLOSE2_BODY" "$ADMIN"
expect 200 'close door #2 (all kept)'
[[ "$(jget '.data.toStatus')" == 'delivered' ]] && pass 'order delivered (kept)' || fail 'expected delivered'

# ═══ Returns + auto-refund ═══
say 'SECTION 15 — Verify door-return → auto-refund'
hit POST "/api/v1/admin/returns/$DOOR_RETURN_ID/verify" '{"decision":"accepted","reasonNote":"Item was unused"}' "$ADMIN"
expect 200 'verify door-return accepted'
[[ "$(jget '.data.decision')" == 'accepted' ]] && pass 'decision=accepted' || fail 'wrong decision'
REFUND_ID=$(jget '.data.refundId')
[[ -n "$REFUND_ID" && "$REFUND_ID" != "null" ]] && pass "refund created: $REFUND_ID" || fail 'no refundId returned'

# Inspect refund
hit GET "/api/v1/admin/refunds/$REFUND_ID" '' "$ADMIN"; expect 200 'get refund'
DISB_COUNT=$(jget '.data.disbursements | length')
[[ "$DISB_COUNT" -ge 1 ]] && pass "$DISB_COUNT disbursement(s)" || fail 'no disbursements'
SUCCEEDED=$(jget '[.data.disbursements[] | select(.status=="succeeded")] | length')
[[ "$SUCCEEDED" -ge 1 ]] && pass "$SUCCEEDED disbursement(s) succeeded" || fail 'no succeeded disbursement'

# Force-fail one disbursement
DISB_ID=$(jget '.data.disbursements[0].id')
hit POST "/api/v1/admin/refunds/$REFUND_ID/disbursements/$DISB_ID/force-fail" '{"reason":"Simulated gateway timeout"}' "$ADMIN"
expect 200 'force-fail disbursement'
RETRY_ID=$(jget '.data.retryDisbursementId')
[[ -n "$RETRY_ID" && "$RETRY_ID" != "null" ]] && pass "retry chain id: $RETRY_ID" || fail 'no retry id'

# Retry the new pending disbursement
hit POST "/api/v1/admin/refunds/$REFUND_ID/disbursements/$RETRY_ID/retry" '' "$ADMIN"
expect 200 'retry disbursement'
[[ "$(jget '.data.outcome')" == 'succeeded' ]] && pass 'retry succeeded' || fail 'retry not succeeded'

# ═══ Standard return + reject → held item ═══
say 'SECTION 16 — Standard return rejected → held item'
# Need a delivered order. Use the original delivered one from section 6.
hit POST "/api/v1/admin/orders/$OID/returns/open" \
  "$(jq -nc --arg i "$(curl -sS -H "Authorization: Bearer $ADMIN" "$BASE/api/v1/admin/orders/$OID" | jq -r '.data.items[0].id')" \
    '{items:[{orderItemId:$i,reasonText:"Defective stitching"}]}')" "$ADMIN"
expect 200 'open standard return'
STD_RETURN_ID=$(jget '.data.returnIds[0]')

hit POST "/api/v1/admin/returns/$STD_RETURN_ID/verify" '{"decision":"rejected","reasonNote":"Used / damaged in customer hands"}' "$ADMIN"
expect 200 'verify standard return rejected'
HELD_ID=$(jget '.data.heldItemId')
[[ -n "$HELD_ID" && "$HELD_ID" != "null" ]] && pass "held item created: $HELD_ID" || fail 'no held item'

# Verify held item visible to retailer
hit GET '/api/v1/retailer/held-items' '' "$RTOKEN"
expect 200 'retailer lists held items'
COUNT=$(jget "[.data[] | select(.id==\"$HELD_ID\")] | length")
[[ "$COUNT" == 1 ]] && pass 'retailer sees the held item' || fail 'held item missing for retailer'

# Extend held window (admin, one-shot)
hit POST "/api/v1/admin/held-items/$HELD_ID/extend" '{"daysExtra":7,"reason":"Customer is travelling"}' "$ADMIN"
expect 200 'extend held'
hit POST "/api/v1/admin/held-items/$HELD_ID/extend" '{"daysExtra":7,"reason":"Again"}' "$ADMIN"
expect 409 'cannot extend twice'
[[ "$BODY" == *held_extension_already_used* ]] && pass 'envelope carries held_extension_already_used' || fail 'wrong code'

# Retailer collects at counter
hit POST "/api/v1/retailer/held-items/$HELD_ID/collect-at-counter" '' "$RTOKEN"
expect 200 'collect at counter'

# ═══ Counter return → accept → refund ═══
say 'SECTION 17 — Counter return (retailer-initiated)'
PLACE_C=$(jq -nc --arg s "$SID" --arg c "$CID" --arg a "$ADDR_ID" --arg v "$VID" \
  '{storeId:$s,consumerId:$c,addressId:$a,items:[{variantId:$v,qty:1}],deliveryMethod:"standard",paymentMethod:"upi",paymentOutcome:"succeeded"}')
hit POST /api/v1/admin/test-orders "$PLACE_C" "$ADMIN" >/dev/null
COUNTER_OID=$(jget '.data.orderId')
hit POST "/api/v1/retailer/orders/$COUNTER_OID/accept" '' "$RTOKEN" >/dev/null
hit POST "/api/v1/retailer/orders/$COUNTER_OID/pack" '' "$RTOKEN" >/dev/null
hit POST "/api/v1/retailer/orders/$COUNTER_OID/handover" '{}' "$RTOKEN" >/dev/null
hit POST "/api/v1/retailer/orders/$COUNTER_OID/depart" '' "$RTOKEN" >/dev/null
hit POST "/api/v1/retailer/orders/$COUNTER_OID/mark-delivered" '{}' "$RTOKEN" >/dev/null

hit GET "/api/v1/admin/orders/$COUNTER_OID" '' "$ADMIN"
COUNTER_ITEM=$(jget '.data.items[0].id')

hit POST "/api/v1/retailer/orders/$COUNTER_OID/returns/open-counter" \
  "$(jq -nc --arg i "$COUNTER_ITEM" '{items:[{orderItemId:$i,reasonText:"Customer changed mind"}]}')" "$RTOKEN"
expect 200 'retailer opens counter return'
COUNTER_RETURN_ID=$(jget '.data.returnIds[0]')

# Retailer verifies → accepted → refund auto-creates
hit POST "/api/v1/retailer/returns/$COUNTER_RETURN_ID/verify" '{"decision":"accepted"}' "$RTOKEN"
expect 200 'retailer verifies counter return'
COUNTER_REFUND=$(jget '.data.refundId')
[[ -n "$COUNTER_REFUND" && "$COUNTER_REFUND" != "null" ]] && pass "counter refund auto-created: $COUNTER_REFUND" || fail 'no refund'

# ═══ Cross-domain auth boundary ═══
say 'SECTION 18 — Cross-domain auth on new routes'
hit GET '/api/v1/admin/refunds' '' "$RTOKEN"; expect 403 'retailer cannot list admin refunds'
hit GET '/api/v1/retailer/held-items' '' "$ADMIN"; expect 403 'admin cannot list retailer-held'

# ═══ Result ═══
printf "\n────────────────────\n  PASS: %d   FAIL: %d\n────────────────────\n" "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
