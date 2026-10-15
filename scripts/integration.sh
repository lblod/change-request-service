#!/usr/bin/env bash
# End-to-end calls against a running app-rvs, or against this service on its own port.
#
# Environment (required unless noted):
#   BASE_URL        URL under which /change-requests is served AND where the mu-session-id header
#                   is honoured: the service's own published port, or the dispatcher's port.
#                   Not the identifier: it replaces mu-session-id with the session of the cookie.
#   SESSION_ORG_A   session URI (the value of the mu-session-id header) of an account logged in
#                   for organisation A, as the fixture sessions in the app-rvs README give them
#   SESSION_ORG_B   idem for organisation B
#   SESSION_ABB     idem for the ABB account (the organisation behind "abbUri" in the config)
#   ORG_A_UUID      mu:uuid of organisation A (the ext:sessionGroup of SESSION_ORG_A)
#   ORG_B_UUID      mu:uuid of organisation B
#   SPARQL_ENDPOINT optional: an endpoint without authorization (the triplestore itself, e.g.
#                   http://localhost:8890/sparql) to check the applied data directly
#   IDENTIFIER_URL  optional: the identifier's URL (e.g. http://localhost:8080) to check that a
#                   browser request carrying mu-auth-scope is answered as unscoped
#
# Needs curl and jq. Through the "site" aggregate it creates a site with an address and a contact
# point under organisation A and links it to A, updates it and deletes it again, and lets ABB do
# the same under B. It leaves only the request records (and dct:modified on A and B) behind.
# BASE_URL must also serve the resource routes (/administrative-units, /site-types) of the stack,
# which the script reads to learn the records of organisations A and B.
set -uo pipefail

for variable in BASE_URL SESSION_ORG_A SESSION_ORG_B SESSION_ABB ORG_A_UUID ORG_B_UUID; do
  if [ -z "${!variable:-}" ]; then
    echo "Set $variable (see the header of this script)" >&2
    exit 2
  fi
done
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

BASE_URL=${BASE_URL%/}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PASSED=0
FAILED=0
SKIPPED=0
STATUS=""
BODY=""

pass() { PASSED=$((PASSED + 1)); echo "PASS  $1"; }
fail() { FAILED=$((FAILED + 1)); echo "FAIL  $1"; echo "      HTTP $STATUS: $(echo "$BODY" | head -c 600)"; }
skip() { SKIPPED=$((SKIPPED + 1)); echo "SKIP  $1"; }

# request METHOD PATH SESSION [BODY] [EXTRA-HEADER]: sets STATUS and BODY
request() {
  local method=$1 path=$2 session=$3 payload=${4:-} extra=${5:-}
  local args=(-s -g -o "$TMP/body" -w '%{http_code}' -X "$method" -H 'Accept: application/vnd.api+json')
  if [ -n "$session" ]; then args+=(-H "mu-session-id: $session"); fi
  if [ -n "$payload" ]; then args+=(-H 'Content-Type: application/vnd.api+json' --data "$payload"); fi
  if [ -n "$extra" ]; then args+=(-H "$extra"); fi
  STATUS=$(curl "${args[@]}" "$BASE_URL$path" || echo "000")
  BODY=$(cat "$TMP/body" 2>/dev/null || true)
}

# expect DESCRIPTION HTTP-STATUS [JQ-CONDITION]
expect() {
  local description=$1 wanted=$2 condition=${3:-true}
  if [ "$STATUS" != "$wanted" ]; then
    fail "$description (expected HTTP $wanted)"
  elif ! echo "$BODY" | jq -e "$condition" >/dev/null 2>&1; then
    fail "$description (body does not satisfy: $condition)"
  else
    pass "$description"
  fi
}

# expect_refused DESCRIPTION: anything but a 2xx
expect_refused() {
  case "$STATUS" in
    2*) fail "$1 (expected a refusal, got HTTP $STATUS)" ;;
    *) pass "$1 (HTTP $STATUS)" ;;
  esac
}

sparql_ask() {
  curl -s -H 'Accept: application/sparql-results+json' --data-urlencode "query=$1" "$SPARQL_ENDPOINT" | jq -r '.boolean'
}

# check_data DESCRIPTION ASK-QUERY EXPECTED (true|false); skipped without SPARQL_ENDPOINT
check_data() {
  if [ -z "${SPARQL_ENDPOINT:-}" ]; then return; fi
  local answer
  answer=$(sparql_ask "$2")
  if [ "$answer" = "$3" ]; then pass "$1"; else STATUS="-"; BODY="ASK answered $answer"; fail "$1"; fi
}

cr_body() {
  # cr_body TARGET-UUID AGGREGATE OPERATIONS-JSON
  printf '{ "data": { "type": "change-requests", "attributes": { "aggregate": "%s", "operations": %s }, "relationships": { "target": { "data": { "type": "organizations", "id": "%s" } } } } }' "$2" "$3" "$1"
}

echo "change-request-service integration against $BASE_URL"

# --- what the stack holds: the records of A and B, a site type if the code list is loaded ----
request GET "/administrative-units/$ORG_A_UUID/sites" "$SESSION_ORG_A"
SITES_OF_A=$(echo "$BODY" | jq -c '[.data[]? | { type: "sites", id: .id }]' 2>/dev/null || echo '[]')
request GET "/administrative-units/$ORG_B_UUID?include=primary-site" "$SESSION_ORG_B"
SITE_OF_B=$(echo "$BODY" | jq -r '(.data.relationships["primary-site"].data.id // .included[0].id) // empty' 2>/dev/null)
request GET "/site-types?page[size]=1" "$SESSION_ORG_A"
SITE_TYPE_UUID=$(echo "$BODY" | jq -r '.data[0].id // empty' 2>/dev/null)
if [ -z "$SITE_TYPE_UUID" ]; then skip "no site type in the stack (code lists not loaded): the reference checks are skipped"; fi
SITE_TYPE_REL=""
if [ -n "$SITE_TYPE_UUID" ]; then SITE_TYPE_REL=', "site-type": { "data": { "type": "site-types", "id": "'"$SITE_TYPE_UUID"'" } }'; fi

# --- permissions ------------------------------------------------------------------------------
request GET "/change-requests/permissions?target=$ORG_A_UUID" "$SESSION_ORG_A"
expect "organisation A may edit itself (own-organisation)" 200 '."can-edit" == true and (.rules | index("own-organisation")) != null'

request GET "/change-requests/permissions?target=$ORG_B_UUID" "$SESSION_ORG_A"
expect "organisation A may not edit organisation B" 200 '."can-edit" == false and .rules == []'

request GET "/change-requests/permissions?target=$ORG_B_UUID" "$SESSION_ABB"
expect "ABB may edit organisation B (abb-edits-all)" 200 '."can-edit" == true and (.rules | index("abb-edits-all")) != null'

request GET "/change-requests/permissions?target=$ORG_A_UUID" ""
expect "no session is a 401" 401 '.errors[0].status == "401"'

request GET "/change-requests/permissions?target=00000000-0000-4000-8000-000000000000" "$SESSION_ORG_A"
expect "an unknown target is a 404" 404 '.errors[0].status == "404"'

# --- a site with an address and a contact point, linked to its organisation ("site" aggregate) --
create_site_body() {
  # create_site_body ORG-UUID SITES-JSON (the organisation's current sites, as resource identifiers)
  cr_body "$1" site '[
    { "op": "create", "data": { "type": "addresses", "lid": "a1", "attributes": {
        "street": "Grote Markt", "number": "3", "postcode": "9300", "municipality": "Aalst",
        "province": "Oost-Vlaanderen", "country": "België", "full-address": "Grote Markt 3, 9300 Aalst, België" } } },
    { "op": "create", "data": { "type": "contact-points", "lid": "c1", "attributes": {
        "email": "integration@example.org", "type": "Primary" } } },
    { "op": "create", "data": { "type": "sites", "lid": "s1",
        "attributes": { "site-type-name": "Integration test site" },
        "relationships": {
          "address": { "data": { "type": "addresses", "lid": "a1" } },
          "contacts": { "data": [ { "type": "contact-points", "lid": "c1" } ] }'"$SITE_TYPE_REL"' } } },
    { "op": "update", "data": { "type": "administrative-units", "id": "'"$1"'",
        "relationships": { "sites": { "data": '"$(echo "$2" | jq -c '. + [{ "type": "sites", "lid": "s1" }]')"' } } } }
  ]'
}

request POST "/change-requests" "$SESSION_ORG_A" "$(create_site_body "$ORG_A_UUID" "$SITES_OF_A")"
expect "organisation A creates a site under itself and links it: 201, applied" 201 \
  '.data.type == "change-requests" and .data.attributes.status == "goedgekeurd" and .data.attributes["applied-at"] != null and .data.attributes.aggregate == "site" and (.data.attributes.lids | has("a1") and has("c1") and has("s1")) and .data.relationships.target.data.id == "'"$ORG_A_UUID"'"'
REQUEST_ID=$(echo "$BODY" | jq -r '.data.id // empty')
SITE_UUID=$(echo "$BODY" | jq -r '.data.attributes.lids.s1 // empty')
ADDRESS_UUID=$(echo "$BODY" | jq -r '.data.attributes.lids.a1 // empty')
CONTACT_UUID=$(echo "$BODY" | jq -r '.data.attributes.lids.c1 // empty')

if [ -n "$SITE_UUID" ]; then
  check_data "the site exists in the triplestore with its address and contact point, and A links to it" "
    PREFIX org: <http://www.w3.org/ns/org#> PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    PREFIX organisatie: <https://data.vlaanderen.be/ns/organisatie#> PREFIX schema: <http://schema.org/>
    ASK { ?site a org:Site ; mu:uuid \"$SITE_UUID\" ; organisatie:bestaatUit ?address ; org:siteAddress ?contact .
          ?address mu:uuid \"$ADDRESS_UUID\" . ?contact mu:uuid \"$CONTACT_UUID\" ; schema:email \"integration@example.org\" .
          ?org mu:uuid \"$ORG_A_UUID\" ; org:hasSite ?site . }" true
  check_data "organisation A carries dct:modified and ext:lastModifiedBy" "
    PREFIX dct: <http://purl.org/dc/terms/> PREFIX ext: <http://mu.semte.ch/vocabularies/ext/> PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    ASK { ?org mu:uuid \"$ORG_A_UUID\" ; dct:modified ?when ; ext:lastModifiedBy ?account . }" true
  if [ -n "$SITE_TYPE_UUID" ]; then
    check_data "the site carries its site type (a reference of the aggregate)" "
      PREFIX ere: <http://data.lblod.info/vocabularies/erediensten/> PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
      ASK { ?site mu:uuid \"$SITE_UUID\" ; ere:vestigingstype ?type . ?type mu:uuid \"$SITE_TYPE_UUID\" . }" true
  fi
fi

if [ -n "$REQUEST_ID" ]; then
  request GET "/change-requests/$REQUEST_ID" "$SESSION_ORG_A"
  expect "organisation A reads its request" 200 '.data.id == "'"$REQUEST_ID"'" and .data.attributes.status == "goedgekeurd"'

  request GET "/change-requests/$REQUEST_ID" "$SESSION_ORG_B"
  expect "organisation B does not see the request of A" 404 '.errors[0].status == "404"'

  request GET "/change-requests/$REQUEST_ID" "$SESSION_ABB"
  expect "ABB sees the request of A" 200 '.data.id == "'"$REQUEST_ID"'"'

  request GET "/change-requests?filter[target]=$ORG_A_UUID" "$SESSION_ORG_A"
  expect "the list for A contains the request" 200 '[.data[] | select(.id == "'"$REQUEST_ID"'")] | length == 1'

  request GET "/change-requests?filter[target]=$ORG_A_UUID" "$SESSION_ORG_B"
  expect "the list of A is empty for B, not an error" 200 '.data == []'

  request POST "/change-requests/$REQUEST_ID/apply" "$SESSION_ORG_A"
  expect "an applied request cannot be applied again: 409" 409 '.errors[0].status == "409" and (.errors[0].detail | test("has status goedgekeurd"))'

  request POST "/change-requests/00000000-0000-4000-8000-000000000000/apply" "$SESSION_ORG_A"
  expect "applying an unknown request is a 404" 404 '.errors[0].status == "404"'
fi

# --- refusals ---------------------------------------------------------------------------------
request POST "/change-requests" "$SESSION_ORG_A" "$(create_site_body "$ORG_B_UUID" '[]')"
expect "organisation A may not post for organisation B: 403" 403 '.errors[0].status == "403"'

request POST "/change-requests" "" "$(create_site_body "$ORG_A_UUID" '[]')"
expect "a POST without session is a 401" 401 '.errors[0].status == "401"'

request POST "/change-requests" "$SESSION_ORG_A" "$(cr_body "$ORG_A_UUID" site '[
    { "op": "create", "data": { "type": "governing-bodies", "lid": "g1", "attributes": {} } } ]')"
expect "a type outside the aggregate is a 422" 422 '.errors[0].status == "422" and (.errors[0].detail | test("outside the aggregate"))'

request POST "/change-requests" "$SESSION_ORG_A" "$(cr_body "$ORG_A_UUID" site '[
    { "op": "create", "data": { "type": "sites", "lid": "s1", "attributes": { "colour": "blue" } } } ]')"
expect "an unknown attribute is a 422" 422 '.errors[0].status == "422" and (.errors[0].detail | test("unknown attribute"))'

request POST "/change-requests" "$SESSION_ORG_A" "$(cr_body "$ORG_A_UUID" site '[
    { "op": "create", "data": { "type": "sites", "lid": "s1",
      "relationships": { "address": { "data": { "type": "contact-points", "lid": "s1" } } } } } ]')"
expect "a relationship target type mismatch is a 422" 422 '.errors[0].status == "422" and (.errors[0].detail | test("expects addresses"))'

request POST "/change-requests" "$SESSION_ORG_A" "$(cr_body "$ORG_A_UUID" site '[
    { "op": "create", "data": { "type": "addresses", "lid": "a1", "attributes": { "address-register-uri": "https://x/a> . } } ; DROP ALL #" } } } ]')"
expect "a url attribute that is not an IRI is a 422" 422 '.errors[0].status == "422" and (.errors[0].detail | test("a URI cannot contain"))'

# the organisation itself: only an update of the target
request POST "/change-requests" "$SESSION_ORG_A" "$(cr_body "$ORG_A_UUID" organization-core-data '[
    { "op": "delete", "data": { "type": "administrative-units", "id": "'"$ORG_A_UUID"'" } } ]')"
expect "an organisation cannot be deleted: 422" 422 '.errors[0].status == "422" and (.errors[0].detail | test("cannot be deleted")) and .errors[0].source.pointer == "/data/attributes/operations/0/op"'

request POST "/change-requests" "$SESSION_ORG_A" "$(cr_body "$ORG_A_UUID" organization-core-data '[
    { "op": "create", "data": { "type": "administrative-units", "lid": "o1", "attributes": { "name": "Gemeente Nergens" } } } ]')"
expect "an organisation cannot be created: 422" 422 '.errors[0].status == "422" and (.errors[0].detail | test("cannot be created"))'

request POST "/change-requests" "$SESSION_ORG_A" "$(cr_body "$ORG_A_UUID" organization-core-data '[
    { "op": "update", "data": { "type": "administrative-units", "id": "'"$ORG_B_UUID"'", "attributes": { "name": "pwned" } } } ]')"
expect "organisation A, target A, an update of organisation B: 422" 422 '.errors[0].status == "422" and (.errors[0].detail | test("must be the target of the request"))'
check_data "organisation B keeps its name" "
  PREFIX skos: <http://www.w3.org/2004/02/skos/core#> PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
  ASK { ?org mu:uuid \"$ORG_B_UUID\" ; skos:prefLabel \"pwned\" . }" false

# the records of another organisation, as operation and as reference
if [ -n "$SITE_OF_B" ]; then
  request POST "/change-requests" "$SESSION_ORG_A" "$(cr_body "$ORG_A_UUID" site '[
      { "op": "delete", "data": { "type": "sites", "id": "'"$SITE_OF_B"'" } } ]')"
  expect "organisation A, target A, a delete of the site of B: 422" 422 '.errors[0].status == "422" and (.errors[0].detail | test("does not belong to the target organisation"))'
  check_data "the site of B still exists" "
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/> ASK { ?site mu:uuid \"$SITE_OF_B\" . }" true

  request POST "/change-requests" "$SESSION_ORG_A" "$(cr_body "$ORG_A_UUID" site '[
      { "op": "update", "data": { "type": "sites", "id": "'"$SITE_OF_B"'", "attributes": { "site-type-name": "pwned" } } } ]')"
  expect "organisation A, target A, an update of the site of B: 422" 422 '.errors[0].status == "422" and (.errors[0].detail | test("does not belong to the target organisation"))'

  request POST "/change-requests" "$SESSION_ORG_A" "$(cr_body "$ORG_A_UUID" site '[
      { "op": "update", "data": { "type": "administrative-units", "id": "'"$ORG_A_UUID"'",
        "relationships": { "primary-site": { "data": { "type": "sites", "id": "'"$SITE_OF_B"'" } } } } } ]')"
  expect "organisation A pointing its primary site at the site of B: 422" 422 '.errors[0].status == "422" and (.errors[0].detail | test("does not belong to the target organisation"))'
else
  skip "organisation B has no primary site: the checks on the records of B are skipped"
fi

# a relationship outside the aggregate must be unchanged
request POST "/change-requests" "$SESSION_ORG_A" "$(cr_body "$ORG_A_UUID" organization-core-data '[
    { "op": "update", "data": { "type": "administrative-units", "id": "'"$ORG_A_UUID"'",
      "relationships": { "organization-status": { "data": null } } } } ]')"
expect "clearing the status, which the aggregate does not admit, is a 422" 422 '.errors[0].status == "422" and (.errors[0].detail | test("not part of the aggregate")) and .errors[0].source.pointer == "/data/attributes/operations/0/data/relationships/organization-status"'

# the body limit of the template parser (MAX_BODY_SIZE, 5mb in the Dockerfile and the stack)
head -c 6000000 /dev/zero | tr '\0' 'x' > "$TMP/padding"
{ printf '{ "data": { "type": "change-requests", "attributes": { "aggregate": "site", "operations": [ { "op": "create", "data": { "type": "sites", "lid": "s1", "attributes": { "site-type-name": "'; cat "$TMP/padding"; printf '" } } } ] }, "relationships": { "target": { "data": { "type": "organizations", "id": "%s" } } } } }' "$ORG_A_UUID"; } > "$TMP/big.json"
# -H 'Expect:' because the dispatcher's proxy drops the connection on curl's 100-continue handshake, which a browser never sends
STATUS=$(curl -s -g -o "$TMP/body" -w '%{http_code}' -X POST -H 'Accept: application/vnd.api+json' -H 'Content-Type: application/vnd.api+json' -H 'Expect:' -H "mu-session-id: $SESSION_ORG_A" --data-binary "@$TMP/big.json" "$BASE_URL/change-requests" || echo "000")
BODY=$(cat "$TMP/body" 2>/dev/null || true)
expect "a body over MAX_BODY_SIZE is a 413" 413 '.errors[0].status == "413"'

# --- the scope header grants nothing to a request that is not the service's own -----------------
PATCH_BODY='{ "data": { "type": "administrative-units", "id": "'"$ORG_A_UUID"'", "attributes": { "name": "pwned by scope" } } }'
request PATCH "/administrative-units/$ORG_A_UUID" "$SESSION_ORG_A" "$PATCH_BODY" 'mu-auth-scope: http://services.lblod.info/change-request-service'
expect_refused "a PATCH on a resource route with a forged mu-auth-scope is refused (no service forwards the header)"
if [ -n "${IDENTIFIER_URL:-}" ]; then
  STATUS=$(curl -s -g -o "$TMP/body" -w '%{http_code}' -X PATCH -H 'Accept: application/vnd.api+json' -H 'Content-Type: application/vnd.api+json' \
    -H 'mu-auth-scope: http://services.lblod.info/change-request-service' -H 'mu-auth-allowed-groups: [{"name":"logged-in","variables":[]}]' \
    --data "$PATCH_BODY" "${IDENTIFIER_URL%/}/administrative-units/$ORG_A_UUID" || echo "000")
  BODY=$(cat "$TMP/body" 2>/dev/null || true)
  expect_refused "through the identifier, forged mu-auth-scope and mu-auth-allowed-groups headers grant nothing"
fi
check_data "organisation A keeps its name" "
  PREFIX skos: <http://www.w3.org/2004/02/skos/core#> PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
  ASK { ?org mu:uuid \"$ORG_A_UUID\" ; skos:prefLabel \"pwned by scope\" . }" false

# --- update and delete what was created -----------------------------------------------------
if [ -n "$SITE_UUID" ]; then
  request POST "/change-requests" "$SESSION_ORG_A" "$(cr_body "$ORG_A_UUID" site '[
      { "op": "update", "data": { "type": "sites", "id": "'"$SITE_UUID"'",
        "attributes": { "site-type-name": "Integration test site, renamed" } } } ]')"
  expect "organisation A updates the site, carrying only the name" 201 '.data.attributes.status == "goedgekeurd" and .data.attributes.lids == {}'
  check_data "the site carries the new name and still its address and contact point (per-key semantics)" "
    PREFIX org: <http://www.w3.org/ns/org#> PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    PREFIX organisatie: <https://data.vlaanderen.be/ns/organisatie#> PREFIX dct: <http://purl.org/dc/terms/>
    ASK { ?site mu:uuid \"$SITE_UUID\" ; dct:description \"Integration test site, renamed\" ; organisatie:bestaatUit ?address ; org:siteAddress ?contact .
          FILTER NOT EXISTS { ?site dct:description \"Integration test site\" } }" true

  # removing a contact point from a site: the page unlinks it and deletes it in the same request
  # (a record that is no longer linked to the organisation falls outside its aggregate afterwards)
  request POST "/change-requests" "$SESSION_ORG_A" "$(cr_body "$ORG_A_UUID" site '[
      { "op": "update", "data": { "type": "sites", "id": "'"$SITE_UUID"'",
        "relationships": { "contacts": { "data": [] } } } },
      { "op": "delete", "data": { "type": "contact-points", "id": "'"$CONTACT_UUID"'" } } ]')"
  expect "organisation A clears the contacts of the site with an empty list and deletes the contact point" 201 '.data.attributes.status == "goedgekeurd"'
  check_data "the site has no contact point left, and still its address; the contact point is gone" "
    PREFIX org: <http://www.w3.org/ns/org#> PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    PREFIX organisatie: <https://data.vlaanderen.be/ns/organisatie#>
    ASK { ?site mu:uuid \"$SITE_UUID\" ; organisatie:bestaatUit ?address .
          FILTER NOT EXISTS { ?site org:siteAddress ?contact } FILTER NOT EXISTS { ?gone mu:uuid \"$CONTACT_UUID\" } }" true

  request POST "/change-requests" "$SESSION_ORG_A" "$(cr_body "$ORG_A_UUID" site '[
      { "op": "delete", "data": { "type": "sites", "id": "'"$SITE_UUID"'" } },
      { "op": "delete", "data": { "type": "addresses", "id": "'"$ADDRESS_UUID"'" } } ]')"
  expect "organisation A deletes the site and its address" 201 '.data.attributes.status == "goedgekeurd"'
  check_data "the deleted records are gone from the triplestore, the link from A included" "
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/> PREFIX org: <http://www.w3.org/ns/org#>
    ASK { { VALUES ?uuid { \"$SITE_UUID\" \"$ADDRESS_UUID\" \"$CONTACT_UUID\" } ?s mu:uuid ?uuid . }
          UNION { ?org mu:uuid \"$ORG_A_UUID\" ; org:hasSite <http://data.lblod.info/id/vestigingen/$SITE_UUID> . } }" false
  check_data "the versions keep their link to the deleted site" "
    PREFIX dct: <http://purl.org/dc/terms/> PREFIX cr: <http://lblod.data.gift/vocabularies/change-requests/>
    ASK { ?version a cr:Version ; dct:isVersionOf <http://data.lblod.info/id/vestigingen/$SITE_UUID> ; cr:deleted true ; cr:operation \"delete\" . }" true
fi

# --- ABB edits organisation B -----------------------------------------------------------------
request GET "/administrative-units/$ORG_B_UUID/sites" "$SESSION_ORG_B"
SITES_OF_B=$(echo "$BODY" | jq -c '[.data[]? | { type: "sites", id: .id }]' 2>/dev/null || echo '[]')
request POST "/change-requests" "$SESSION_ABB" "$(create_site_body "$ORG_B_UUID" "$SITES_OF_B")"
expect "ABB creates a site with an address and a contact point under organisation B" 201 '.data.attributes.status == "goedgekeurd" and .data.relationships["requesting-organisation"].data.id != "'"$ORG_B_UUID"'"'
ABB_SITE_UUID=$(echo "$BODY" | jq -r '.data.attributes.lids.s1 // empty')
ABB_ADDRESS_UUID=$(echo "$BODY" | jq -r '.data.attributes.lids.a1 // empty')
ABB_CONTACT_UUID=$(echo "$BODY" | jq -r '.data.attributes.lids.c1 // empty')
ABB_REQUEST_ID=$(echo "$BODY" | jq -r '.data.id // empty')

if [ -n "$ABB_REQUEST_ID" ]; then
  request GET "/change-requests?filter[target]=$ORG_B_UUID" "$SESSION_ORG_B"
  expect "organisation B sees the request ABB made about it" 200 '[.data[] | select(.id == "'"$ABB_REQUEST_ID"'")] | length == 1'
fi

if [ -n "$ABB_SITE_UUID" ]; then
  request POST "/change-requests" "$SESSION_ABB" "$(cr_body "$ORG_B_UUID" site '[
      { "op": "delete", "data": { "type": "sites", "id": "'"$ABB_SITE_UUID"'" } },
      { "op": "delete", "data": { "type": "addresses", "id": "'"$ABB_ADDRESS_UUID"'" } },
      { "op": "delete", "data": { "type": "contact-points", "id": "'"$ABB_CONTACT_UUID"'" } } ]')"
  expect "ABB deletes them again" 201 '.data.attributes.status == "goedgekeurd"'
  check_data "the records ABB created under B are gone" "
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    ASK { VALUES ?uuid { \"$ABB_SITE_UUID\" \"$ABB_ADDRESS_UUID\" \"$ABB_CONTACT_UUID\" } ?s mu:uuid ?uuid . }" false
fi

echo
echo "$PASSED passed, $FAILED failed, $SKIPPED skipped"
[ "$FAILED" -eq 0 ]
