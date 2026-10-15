#!/usr/bin/env bash
# End-to-end check of change-request-service in app-rvs, as a browser would do it: through
# mu-identifier, logged in with mock-login as two gemeenten and as ABB. Every change it makes is
# put back at the end through change requests (the requests themselves stay, as history).
#
#   BASE_URL         the identifier (default http://localhost:88, app-rvs docker-compose.dev.yml)
#   SPARQL_ENDPOINT  Virtuoso, to look up accounts and check graphs (default http://localhost:8899/sparql)
#   ORG_A_LABEL, ORG_B_LABEL  two gemeenten by name (default Aalst and Gent)
set -u
BASE=${BASE_URL:-http://localhost:88}
SPARQL=${SPARQL_ENDPOINT:-http://localhost:8899/sparql}
ORG_A_LABEL=${ORG_A_LABEL:-Aalst}
ORG_B_LABEL=${ORG_B_LABEL:-Gent}
J='Accept: application/vnd.api+json'
CT='Content-Type: application/vnd.api+json'
TMP=$(mktemp -d)
pass=0; fail=0
ok()  { echo "PASS  $*"; pass=$((pass+1)); }
nok() { echo "FAIL  $*"; fail=$((fail+1)); }
check() { local name="$1" expected="$2" actual="$3"; if [ "$actual" = "$expected" ]; then ok "$name ($actual)"; else nok "$name: expected $expected, got $actual"; fi; }

sparql() { curl -s -H 'Accept: application/sparql-results+json' --data-urlencode "query=$1" "$SPARQL"; }

# org uuid + account uuid of the gemeente with a given label
lookup() {
  sparql "PREFIX besluit: <http://data.vlaanderen.be/ns/besluit#>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX org: <http://www.w3.org/ns/org#>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?orgUuid ?accUuid WHERE { GRAPH <http://mu.semte.ch/graphs/public> {
  ?org a besluit:Bestuurseenheid ; mu:uuid ?orgUuid ; skos:prefLabel \"$1\" ; org:classification <$2> .
  ?p foaf:member ?org ; foaf:account ?acc . ?acc mu:uuid ?accUuid . } } LIMIT 1" |
  python3 -c "import json,sys; b=json.load(sys.stdin)['results']['bindings'][0]; print(b['orgUuid']['value'], b['accUuid']['value'])"
}
GEMEENTE=http://data.vlaanderen.be/id/concept/BestuurseenheidClassificatieCode/5ab0e9b8a3b2ca7c5e000001
ABBCODE=http://data.vlaanderen.be/id/concept/BestuurseenheidClassificatieCode/52cc9d8d-1c9a-4d92-9936-da9d4a622ec4
read -r A_ORG A_ACC < <(lookup "$ORG_A_LABEL" "$GEMEENTE")
read -r B_ORG B_ACC < <(lookup "$ORG_B_LABEL" "$GEMEENTE")
read -r ABB_ORG ABB_ACC < <(lookup "Agentschap Binnenlands Bestuur" "$ABBCODE")
echo "A=$ORG_A_LABEL $A_ORG  B=$ORG_B_LABEL $B_ORG  ABB $ABB_ORG"

login() { # jar account group
  curl -s -o /dev/null -w '%{http_code}' -c "$1" -b "$1" -X POST -H "$J" -H "$CT" \
    --data "{\"data\":{\"type\":\"sessions\",\"relationships\":{\"account\":{\"data\":{\"type\":\"accounts\",\"id\":\"$2\"}},\"group\":{\"data\":{\"type\":\"groups\",\"id\":\"$3\"}}}}}" \
    "$BASE/mock/sessions"
}
get()  { curl -s -g -c "$1" -b "$1" -H "$J" "$BASE$2"; }
code() { curl -s -g -o /dev/null -w '%{http_code}' -c "$1" -b "$1" -H "$J" "$BASE$2"; }
post() { curl -s -o "$TMP/body" -w '%{http_code}' -c "$1" -b "$1" -X POST -H "$J" -H "$CT" --data "$3" "$BASE$2"; }
name_of() { get "$1" "/administrative-units/$2" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['attributes']['name'])"; }
rename() { # jar target name
  post "$1" /change-requests "{\"data\":{\"type\":\"change-requests\",\"attributes\":{\"aggregate\":\"organization-core-data\",\"operations\":[{\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$2\",\"attributes\":{\"name\":\"$3\"}}}]},\"relationships\":{\"target\":{\"data\":{\"type\":\"organizations\",\"id\":\"$2\"}}}}}"
}

JA=$TMP/a; JB=$TMP/b; JABB=$TMP/abb; JANON=$TMP/anon
check "mock-login as A" 201 "$(login "$JA" "$A_ACC" "$A_ORG")"
check "mock-login as B" 201 "$(login "$JB" "$B_ACC" "$B_ORG")"
check "mock-login as ABB" 201 "$(login "$JABB" "$ABB_ACC" "$ABB_ORG")"

A_NAME=$(name_of "$JA" "$A_ORG")
[ -n "$A_NAME" ] && ok "A reads its organisation ($A_NAME)" || nok "A cannot read its organisation"
check "anonymous read of an organisation (the public graph is readable without login)" 200 "$(code "$JANON" "/administrative-units/$A_ORG")"

perm() { get "$1" "/change-requests/permissions?target=$2" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('can-edit'), ','.join(d.get('rules',[])))"; }
check "permissions: A on A" "True own-organisation" "$(perm "$JA" "$A_ORG")"
check "permissions: B on A" "False " "$(perm "$JB" "$A_ORG")"
check "permissions: ABB on B" "True abb-edits-all" "$(perm "$JABB" "$B_ORG")"
check "permissions without login" 401 "$(code "$JANON" "/change-requests/permissions?target=$A_ORG")"

check "A renames itself through a change request" 201 "$(rename "$JA" "$A_ORG" "$A_NAME (test RVS)")"
status=$(python3 -c "import json; print(json.load(open('$TMP/body'))['data']['attributes']['status'])")
check "the request is applied at once" goedgekeurd "$status"
check "the new name is visible through mu-cl-resources" "$A_NAME (test RVS)" "$(name_of "$JA" "$A_ORG")"

check "B cannot rename A" 403 "$(rename "$JB" "$A_ORG" "Gent was here")"
check "A keeps its name" "$A_NAME (test RVS)" "$(name_of "$JA" "$A_ORG")"

patch=$(curl -s -o /dev/null -w '%{http_code}' -c "$JA" -b "$JA" -X PATCH -H "$J" -H "$CT" --data "{\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"attributes\":{\"name\":\"direct write\"}}}" "$BASE/administrative-units/$A_ORG")
if [ "$patch" != 200 ] && [ "$patch" != 204 ]; then ok "a direct PATCH on the resource route is refused ($patch)"; else nok "a direct PATCH succeeded ($patch)"; fi
forged=$(curl -s -o /dev/null -w '%{http_code}' -c "$JA" -b "$JA" -X PATCH -H "$J" -H "$CT" -H 'mu-auth-scope: http://services.lblod.info/change-request-service' -H 'mu-auth-sudo: true' --data "{\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"attributes\":{\"name\":\"forged scope\"}}}" "$BASE/administrative-units/$A_ORG")
if [ "$forged" != 200 ] && [ "$forged" != 204 ]; then ok "a PATCH with forged mu-auth-scope and mu-auth-sudo headers is refused ($forged)"; else nok "a forged-scope PATCH succeeded ($forged)"; fi
check "A still carries the change-request name" "$A_NAME (test RVS)" "$(name_of "$JA" "$A_ORG")"

list_count() { get "$1" "/change-requests?filter[target]=$2" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['data']))"; }
na=$(list_count "$JA" "$A_ORG"); nb=$(list_count "$JB" "$A_ORG"); nabb=$(list_count "$JABB" "$A_ORG")
[ "$na" -ge 1 ] && ok "A lists its requests ($na)" || nok "A lists $na requests"
check "B lists none of A's requests" 0 "$nb"
[ "$nabb" -ge 1 ] && ok "ABB lists A's requests ($nabb)" || nok "ABB lists $nabb requests"

# a new vestiging with address and contact point, linked to A (site aggregate)
SITE="{\"data\":{\"type\":\"change-requests\",\"attributes\":{\"aggregate\":\"site\",\"operations\":[
 {\"op\":\"create\",\"data\":{\"type\":\"addresses\",\"lid\":\"a1\",\"attributes\":{\"street\":\"Grote Markt\",\"number\":\"3\",\"postcode\":\"9300\",\"municipality\":\"$ORG_A_LABEL\",\"country\":\"België\",\"full-address\":\"Grote Markt 3, $ORG_A_LABEL, België\"}}},
 {\"op\":\"create\",\"data\":{\"type\":\"contact-points\",\"lid\":\"c1\",\"attributes\":{\"email\":\"loket@example.org\",\"type\":\"Primary\"}}},
 {\"op\":\"create\",\"data\":{\"type\":\"sites\",\"lid\":\"s1\",\"attributes\":{\"site-type-name\":\"Testvestiging\"},\"relationships\":{\"address\":{\"data\":{\"type\":\"addresses\",\"lid\":\"a1\"}},\"contacts\":{\"data\":[{\"type\":\"contact-points\",\"lid\":\"c1\"}]}}}},
 {\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"relationships\":{\"sites\":{\"data\":[{\"type\":\"sites\",\"lid\":\"s1\"}]}}}}
 ]},\"relationships\":{\"target\":{\"data\":{\"type\":\"organizations\",\"id\":\"$A_ORG\"}}}}}"
check "A adds a vestiging with address and contact point" 201 "$(post "$JA" /change-requests "$SITE")"
SITE_ID=$(python3 -c "import json; print(json.load(open('$TMP/body'))['data']['attributes']['lids']['s1'])" 2>/dev/null)
ADDR_ID=$(python3 -c "import json; print(json.load(open('$TMP/body'))['data']['attributes']['lids']['a1'])" 2>/dev/null)
CP_ID=$(python3 -c "import json; print(json.load(open('$TMP/body'))['data']['attributes']['lids']['c1'])" 2>/dev/null)
street=$(get "$JA" "/administrative-units/$A_ORG/sites?include=address" | python3 -c "import json,sys; d=json.load(sys.stdin); print(','.join(i['attributes'].get('street','') for i in d.get('included',[]) if i['type']=='addresses'))")
check "the vestiging and its address are visible under A" "Grote Markt" "$street"

# the records live in the right graphs
ask() { sparql "ASK { $1 }" | python3 -c "import json,sys; print(json.load(sys.stdin)['boolean'])"; }
check "requests are in the change-requests graph" True "$(ask 'GRAPH <http://mu.semte.ch/graphs/change-requests> { ?r a <http://lblod.data.gift/vocabularies/change-requests/ChangeRequest> }')"
check "no request or version leaks into the public graph" False "$(ask 'GRAPH <http://mu.semte.ch/graphs/public> { ?r a ?t . VALUES ?t { <http://lblod.data.gift/vocabularies/change-requests/ChangeRequest> <http://lblod.data.gift/vocabularies/change-requests/Version> } }')"
check "A carries dct:modified and ext:lastModifiedBy" True "$(ask "GRAPH <http://mu.semte.ch/graphs/public> { ?o <http://mu.semte.ch/vocabularies/core/uuid> \"$A_ORG\" ; <http://purl.org/dc/terms/modified> ?m ; <http://mu.semte.ch/vocabularies/ext/lastModifiedBy> ?by }")"

# ABB edits another organisation, and puts things back
check "ABB renames A back" 201 "$(rename "$JABB" "$A_ORG" "$A_NAME")"
check "the original name is back" "$A_NAME" "$(name_of "$JA" "$A_ORG")"
UNSITE="{\"data\":{\"type\":\"change-requests\",\"attributes\":{\"aggregate\":\"site\",\"operations\":[
 {\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"relationships\":{\"sites\":{\"data\":[]}}}},
 {\"op\":\"delete\",\"data\":{\"type\":\"sites\",\"id\":\"$SITE_ID\"}},
 {\"op\":\"delete\",\"data\":{\"type\":\"addresses\",\"id\":\"$ADDR_ID\"}},
 {\"op\":\"delete\",\"data\":{\"type\":\"contact-points\",\"id\":\"$CP_ID\"}}
 ]},\"relationships\":{\"target\":{\"data\":{\"type\":\"organizations\",\"id\":\"$A_ORG\"}}}}}"
check "A removes the test vestiging again" 201 "$(post "$JA" /change-requests "$UNSITE")"
check "the test vestiging is gone" False "$(ask "?s <http://mu.semte.ch/vocabularies/core/uuid> \"$SITE_ID\"")"

echo; echo "$pass passed, $fail failed"
rm -rf "$TMP"
