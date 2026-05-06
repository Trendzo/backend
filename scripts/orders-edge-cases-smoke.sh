#!/bin/bash
# Edge-case smoke for returns / door-visit / refunds / held-items.
# Tests every guard, error code, and lifecycle path NOT covered by orders-smoke.sh.
# Runs against the live backend (default :3099). Creates its own fresh data.
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

expect()  { [[ "$STATUS" == "$1" ]] && pass "$2 [HTTP $STATUS]" || fail "$2 (expected $1, got $STATUS)"; }
contains(){ [[ "$BODY" == *"$1"* ]] && pass "$2 (body contains '$1')" || fail "$2 — body lacked '$1'"; }
jget()    { jq -r "$1" </tmp/.body; }

# ═══════════════════════════════════════════════════════════════
say 'SETUP — fresh admin + retailer + store + two variants + test consumer'
# ═══════════════════════════════════════════════════════════════
node scripts/reset-data.mjs >/dev/null 2>&1 && pass 'data reset'

hit POST /api/v1/auth/admin/login '{"email":"admin@closetx.local","password":"admin1234"}'
expect 200 'admin login'
ADMIN=$(jget '.data.token')

hit GET /api/v1/catalog/categories '' "$ADMIN"; CAT_ID=$(jget '.data[0].id')
hit GET /api/v1/catalog/brands '' "$ADMIN";    BRAND_ID=$(jget '.data[0].id')

EMAIL="edge$(date +%s)@example.com"
hit POST /api/v1/auth/retailer/signup "$(jq -nc --arg e "$EMAIL" \
  '{email:$e,password:"test1234",legalName:"Edge Tester","phone":"+919876543211","gstin":"27AAAPL1234C1Z5"}')"
expect 200 'retailer-1 signup'
RTOKEN=$(jget '.data.token')
RID=$(jget '.data.retailer.id')

hit POST /api/v1/retailer/store \
  '{"legalName":"Edge Store","address":"1 Test Rd","stateCode":"27","lat":19.1,"lng":72.1,"platformFeeBp":500,"payoutCadenceDays":7}' \
  "$RTOKEN"
expect 200 'retailer-1 store created'
SID=$(jget '.data.id')

hit POST "/api/v1/admin/retailers/$RID/approve" '' "$ADMIN"; expect 200 'approve retailer-1'
hit POST "/api/v1/admin/stores/$SID/approve"   '' "$ADMIN"; expect 200 'approve store-1'

hit POST /api/v1/auth/retailer/login "$(jq -nc --arg e "$EMAIL" '{email:$e,password:"test1234"}')"
RTOKEN=$(jget '.data.token')

LIST_PAYLOAD=$(jq -nc --arg b "$BRAND_ID" --arg c "$CAT_ID" \
  '{name:"Edge Tee",brandId:$b,categoryId:$c,gender:"unisex",badge:"none",listingPolicy:"return",galleryUrls:[],hsn:"6109",status:"active"}')
hit POST /api/v1/retailer/listings "$LIST_PAYLOAD" "$RTOKEN"
expect 200 'create listing'
LID=$(jget '.data.id')

hit POST "/api/v1/retailer/listings/$LID/variants" \
  '{"attributes":{"size":"S"},"attributesLabel":"S","sku":"ET-S","pricePaise":50000,"stock":10}' "$RTOKEN"
expect 200 'create variant-1'
VID1=$(jget '.data.id')

hit POST "/api/v1/retailer/listings/$LID/variants" \
  '{"attributes":{"size":"M"},"attributesLabel":"M","sku":"ET-M","pricePaise":50000,"stock":10}' "$RTOKEN"
expect 200 'create variant-2'
VID2=$(jget '.data.id')

hit POST /api/v1/admin/consumers/test \
  "$(jq -nc --arg s "$SID" '{storeId:$s,legalName:"Edge Buyer"}')" "$ADMIN"
expect 200 'mint test consumer'
CID=$(jget '.data.consumer.id')
ADDR_ID=$(jget '.data.addressId')

# Helper: fetch an admin held item from the list and check status/disposition.
check_held_status() {
  local hid="$1" expected_status="$2" expected_disposition="${3:-}"
  hit GET "/api/v1/admin/held-items" '' "$ADMIN"
  local status; status=$(jq -r --arg id "$hid" '[.data[] | select(.id==$id)] | .[0].status' </tmp/.body)
  [[ "$status" == "$expected_status" ]] && pass "held $hid status=$expected_status" || fail "held $hid expected status=$expected_status, got $status"
  if [[ -n "$expected_disposition" ]]; then
    local disposition; disposition=$(jq -r --arg id "$hid" '[.data[] | select(.id==$id)] | .[0].disposition' </tmp/.body)
    [[ "$disposition" == "$expected_disposition" ]] && pass "held $hid disposition=$expected_disposition" || fail "held $hid expected disposition=$expected_disposition, got $disposition"
  fi
}

# Helper: walk an order from placement to out_for_delivery.
walk_to_ofd() {
  local oid="$1"
  hit POST "/api/v1/retailer/orders/$oid/accept"   '' "$RTOKEN" >/dev/null
  hit POST "/api/v1/retailer/orders/$oid/pack"     '' "$RTOKEN" >/dev/null
  hit POST "/api/v1/retailer/orders/$oid/handover" '{}' "$RTOKEN" >/dev/null
  hit POST "/api/v1/retailer/orders/$oid/depart"   '' "$RTOKEN" >/dev/null
}

place_tnb_2items() {
  local payload
  payload=$(jq -nc --arg s "$SID" --arg c "$CID" --arg a "$ADDR_ID" --arg v1 "$VID1" --arg v2 "$VID2" \
    '{storeId:$s,consumerId:$c,addressId:$a,items:[{variantId:$v1,qty:1},{variantId:$v2,qty:1}],deliveryMethod:"try_and_buy",paymentMethod:"upi",paymentOutcome:"succeeded"}')
  hit POST /api/v1/admin/test-orders "$payload" "$ADMIN"
  jget '.data.orderId'
}

place_standard() {
  local v="${1:-$VID1}" qty="${2:-1}"
  local payload
  payload=$(jq -nc --arg s "$SID" --arg c "$CID" --arg a "$ADDR_ID" --arg v "$v" --argjson q "$qty" \
    '{storeId:$s,consumerId:$c,addressId:$a,items:[{variantId:$v,qty:$q}],deliveryMethod:"standard",paymentMethod:"upi",paymentOutcome:"succeeded"}')
  hit POST /api/v1/admin/test-orders "$payload" "$ADMIN"
  jget '.data.orderId'
}

# ═══════════════════════════════════════════════════════════════
say 'SECTION 19 — Door-visit validation guards (multi-item order)'
# ═══════════════════════════════════════════════════════════════
TNB_OID=$(place_tnb_2items)
[[ -n "$TNB_OID" && "$TNB_OID" != "null" ]] && pass "placed 2-item TnB order $TNB_OID" || fail 'place failed'
walk_to_ofd "$TNB_OID"

hit POST "/api/v1/admin/orders/$TNB_OID/door/open" '' "$ADMIN"
expect 200 'open door (2-item order)'
[[ "$(jget '.data.toStatus')" == 'at_door' ]] && pass 'status=at_door' || fail 'expected at_door'

hit GET "/api/v1/admin/orders/$TNB_OID" '' "$ADMIN"
ITEM1_ID=$(jget '.data.items[0].id')
ITEM2_ID=$(jget '.data.items[1].id')
[[ -n "$ITEM1_ID" && -n "$ITEM2_ID" ]] && pass "got 2 item IDs ($ITEM1_ID, $ITEM2_ID)" || fail 'could not get item IDs'

# 19a — close-door omitting one item → must choose all items (422 unprocessable)
MISSING_ONE=$(jq -nc --arg i "$ITEM1_ID" '{items:[{orderItemId:$i,decision:"kept"}]}')
hit POST "/api/v1/admin/orders/$TNB_OID/door/close" "$MISSING_ONE" "$ADMIN"
expect 422 '19a: close with missing item rejected'
contains 'door_visit_must_choose_all_items' '19a: error code door_visit_must_choose_all_items'

# 19b — refused without a reason → DoorVisitRefuseRequiresEvidence (422)
NO_REASON=$(jq -nc --arg i1 "$ITEM1_ID" --arg i2 "$ITEM2_ID" \
  '{items:[{orderItemId:$i1,decision:"kept"},{orderItemId:$i2,decision:"refused"}]}')
hit POST "/api/v1/admin/orders/$TNB_OID/door/close" "$NO_REASON" "$ADMIN"
expect 422 '19b: refused without reason rejected'
contains 'door_visit_refuse_requires_evidence' '19b: error code refuse_requires_evidence'

# 19c — refused with reason but no photos array → still fails (422)
REASON_NO_PHOTO=$(jq -nc --arg i1 "$ITEM1_ID" --arg i2 "$ITEM2_ID" \
  '{items:[{orderItemId:$i1,decision:"kept"},{orderItemId:$i2,decision:"refused",reason:"Damaged exterior"}]}')
hit POST "/api/v1/admin/orders/$TNB_OID/door/close" "$REASON_NO_PHOTO" "$ADMIN"
expect 422 '19c: refused with reason but no photo rejected'
contains 'door_visit_refuse_requires_evidence' '19c: error code (photo missing)'

# 19d — refused with reason + photos array → success; 1 kept + 1 refused → delivered
# Route schema: photos: z.array(z.string().url()) — NOT photoUrl
VALID_CLOSE=$(jq -nc --arg i1 "$ITEM1_ID" --arg i2 "$ITEM2_ID" \
  '{items:[{orderItemId:$i1,decision:"kept"},{orderItemId:$i2,decision:"refused",reason:"Torn seam at shoulder",photos:["https://example.com/photo1.jpg"]}]}')
hit POST "/api/v1/admin/orders/$TNB_OID/door/close" "$VALID_CLOSE" "$ADMIN"
expect 200 '19d: close with 1 kept + 1 refused (valid) succeeds'
[[ "$(jget '.data.toStatus')" == 'delivered' ]] && pass '19d: status=delivered (1 item kept)' || fail 'expected delivered'
REFUSED_RETURN_ID=$(jget '.data.returnIds[0]')
[[ -n "$REFUSED_RETURN_ID" && "$REFUSED_RETURN_ID" != "null" ]] && pass "19d: return created for refused item ($REFUSED_RETURN_ID)" || fail 'no return for refused item'

# Verify stock for kept item decremented (VID1 kept, VID2 refused)
hit GET "/api/v1/retailer/listings/$LID/variants" '' "$RTOKEN"
V1_STOCK=$(jget "[.data[] | select(.id==\"$VID1\")] | .[0].stock")
V2_STOCK=$(jget "[.data[] | select(.id==\"$VID2\")] | .[0].stock")
[[ "$V1_STOCK" == "9" ]] && pass "19d: VID1 stock=9 (kept, decremented)" || fail "19d: expected VID1 stock=9, got $V1_STOCK"
[[ "$V2_STOCK" == "10" ]] && pass "19d: VID2 stock=10 (refused, no change)" || fail "19d: expected VID2 stock=10, got $V2_STOCK"

# 19e — re-open door after close → invalid_state
hit POST "/api/v1/admin/orders/$TNB_OID/door/open" '' "$ADMIN"
expect 409 '19e: re-opening closed door rejected'
contains 'invalid_state' '19e: error code invalid_state on re-open'

# 19f — all-returned TnB → returning_to_store
TNB_OID2=$(place_tnb_2items)
walk_to_ofd "$TNB_OID2"
hit POST "/api/v1/admin/orders/$TNB_OID2/door/open" '' "$ADMIN" >/dev/null
hit GET "/api/v1/admin/orders/$TNB_OID2" '' "$ADMIN"
I1=$(jget '.data.items[0].id'); I2=$(jget '.data.items[1].id')
ALL_RETURNED=$(jq -nc --arg i1 "$I1" --arg i2 "$I2" \
  '{items:[{orderItemId:$i1,decision:"returned",reason:"Wrong colour"},{orderItemId:$i2,decision:"returned",reason:"Wrong size"}]}')
hit POST "/api/v1/admin/orders/$TNB_OID2/door/close" "$ALL_RETURNED" "$ADMIN"
expect 200 '19f: close with all-returned succeeds'
[[ "$(jget '.data.toStatus')" == 'returning_to_store' ]] && pass '19f: status=returning_to_store' || fail 'expected returning_to_store'
# Neither VID should have stock decremented
hit GET "/api/v1/retailer/listings/$LID/variants" '' "$RTOKEN"
V1S=$(jget "[.data[] | select(.id==\"$VID1\")] | .[0].stock")
V2S=$(jget "[.data[] | select(.id==\"$VID2\")] | .[0].stock")
[[ "$V1S" == "9" ]] && pass '19f: VID1 stock still 9 (not decremented for return)' || fail "19f: expected 9, got $V1S"
[[ "$V2S" == "10" ]] && pass '19f: VID2 stock still 10 (not decremented for return)' || fail "19f: expected 10, got $V2S"

# ═══════════════════════════════════════════════════════════════
say 'SECTION 20 — Returns: lists, detail, duplicate guards, invalid-state guards'
# ═══════════════════════════════════════════════════════════════

# Setup: a delivered order for return tests
STD_OID=$(place_standard "$VID1" 1)
walk_to_ofd "$STD_OID"
hit POST "/api/v1/retailer/orders/$STD_OID/mark-delivered" '{}' "$RTOKEN" >/dev/null

hit GET "/api/v1/admin/orders/$STD_OID" '' "$ADMIN"
STD_ITEM_ID=$(jget '.data.items[0].id')

# 20a — admin opens a return on behalf of consumer
hit POST "/api/v1/admin/orders/$STD_OID/returns/open" \
  "$(jq -nc --arg i "$STD_ITEM_ID" '{items:[{orderItemId:$i,reasonText:"Does not fit"}]}')" "$ADMIN"
expect 200 '20a: open standard return succeeds'
STD_RETURN_ID=$(jget '.data.returnIds[0]')
[[ -n "$STD_RETURN_ID" && "$STD_RETURN_ID" != "null" ]] && pass "20a: return ID $STD_RETURN_ID" || fail '20a: missing return ID'

# 20b — open return again on the SAME item (already in return process) → ReturnInvalidState
hit POST "/api/v1/admin/orders/$STD_OID/returns/open" \
  "$(jq -nc --arg i "$STD_ITEM_ID" '{items:[{orderItemId:$i,reasonText:"Trying again"}]}')" "$ADMIN"
expect 409 '20b: duplicate return on same item rejected'
contains 'return_invalid_state' '20b: error code return_invalid_state'

# 20c — open return on a non-delivered order (still in routing)
NON_DEL_OID=$(place_standard "$VID1" 1)
# Don't walk it — it stays in 'routing'
hit GET "/api/v1/admin/orders/$NON_DEL_OID" '' "$ADMIN"
ND_ITEM=$(jget '.data.items[0].id')
hit POST "/api/v1/admin/orders/$NON_DEL_OID/returns/open" \
  "$(jq -nc --arg i "$ND_ITEM" '{items:[{orderItemId:$i,reasonText:"Test"}]}')" "$ADMIN"
expect 409 '20c: return on non-delivered order rejected'
contains 'return_invalid_state' '20c: error code return_invalid_state (non-delivered)'

# 20d — open return with zero items → Zod validation (422)
hit POST "/api/v1/admin/orders/$STD_OID/returns/open" '{"items":[]}' "$ADMIN"
expect 422 '20d: empty items array rejected'

# 20e — GET /admin/returns (list all)
hit GET '/api/v1/admin/returns' '' "$ADMIN"
expect 200 '20e: admin lists returns'
RETURN_COUNT=$(jget '.data | length')
[[ "$RETURN_COUNT" -ge 2 ]] && pass "20e: $RETURN_COUNT returns in list (≥ 2)" || fail "20e: expected ≥ 2, got $RETURN_COUNT"

# 20f — GET /admin/returns?decision=pending (filter)
hit GET '/api/v1/admin/returns?decision=pending' '' "$ADMIN"
expect 200 '20f: admin filters returns by decision=pending'
PENDING_COUNT=$(jget '.data | length')
[[ "$PENDING_COUNT" -ge 1 ]] && pass "20f: $PENDING_COUNT pending returns" || fail "20f: expected ≥ 1 pending"

# 20g — GET /admin/returns/:id (detail)
hit GET "/api/v1/admin/returns/$STD_RETURN_ID" '' "$ADMIN"
expect 200 '20g: admin gets return detail'
GOT_ID=$(jget '.data.id')
[[ "$GOT_ID" == "$STD_RETURN_ID" ]] && pass '20g: correct return ID in detail' || fail "20g: got $GOT_ID"

# 20h — verify the standard return (accepted)
hit POST "/api/v1/admin/returns/$STD_RETURN_ID/verify" \
  '{"decision":"accepted","reasonNote":"Item in good condition"}' "$ADMIN"
expect 200 '20h: verify standard return accepted'
REFUND_ID_20=$(jget '.data.refundId')
[[ -n "$REFUND_ID_20" && "$REFUND_ID_20" != "null" ]] && pass "20h: refund created $REFUND_ID_20" || fail '20h: no refund'

# 20i — verify the same return again → ReturnAlreadyDecided
hit POST "/api/v1/admin/returns/$STD_RETURN_ID/verify" \
  '{"decision":"accepted","reasonNote":"Duplicate attempt"}' "$ADMIN"
expect 409 '20i: duplicate verify rejected'
contains 'return_already_decided' '20i: error code return_already_decided'

# 20j — GET /admin/returns?decision=accepted (should now include our accepted one)
hit GET '/api/v1/admin/returns?decision=accepted' '' "$ADMIN"
expect 200 '20j: filter by accepted'
ACCEPTED_LIST=$(jget '.data | length')
[[ "$ACCEPTED_LIST" -ge 1 ]] && pass "20j: $ACCEPTED_LIST accepted return(s)" || fail '20j: expected ≥ 1 accepted'

# ═══════════════════════════════════════════════════════════════
say 'SECTION 21 — Refunds: list + terminal disbursement guards'
# ═══════════════════════════════════════════════════════════════

# 21a — GET /admin/refunds (list)
hit GET '/api/v1/admin/refunds' '' "$ADMIN"
expect 200 '21a: admin lists refunds'
ALL_REFUNDS=$(jget '.data | length')
[[ "$ALL_REFUNDS" -ge 1 ]] && pass "21a: $ALL_REFUNDS refund(s) in list" || fail '21a: expected ≥ 1'

# 21b — GET /admin/refunds/:id (detail with disbursements)
hit GET "/api/v1/admin/refunds/$REFUND_ID_20" '' "$ADMIN"
expect 200 '21b: admin gets refund detail'
DISB_COUNT=$(jget '.data.disbursements | length')
[[ "$DISB_COUNT" -ge 1 ]] && pass "21b: $DISB_COUNT disbursement(s)" || fail '21b: expected ≥ 1 disbursement'

# 21c — force-fail a succeeded disbursement → creates a pending retry chain
DISB_ID_21=$(jget '.data.disbursements[0].id')
hit POST "/api/v1/admin/refunds/$REFUND_ID_20/disbursements/$DISB_ID_21/force-fail" \
  '{"reason":"Simulated gateway timeout"}' "$ADMIN"
expect 200 '21c: force-fail succeeded disbursement'
RETRY_ID_21=$(jget '.data.retryDisbursementId')
[[ -n "$RETRY_ID_21" && "$RETRY_ID_21" != "null" ]] && pass "21c: retry chain started ($RETRY_ID_21)" || fail '21c: no retry ID'

# 21d — force-fail the SAME (now-failed) disbursement again → DisbursementAlreadyTerminal
hit POST "/api/v1/admin/refunds/$REFUND_ID_20/disbursements/$DISB_ID_21/force-fail" \
  '{"reason":"Trying to fail again"}' "$ADMIN"
expect 409 '21d: force-fail already-failed disbursement rejected'
contains 'disbursement_already_terminal' '21d: error code disbursement_already_terminal'

# 21e — retry the new pending disbursement → succeeds
hit POST "/api/v1/admin/refunds/$REFUND_ID_20/disbursements/$RETRY_ID_21/retry" '' "$ADMIN"
expect 200 '21e: retry pending disbursement'
[[ "$(jget '.data.outcome')" == 'succeeded' ]] && pass '21e: outcome=succeeded' || fail '21e: expected succeeded'

# 21f — retry the now-succeeded disbursement again → DisbursementAlreadyTerminal
hit POST "/api/v1/admin/refunds/$REFUND_ID_20/disbursements/$RETRY_ID_21/retry" '' "$ADMIN"
expect 409 '21f: retry already-succeeded disbursement rejected'
contains 'disbursement_already_terminal' '21f: error code disbursement_already_terminal'

# 21g — refund status should be succeeded after full retry chain
hit GET "/api/v1/admin/refunds/$REFUND_ID_20" '' "$ADMIN"
REFUND_STATUS=$(jget '.data.status')
[[ "$REFUND_STATUS" == 'succeeded' ]] && pass "21g: refund.status=succeeded" || fail "21g: expected succeeded, got $REFUND_STATUS"

# ═══════════════════════════════════════════════════════════════
say 'SECTION 22 — Held items: admin force-dispose, mark-expired, list'
# ═══════════════════════════════════════════════════════════════
# We need 3 held items: one for restocked, one for forfeited, one for expired.
# Each is created by: place order → deliver → open return → verify rejected.

make_held_item() {
  local vid="${1:-$VID2}"
  local oid
  oid=$(place_standard "$vid" 1)
  walk_to_ofd "$oid"
  hit POST "/api/v1/retailer/orders/$oid/mark-delivered" '{}' "$RTOKEN" >/dev/null
  hit GET "/api/v1/admin/orders/$oid" '' "$ADMIN"
  local iid; iid=$(jget '.data.items[0].id')
  hit POST "/api/v1/admin/orders/$oid/returns/open" \
    "$(jq -nc --arg i "$iid" '{items:[{orderItemId:$i,reasonText:"Needs verification"}]}')" "$ADMIN" >/dev/null
  local rid; rid=$(jget '.data.returnIds[0]')
  hit POST "/api/v1/admin/returns/$rid/verify" '{"decision":"rejected","reasonNote":"Damaged"}' "$ADMIN" >/dev/null
  jget '.data.heldItemId'
}

HELD_RESTOCK=$(make_held_item "$VID2")
[[ -n "$HELD_RESTOCK" && "$HELD_RESTOCK" != "null" ]] && pass "22: held item for restocking: $HELD_RESTOCK" || fail "22: failed to create held item for restocking"

HELD_FORFEIT=$(make_held_item "$VID2")
[[ -n "$HELD_FORFEIT" && "$HELD_FORFEIT" != "null" ]] && pass "22: held item for forfeiture: $HELD_FORFEIT" || fail "22: failed to create held item for forfeiture"

HELD_EXPIRE=$(make_held_item "$VID2")
[[ -n "$HELD_EXPIRE" && "$HELD_EXPIRE" != "null" ]] && pass "22: held item for expiry: $HELD_EXPIRE" || fail "22: failed to create held item for expiry"

# 22a — GET /admin/held-items (list)
hit GET '/api/v1/admin/held-items' '' "$ADMIN"
expect 200 '22a: admin lists held items'
HELD_COUNT=$(jget '.data | length')
[[ "$HELD_COUNT" -ge 3 ]] && pass "22a: $HELD_COUNT held items in list (≥ 3)" || fail "22a: expected ≥ 3, got $HELD_COUNT"

# 22b — force-dispose 'restocked' → VID2 stock goes up
hit GET "/api/v1/retailer/listings/$LID/variants" '' "$RTOKEN"
V2_BEFORE=$(jget "[.data[] | select(.id==\"$VID2\")] | .[0].stock")

hit POST "/api/v1/admin/held-items/$HELD_RESTOCK/force-dispose" \
  '{"disposition":"restocked","reason":"Customer never showed"}' "$ADMIN"
expect 200 '22b: force-dispose restocked'
[[ "$(jget '.data.heldId')" == "$HELD_RESTOCK" ]] && pass '22b: heldId in response' || fail '22b: wrong heldId'
check_held_status "$HELD_RESTOCK" 'resolved' 'restocked'

hit GET "/api/v1/retailer/listings/$LID/variants" '' "$RTOKEN"
V2_AFTER=$(jget "[.data[] | select(.id==\"$VID2\")] | .[0].stock")
EXPECTED_STOCK=$((V2_BEFORE + 1))
[[ "$V2_AFTER" == "$EXPECTED_STOCK" ]] && pass "22b: VID2 stock $V2_BEFORE → $V2_AFTER (restocked by 1)" || fail "22b: expected stock=$EXPECTED_STOCK, got $V2_AFTER"

# 22c — force-dispose 'forfeited_to_store' → no stock change
hit GET "/api/v1/retailer/listings/$LID/variants" '' "$RTOKEN"
V2_BEFORE_FORFEIT=$(jget "[.data[] | select(.id==\"$VID2\")] | .[0].stock")

hit POST "/api/v1/admin/held-items/$HELD_FORFEIT/force-dispose" \
  '{"disposition":"forfeited_to_store","reason":"Return window exceeded per policy"}' "$ADMIN"
expect 200 '22c: force-dispose forfeited_to_store'
check_held_status "$HELD_FORFEIT" 'resolved' 'forfeited_to_store'

hit GET "/api/v1/retailer/listings/$LID/variants" '' "$RTOKEN"
V2_AFTER_FORFEIT=$(jget "[.data[] | select(.id==\"$VID2\")] | .[0].stock")
[[ "$V2_AFTER_FORFEIT" == "$V2_BEFORE_FORFEIT" ]] && pass "22c: VID2 stock unchanged at $V2_AFTER_FORFEIT (forfeited, no restock)" || fail "22c: stock changed unexpectedly: $V2_BEFORE_FORFEIT → $V2_AFTER_FORFEIT"

# 22d — mark-expired
hit POST "/api/v1/admin/held-items/$HELD_EXPIRE/mark-expired" '' "$ADMIN"
expect 200 '22d: admin marks held item expired'
check_held_status "$HELD_EXPIRE" 'expired'

# 22e — attempt to collect on an already-resolved held item → HeldItemNotHolding
hit POST "/api/v1/retailer/held-items/$HELD_RESTOCK/collect-at-counter" '' "$RTOKEN"
expect 409 '22e: collect on resolved item rejected'
contains 'held_item_not_holding' '22e: error code held_item_not_holding'

# 22f — attempt to force-dispose on already-expired item → HeldItemNotHolding
hit POST "/api/v1/admin/held-items/$HELD_EXPIRE/force-dispose" \
  '{"disposition":"written_off","reason":"Already expired"}' "$ADMIN"
expect 409 '22f: force-dispose on expired item rejected'
contains 'held_item_not_holding' '22f: error code held_item_not_holding'

# ═══════════════════════════════════════════════════════════════
say 'SECTION 23 — Held items: retailer redeliver + cross-store protection'
# ═══════════════════════════════════════════════════════════════

# Create a held item for redeliver test
HELD_REDELIVER=$(make_held_item "$VID1")
[[ -n "$HELD_REDELIVER" && "$HELD_REDELIVER" != "null" ]] && pass "23: held item for redeliver: $HELD_REDELIVER" || fail "23: failed to create redeliver held item"

# 23a — retailer redelivers held item → resolved disposition=redelivered
hit POST "/api/v1/retailer/held-items/$HELD_REDELIVER/redeliver" '' "$RTOKEN"
expect 200 '23a: retailer redeliver succeeds'
REDELIVER_DA=$(jget '.data.deliveryAttemptId')
[[ -n "$REDELIVER_DA" && "$REDELIVER_DA" != "null" ]] && pass "23a: delivery_attempt created ($REDELIVER_DA)" || fail '23a: no deliveryAttemptId in response'
check_held_status "$HELD_REDELIVER" 'resolved' 'redelivered'

# 23b — redeliver the same (now resolved) held item → HeldItemNotHolding
hit POST "/api/v1/retailer/held-items/$HELD_REDELIVER/redeliver" '' "$RTOKEN"
expect 409 '23b: redeliver resolved item rejected'
contains 'held_item_not_holding' '23b: error code held_item_not_holding'

# 23c — set up a SECOND retailer with its own store
EMAIL2="edge2$(date +%s)@example.com"
hit POST /api/v1/auth/retailer/signup "$(jq -nc --arg e "$EMAIL2" \
  '{email:$e,password:"test1234",legalName:"Edge Tester 2","phone":"+919876543212","gstin":"27AAAPL1234C1Z6"}')"
RID2=$(jget '.data.retailer.id')
RTOKEN2=$(jget '.data.token')

hit POST /api/v1/retailer/store \
  '{"legalName":"Edge Store 2","address":"2 Test Rd","stateCode":"27","lat":19.2,"lng":72.2,"platformFeeBp":500,"payoutCadenceDays":7}' \
  "$RTOKEN2"
SID2=$(jget '.data.id')
hit POST "/api/v1/admin/retailers/$RID2/approve" '' "$ADMIN" >/dev/null
hit POST "/api/v1/admin/stores/$SID2/approve"   '' "$ADMIN" >/dev/null
hit POST /api/v1/auth/retailer/login "$(jq -nc --arg e "$EMAIL2" '{email:$e,password:"test1234"}')"
RTOKEN2=$(jget '.data.token')

# Create a fresh held item on store 1
HELD_CROSS=$(make_held_item "$VID1")
[[ -n "$HELD_CROSS" && "$HELD_CROSS" != "null" ]] && pass "23c: held item for cross-store test: $HELD_CROSS" || fail "23c: failed to create cross-store held item"

# 23d — retailer-2 tries to collect retailer-1's held item → 403
hit POST "/api/v1/retailer/held-items/$HELD_CROSS/collect-at-counter" '' "$RTOKEN2"
expect 403 '23d: retailer-2 cannot collect store-1 held item'
contains 'forbidden' '23d: 403 Forbidden body'

# 23e — retailer-2 tries to redeliver retailer-1's held item → 403
hit POST "/api/v1/retailer/held-items/$HELD_CROSS/redeliver" '' "$RTOKEN2"
expect 403 '23e: retailer-2 cannot redeliver store-1 held item'
contains 'forbidden' '23e: 403 Forbidden body'

# 23f — retailer-2 cannot verify a return from store-1 (using the refused door return ID from section 19d)
hit POST "/api/v1/retailer/returns/$REFUSED_RETURN_ID/verify" \
  '{"decision":"accepted"}' "$RTOKEN2"
expect 403 '23f: retailer-2 cannot verify store-1 return'

# 23g — retailer-1 can collect its own held item normally
hit POST "/api/v1/retailer/held-items/$HELD_CROSS/collect-at-counter" '' "$RTOKEN"
expect 200 '23g: retailer-1 collects its own held item'

# ═══════════════════════════════════════════════════════════════
say 'SECTION 24 — Refused door-return flow end-to-end verify'
# ═══════════════════════════════════════════════════════════════
# The refused item from section 19d (REFUSED_RETURN_ID) should still be pending verify.
# Verify it rejected → creates a held item.
hit GET "/api/v1/admin/returns/$REFUSED_RETURN_ID" '' "$ADMIN"
expect 200 '24: get refused door-return detail'
DECISION_BEFORE=$(jget '.data.storeDecision')
[[ "$DECISION_BEFORE" == 'pending' ]] && pass "24: storeDecision still pending ($DECISION_BEFORE)" || fail "24: expected pending, got $DECISION_BEFORE"

hit POST "/api/v1/admin/returns/$REFUSED_RETURN_ID/verify" \
  '{"decision":"rejected","reasonNote":"Customer-caused damage: torn seam"}' "$ADMIN"
expect 200 '24: verify refused return (rejected)'
HELD_FROM_REFUSED=$(jget '.data.heldItemId')
[[ -n "$HELD_FROM_REFUSED" && "$HELD_FROM_REFUSED" != "null" ]] && pass "24: held item created for refused return ($HELD_FROM_REFUSED)" || fail '24: no held item from refused return'

# Verify the door-return is now decided
hit GET "/api/v1/admin/returns/$REFUSED_RETURN_ID" '' "$ADMIN"
DECISION_AFTER=$(jget '.data.storeDecision')
[[ "$DECISION_AFTER" == 'rejected' ]] && pass "24: storeDecision=rejected" || fail "24: expected rejected, got $DECISION_AFTER"

# 24b — Try to verify this now-rejected return again → ReturnAlreadyDecided
hit POST "/api/v1/admin/returns/$REFUSED_RETURN_ID/verify" \
  '{"decision":"accepted","reasonNote":"Changed mind"}' "$ADMIN"
expect 409 '24b: cannot re-verify decided return'
contains 'return_already_decided' '24b: error code return_already_decided'

# ═══════════════════════════════════════════════════════════════
say 'SECTION 25 — Admin cross-domain boundaries for new routes'
# ═══════════════════════════════════════════════════════════════
# Retailer tokens must not work on admin-only routes.
hit GET '/api/v1/admin/returns' '' "$RTOKEN"; expect 403 '25a: retailer cannot list admin/returns'
hit GET '/api/v1/admin/held-items' '' "$RTOKEN"; expect 403 '25b: retailer cannot list admin/held-items'
hit GET '/api/v1/admin/refunds' '' "$RTOKEN"; expect 403 '25c: retailer cannot list admin/refunds'

# Admin token must not work on retailer-only routes.
hit GET '/api/v1/retailer/held-items' '' "$ADMIN"; expect 403 '25d: admin cannot list retailer/held-items'
hit GET '/api/v1/retailer/orders' '' "$ADMIN"; expect 403 '25e: admin cannot list retailer/orders'

# Unauthenticated must always 401.
hit GET '/api/v1/admin/returns' ''; expect 401 '25f: unauthenticated request to admin/returns → 401'
hit GET '/api/v1/retailer/held-items' ''; expect 401 '25g: unauthenticated request to retailer/held-items → 401'

# ═══ Result ═══
printf "\n────────────────────\n  PASS: %d   FAIL: %d\n────────────────────\n" "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
