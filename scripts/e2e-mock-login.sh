#!/usr/bin/env bash
# End-to-end check of change-request-service in app-rvs, as a browser would do it: through
# mu-identifier, logged in with mock-login as two gemeenten and as ABB. Every change it makes is
# put back at the end through change requests, and every request it leaves pending is closed (the
# requests themselves stay, as history).
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

# The service may still be starting: in development mode the template restarts it on every change
# to the mounted sources. It answers 401 without a session once it is up (the dispatcher a 5xx before).
for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "$J" "$BASE/change-requests/permissions?target=-")" = 401 ] && break
  sleep 2
done

# org uuid + account uuid + person uuid of the gemeente with a given label
lookup() {
  sparql "PREFIX besluit: <http://data.vlaanderen.be/ns/besluit#>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX org: <http://www.w3.org/ns/org#>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?orgUuid ?accUuid ?personUuid WHERE { GRAPH <http://mu.semte.ch/graphs/public> {
  ?org a besluit:Bestuurseenheid ; mu:uuid ?orgUuid ; skos:prefLabel \"$1\" ; org:classification <$2> .
  ?p foaf:member ?org ; foaf:account ?acc ; mu:uuid ?personUuid . ?acc mu:uuid ?accUuid . } } LIMIT 1" |
  python3 -c "import json,sys; b=json.load(sys.stdin)['results']['bindings'][0]; print(b['orgUuid']['value'], b['accUuid']['value'], b['personUuid']['value'])"
}
GEMEENTE=http://data.vlaanderen.be/id/concept/BestuurseenheidClassificatieCode/5ab0e9b8a3b2ca7c5e000001
ABBCODE=http://data.vlaanderen.be/id/concept/BestuurseenheidClassificatieCode/52cc9d8d-1c9a-4d92-9936-da9d4a622ec4
read -r A_ORG A_ACC A_PERSON < <(lookup "$ORG_A_LABEL" "$GEMEENTE")
read -r B_ORG B_ACC B_PERSON < <(lookup "$ORG_B_LABEL" "$GEMEENTE")
read -r ABB_ORG ABB_ACC ABB_PERSON < <(lookup "Agentschap Binnenlands Bestuur" "$ABBCODE")
echo "A=$ORG_A_LABEL $A_ORG  B=$ORG_B_LABEL $B_ORG  ABB $ABB_ORG"

login() { # jar account group
  curl -s -o /dev/null -w '%{http_code}' -c "$1" -b "$1" -X POST -H "$J" -H "$CT" \
    --data "{\"data\":{\"type\":\"sessions\",\"relationships\":{\"account\":{\"data\":{\"type\":\"accounts\",\"id\":\"$2\"}},\"group\":{\"data\":{\"type\":\"groups\",\"id\":\"$3\"}}}}}" \
    "$BASE/mock/sessions"
}
get()  { curl -s -g -c "$1" -b "$1" -H "$J" "$BASE$2"; }
code() { curl -s -g -o /dev/null -w '%{http_code}' -c "$1" -b "$1" -H "$J" "$BASE$2"; }
# fetch JAR PATH: GET into $TMP/body, prints the status
fetch() { curl -s -g -o "$TMP/body" -w '%{http_code}' -c "$1" -b "$1" -H "$J" "$BASE$2"; }
post() { curl -s -o "$TMP/body" -w '%{http_code}' -c "$1" -b "$1" -X POST -H "$J" -H "$CT" --data "$3" "$BASE$2"; }
name_of() { get "$1" "/administrative-units/$2" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['attributes']['name'])"; }
# py EXPRESSION: a Python expression over the JSON of the last body (d), with helpers for requests
py() {
  python3 - "$1" "$TMP/body" <<'PY' 2>/dev/null
import json, sys
d = json.load(open(sys.argv[2]))
a = d['data']['attributes'] if isinstance(d.get('data'), dict) else {}
def steps(d=d):
    return ' | '.join(' '.join(str(s[k]) for k in ('sequence', 'type', 'status', 'agent', 'person', 'organisation', 'rule')) for s in d['data']['attributes']['steps'])
def conflicts(items):
    return ' | '.join(f"{c['resource']['type']} {c['key']}: base {c['base']}, current {c['current']}, proposed {c['proposed']}, competing {','.join(c['competing-requests']) or '-'}" for c in items)
value = eval(sys.argv[1])
print(json.dumps(value) if isinstance(value, (dict, list)) or value is None else value)
PY
}
cr_body() { # target operations-json
  printf '{"data":{"type":"change-requests","attributes":{"aggregate":"organization-core-data","operations":%s},"relationships":{"target":{"data":{"type":"organizations","id":"%s"}}}}}' "$2" "$1"
}
rename() { # jar target name
  post "$1" /change-requests "$(cr_body "$2" "[{\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$2\",\"attributes\":{\"name\":\"$3\"}}}]")"
}
stale_rename() { # jar target name base-name: a form that loaded base-name proposes name
  post "$1" /change-requests "$(cr_body "$2" "[{\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$2\",\"attributes\":{\"name\":\"$3\"},\"meta\":{\"base\":{\"attributes\":{\"name\":\"$4\"}}}}}]")"
}
take_step() { # jar request-id step-type [reason] [override]
  local attributes="\"step-type\":\"$3\""
  if [ -n "${4:-}" ]; then attributes="$attributes,\"reason\":\"$4\""; fi
  if [ -n "${5:-}" ]; then attributes="$attributes,\"override\":$5"; fi
  post "$1" "/change-requests/$2/steps" "{\"data\":{\"type\":\"change-request-steps\",\"attributes\":{$attributes}}}"
}
PENDING=()  # requests this run leaves ingediend for a while; closed at the end if still pending
ask() { sparql "ASK { $1 }" | python3 -c "import json,sys; print(json.load(sys.stdin)['boolean'])"; }
CR=http://lblod.data.gift/vocabularies/change-requests/
RDF=http://www.w3.org/1999/02/22-rdf-syntax-ns#
DCT=http://purl.org/dc/terms/
PROV=http://www.w3.org/ns/prov#
MU=http://mu.semte.ch/vocabularies/core/

JA=$TMP/a; JB=$TMP/b; JABB=$TMP/abb; JANON=$TMP/anon
check "mock-login as A" 201 "$(login "$JA" "$A_ACC" "$A_ORG")"
check "mock-login as B" 201 "$(login "$JB" "$B_ACC" "$B_ORG")"
check "mock-login as ABB" 201 "$(login "$JABB" "$ABB_ACC" "$ABB_ORG")"

A_NAME=$(name_of "$JA" "$A_ORG")
B_NAME=$(name_of "$JB" "$B_ORG")
[ -n "$A_NAME" ] && ok "A reads its organisation ($A_NAME)" || nok "A cannot read its organisation"
check "anonymous read of an organisation (the public graph is readable without login)" 200 "$(code "$JANON" "/administrative-units/$A_ORG")"
fetch "$JA" "/administrative-units/$A_ORG" >/dev/null
A_LEGAL=$(py "json.dumps(a.get('legal-name'))")

perm() { get "$1" "/change-requests/permissions?target=$2" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('can-edit'), ','.join(d.get('rules',[])))"; }
check "permissions: A on A" "True own-organisation" "$(perm "$JA" "$A_ORG")"
check "permissions: B on A" "False " "$(perm "$JB" "$A_ORG")"
check "permissions: ABB on B" "True abb-edits-all" "$(perm "$JABB" "$B_ORG")"
check "permissions without login" 401 "$(code "$JANON" "/change-requests/permissions?target=$A_ORG")"

# --- an auto-approved request and its steps ------------------------------------------------------
NAME0="$A_NAME (test RVS)"
check "A renames itself through a change request" 201 "$(rename "$JA" "$A_ORG" "$NAME0")"
check "the request is applied at once" goedgekeurd "$(py "a['status']")"
AUTO_ID=$(py "d['data']['id']")
EXPECTED_STEPS="1 indiening ingediend user $A_PERSON $A_ORG own-organisation | 2 goedkeuring goedgekeurd service None None always"
check "its steps: indiening by A's person and organisation, goedkeuring by the service (rule always)" "$EXPECTED_STEPS" "$(py "steps()")"
check "its status is the status of its last step" True "$(py "a['status'] == a['steps'][-1]['status']")"
check "the new name is visible through mu-cl-resources" "$NAME0" "$(name_of "$JA" "$A_ORG")"
check "the stored request reads back" 200 "$(fetch "$JA" "/change-requests/$AUTO_ID")"
check "the stored steps read back the same" "$EXPECTED_STEPS" "$(py "steps()")"
check "applied-at is the start of the goedkeuring step" True "$(py "a['applied-at'] == a['steps'][1]['at'] and a['error'] is None and a['conflicts'] == []")"

check "B cannot rename A" 403 "$(rename "$JB" "$A_ORG" "Gent was here")"
check "A keeps its name" "$NAME0" "$(name_of "$JA" "$A_ORG")"

patch=$(curl -s -o /dev/null -w '%{http_code}' -c "$JA" -b "$JA" -X PATCH -H "$J" -H "$CT" --data "{\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"attributes\":{\"name\":\"direct write\"}}}" "$BASE/administrative-units/$A_ORG")
if [ "$patch" != 200 ] && [ "$patch" != 204 ]; then ok "a direct PATCH on the resource route is refused ($patch)"; else nok "a direct PATCH succeeded ($patch)"; fi
forged=$(curl -s -o /dev/null -w '%{http_code}' -c "$JA" -b "$JA" -X PATCH -H "$J" -H "$CT" -H 'mu-auth-scope: http://services.lblod.info/change-request-service' -H 'mu-auth-sudo: true' --data "{\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"attributes\":{\"name\":\"forged scope\"}}}" "$BASE/administrative-units/$A_ORG")
if [ "$forged" != 200 ] && [ "$forged" != 204 ]; then ok "a PATCH with forged mu-auth-scope and mu-auth-sudo headers is refused ($forged)"; else nok "a forged-scope PATCH succeeded ($forged)"; fi
check "A still carries the change-request name" "$NAME0" "$(name_of "$JA" "$A_ORG")"

list_count() { get "$1" "/change-requests?filter[target]=$2" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['data']))"; }
na=$(list_count "$JA" "$A_ORG"); nb=$(list_count "$JB" "$A_ORG"); nabb=$(list_count "$JABB" "$A_ORG")
[ "$na" -ge 1 ] && ok "A lists its requests ($na)" || nok "A lists $na requests"
check "B lists none of A's requests" 0 "$nb"
[ "$nabb" -ge 1 ] && ok "ABB lists A's requests ($nabb)" || nok "ABB lists $nabb requests"
fetch "$JA" "/change-requests?filter[target]=$A_ORG" >/dev/null
check "every listed request has steps and conflicts" True "$(py "all(isinstance(r['attributes']['steps'], list) and isinstance(r['attributes']['conflicts'], list) for r in d['data'])")"
check "the list is paged: page[size]=1 gives one request, meta.count counts them all, next links the rest" "1 True True" "$(fetch "$JA" "/change-requests?filter[target]=$A_ORG&page[size]=1" >/dev/null; py "f\"{len(d['data'])} {d['meta']['count'] >= $na} {('next' in d['links']) == (d['meta']['count'] > 1)}\"")"
check "a page size above the maximum: 400" 400 "$(code "$JA" "/change-requests?page[size]=1000")"

# --- a stale form: ABB renamed A after A's page loaded it -----------------------------------------
ABB_NAME="$A_NAME (ABB, test RVS)"
check "ABB renames A" 201 "$(rename "$JABB" "$A_ORG" "$ABB_NAME")"
check "ABB's rename is applied" goedgekeurd "$(py "a['status']")"

STALE="$A_NAME (A, stale form)"
check "A submits a rename from a form that still shows the old name" 201 "$(stale_rename "$JA" "$A_ORG" "$STALE" "$NAME0")"
P1=$(py "d['data']['id']"); PENDING+=("$P1")
check "the request waits: status ingediend, only the indiening step" "ingediend 1" "$(py "a['status'] + ' ' + str(len(a['steps']))")"
check "A's change of the name is listed as a conflict" "administrative-units name: base $NAME0, current $ABB_NAME, proposed $STALE, competing -" "$(py "conflicts(a['conflicts'])")"
check "nothing is applied: the name is ABB's" "$ABB_NAME" "$(name_of "$JA" "$A_ORG")"

OTHER="$A_NAME (A, another stale form)"
check "a second stale form proposes another name" 201 "$(stale_rename "$JA" "$A_ORG" "$OTHER" "$NAME0")"
P2=$(py "d['data']['id']"); PENDING+=("$P2")
check "it waits too, and names the first pending request as competing" "ingediend administrative-units name: base $NAME0, current $ABB_NAME, proposed $OTHER, competing $P1" "$(py "a['status'] + ' ' + conflicts(a['conflicts'])")"
check "ABB reads the first pending request" 200 "$(fetch "$JABB" "/change-requests/$P1")"
check "its conflict is computed live and names the second as competing" "administrative-units name: base $NAME0, current $ABB_NAME, proposed $STALE, competing $P2" "$(py "conflicts(a['conflicts'])")"

LEGAL="$A_NAME (legal name, test RVS)"
SAME_FORM=$(cr_body "$A_ORG" "[{\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"attributes\":{\"name\":\"$NAME0\",\"legal-name\":\"$LEGAL\"},\"meta\":{\"base\":{\"attributes\":{\"name\":\"$NAME0\",\"legal-name\":$A_LEGAL}}}}}]")
check "the same stale form changes only the legal name (the old name carried unchanged)" 201 "$(post "$JA" /change-requests "$SAME_FORM")"
check "it is applied: no conflict on a key the user did not change" "goedgekeurd []" "$(py "a['status'] + ' ' + json.dumps(a['conflicts'])")"
fetch "$JA" "/administrative-units/$A_ORG" >/dev/null
check "the legal name is changed and the name is NOT reverted" "$LEGAL / $ABB_NAME" "$(py "a['legal-name'] + ' / ' + a['name']")"

# --- deciding on pending requests: approval re-checks, rejection, withdrawal -------------------------
check "ABB's approval of the second pending request without override: 409, conflicts re-checked" 409 "$(take_step "$JABB" "$P2" goedkeuring)"
check "the 409 lists the conflict" "administrative-units name: base $NAME0, current $ABB_NAME, proposed $OTHER, competing $P1" "$(py "conflicts(d['errors'][0]['meta']['conflicts'])")"
TOKEN=$(py "d['errors'][0]['meta']['conflicts-token']")
check "the 409 carries the token of these conflicts, the one GET shows" "$TOKEN" "$(fetch "$JABB" "/change-requests/$P2" >/dev/null; py "a['conflicts-token']")"
check "approving with the token of other conflicts: 409, nothing applied" "409 $ABB_NAME" "$(take_step "$JABB" "$P2" goedkeuring "" '"0123abcd"') $(name_of "$JA" "$A_ORG")"
check "override true is refused: it must be the token of the conflicts reviewed" 422 "$(take_step "$JABB" "$P2" goedkeuring "" true)"
check "a rejection without a reason: 422" 422 "$(take_step "$JABB" "$P1" afkeuring)"
REASON="De naam werd intussen door ABB aangepast"
check "ABB rejects the first pending request with a reason" 201 "$(take_step "$JABB" "$P1" afkeuring "$REASON")"
check "it is afgekeurd; the step carries ABB's person and organisation, the rule and the reason" "afgekeurd | 2 afkeuring afgekeurd user $ABB_PERSON $ABB_ORG abb-decides-all | $REASON" "$(py "a['status'] + ' | ' + steps().split(' | ')[1] + ' | ' + a['steps'][1]['reason']")"
check "the rejection reads back from the store" "2 afkeuring afgekeurd user $ABB_PERSON $ABB_ORG abb-decides-all $REASON" "$(fetch "$JA" "/change-requests/$P1" >/dev/null; py "steps().split(' | ')[1] + ' ' + a['steps'][1]['reason']")"
check "approving the rejected request: 409, afgekeurd is final" 409 "$(take_step "$JABB" "$P1" goedkeuring)"
check "withdrawing it: 409 as well" 409 "$(take_step "$JA" "$P1" intrekking)"
check "A withdraws its second pending request" 201 "$(take_step "$JA" "$P2" intrekking)"
check "it is ingetrokken; the step is A's (rule requesting-organisation)" "ingetrokken | 2 intrekking ingetrokken user $A_PERSON $A_ORG requesting-organisation" "$(py "a['status'] + ' | ' + steps().split(' | ')[1]")"
check "the name is still ABB's" "$ABB_NAME" "$(name_of "$JA" "$A_ORG")"

# --- a newer request of the same organisation replaces its older pending one -------------------------
AGAIN="$A_NAME (A, stale form again)"
check "A submits a rename from a stale form once more" 201 "$(stale_rename "$JA" "$A_ORG" "$AGAIN" "$NAME0")"
P3=$(py "d['data']['id']"); PENDING+=("$P3")
check "it waits" ingediend "$(py "a['status']")"
FRESH="$A_NAME (A, fresh form)"
check "A renames itself from a fresh form that shows ABB's name" 201 "$(stale_rename "$JA" "$A_ORG" "$FRESH" "$ABB_NAME")"
NEWER=$(py "d['data']['id']")
check "it is applied and replaces the waiting request" "goedgekeurd $P3" "$(py "a['status'] + ' ' + ','.join(a.get('superseded', []))")"
check "the waiting request is withdrawn by the service, which names the newer one" "ingetrokken | 2 intrekking ingetrokken service None None superseded-by-own-request | Vervangen door wijzigingsaanvraag $NEWER" "$(fetch "$JA" "/change-requests/$P3" >/dev/null; py "a['status'] + ' | ' + steps().split(' | ')[1] + ' | ' + a['steps'][1]['reason']")"
check "the waiting request names the newer one as dct:isReplacedBy, and so does the API" "True $NEWER" "$(ask "GRAPH <http://mu.semte.ch/graphs/change-requests> { ?old <${MU}uuid> \"$P3\" ; <${DCT}isReplacedBy> ?new . ?new <${MU}uuid> \"$NEWER\" }") $(fetch "$JA" "/change-requests/$P3" >/dev/null; py "a['replaced-by']")"
check "the name is the fresh form's" "$FRESH" "$(name_of "$JA" "$A_ORG")"

# --- ABB approves a request despite its conflict; the state the approval replaced keeps what it overwrote
OVERRIDE="$A_NAME (A, approved over ABB's name)"
check "A submits a rename from a form that still shows the first test name" 201 "$(stale_rename "$JA" "$A_ORG" "$OVERRIDE" "$NAME0")"
P4=$(py "d['data']['id']"); PENDING+=("$P4")
check "it waits with a conflict on the name" "ingediend administrative-units name: base $NAME0, current $FRESH, proposed $OVERRIDE, competing -" "$(py "a['status'] + ' ' + conflicts(a['conflicts'])")"
P4_TOKEN=$(py "a['conflicts-token']")
check "ABB approves it with the token of that conflict" 201 "$(take_step "$JABB" "$P4" goedkeuring "" "\"$P4_TOKEN\"")"
check "the answer shows the conflict the approval overrode" "goedgekeurd True administrative-units name: base $NAME0, current $FRESH, proposed $OVERRIDE, competing -" "$(py "a['status'] + ' ' + str(a['steps'][1]['overrides-conflict']) + ' ' + conflicts([dict(c, **{'competing-requests': []}) for c in a['steps'][1]['overridden-conflicts']])")"
check "read back, it is derived from the state the goedkeuring replaced" "True administrative-units name: base $NAME0, current $FRESH, proposed $OVERRIDE, competing -" "$(fetch "$JA" "/change-requests/$P4" >/dev/null; py "str(a['steps'][1]['overrides-conflict']) + ' ' + conflicts([dict(c, **{'competing-requests': []}) for c in a['steps'][1]['overridden-conflicts']])")"
check "that state holds the name the approval overwrote" True "$(ask "GRAPH <http://mu.semte.ch/graphs/change-requests> { ?r <${MU}uuid> \"$P4\" . ?s a <${CR}Action> ; <${DCT}isPartOf> ?r ; <${PROV}invalidated> ?state . ?state a <${CR}RecordState> ; <http://www.w3.org/2004/02/skos/core#prefLabel> \"$FRESH\" }")"
check "the name is the approved one" "$OVERRIDE" "$(name_of "$JA" "$A_ORG")"

# B: only ABB decides, also on B's own request
check "B submits a rename of itself from a stale form" 201 "$(stale_rename "$JB" "$B_ORG" "$B_NAME (B, test RVS)" "$B_NAME (old)")"
PB=$(py "d['data']['id']"); PENDING+=("$PB")
check "B's request waits" ingediend "$(py "a['status']")"
check "B approves its own pending request: 403" 403 "$(take_step "$JB" "$PB" goedkeuring)"
check "the 403 names no rule that allowed it" "null" "$(py "d['errors'][0]['meta']['rule']")"
check "B rejects it: 403 as well" 403 "$(take_step "$JB" "$PB" afkeuring "zelf afgekeurd")"
check "B cannot take a step on a request of A it cannot see: 404" 404 "$(take_step "$JB" "$P1" intrekking)"
check "B withdraws its request" 201 "$(take_step "$JB" "$PB" intrekking)"
check "B keeps its name" "$B_NAME" "$(name_of "$JB" "$B_ORG")"
check "an unknown step type: 422" 422 "$(take_step "$JA" "$P2" goedkeuren)"

# --- a new vestiging with address and contact point, linked to A (site aggregate) ------------------
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

# a second vestiging from a page that loaded A before the first one existed: the sites merge
SITE2="{\"data\":{\"type\":\"change-requests\",\"attributes\":{\"aggregate\":\"site\",\"operations\":[
 {\"op\":\"create\",\"data\":{\"type\":\"sites\",\"lid\":\"s2\",\"attributes\":{\"site-type-name\":\"Tweede testvestiging\"}}},
 {\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"relationships\":{\"sites\":{\"data\":[{\"type\":\"sites\",\"lid\":\"s2\"}]}},\"meta\":{\"base\":{\"relationships\":{\"sites\":{\"data\":[]}}}}}}
 ]},\"relationships\":{\"target\":{\"data\":{\"type\":\"organizations\",\"id\":\"$A_ORG\"}}}}}"
check "a page that loaded A without the first vestiging adds a second one" 201 "$(post "$JA" /change-requests "$SITE2")"
check "it is applied without a conflict: the new vestiging is added to the sites, not put in their place" "goedgekeurd []" "$(py "a['status'] + ' ' + json.dumps(a['conflicts'])")"
SITE2_ID=$(py "a['lids']['s2']")
linked() { ask "GRAPH <http://mu.semte.ch/graphs/public> { ?o <http://mu.semte.ch/vocabularies/core/uuid> \"$A_ORG\" ; <http://www.w3.org/ns/org#hasSite> <http://data.lblod.info/id/vestigingen/$1> }"; }
check "A has both test vestigingen" "True True" "$(linked "$SITE_ID") $(linked "$SITE2_ID")"

# a delete from a page that loaded another e-mail address than the contact point has now
STALE_DELETE="{\"data\":{\"type\":\"change-requests\",\"attributes\":{\"aggregate\":\"site\",\"operations\":[
 {\"op\":\"update\",\"data\":{\"type\":\"sites\",\"id\":\"$SITE_ID\",\"relationships\":{\"contacts\":{\"data\":[]}},\"meta\":{\"base\":{\"relationships\":{\"contacts\":{\"data\":[{\"type\":\"contact-points\",\"id\":\"$CP_ID\"}]}}}}}},
 {\"op\":\"delete\",\"data\":{\"type\":\"contact-points\",\"id\":\"$CP_ID\",\"meta\":{\"base\":{\"attributes\":{\"email\":\"oud@example.org\",\"type\":\"Primary\"}}}}}
 ]},\"relationships\":{\"target\":{\"data\":{\"type\":\"organizations\",\"id\":\"$A_ORG\"}}}}}"
check "A deletes the contact point from a page that showed another e-mail address" 201 "$(post "$JA" /change-requests "$STALE_DELETE")"
PD=$(py "d['data']['id']"); PENDING+=("$PD")
check "the delete waits: the address changed since the page loaded it" "ingediend contact-points email: base oud@example.org, current loket@example.org, proposed None, competing -" "$(py "a['status'] + ' ' + conflicts(a['conflicts'])")"
check "the tombstone's base state keeps the links to its master, as statements" True "$(ask "GRAPH <http://mu.semte.ch/graphs/change-requests> { ?r <${MU}uuid> \"$PD\" . ?s a <${CR}Action> ; <${DCT}isPartOf> ?r ; <${PROV}generated> ?v . ?v <${CR}operation> <https://www.w3.org/ns/activitystreams#Delete> ; <${CR}base> ?b . ?b <${CR}incomingLink> ?l . ?l a <${RDF}Statement> ; <${RDF}subject> <http://data.lblod.info/id/vestigingen/$SITE_ID> ; <${RDF}predicate> <http://www.w3.org/ns/org#siteAddress> }")"
check "A withdraws it; the contact point stays" "201 True" "$(take_step "$JA" "$PD" intrekking) $(ask "?s <http://mu.semte.ch/vocabularies/core/uuid> \"$CP_ID\"")"

# the records live in the right graphs
check "requests, steps, versions, states and links are in the change-requests graph" True "$(ask "GRAPH <http://mu.semte.ch/graphs/change-requests> { ?r a <${CR}ChangeRequest> . ?s a <${CR}Action> ; <${DCT}isPartOf> ?r . ?v a <${CR}ProposedVersion> . ?b a <${CR}RecordState> . ?l a <${RDF}Statement> }")"
check "no request, step, version, state or link leaks into the public graph" False "$(ask "GRAPH <http://mu.semte.ch/graphs/public> { ?r a ?t . VALUES ?t { <${CR}ChangeRequest> <${CR}ProposedVersion> <${CR}Action> <${CR}RecordState> <${RDF}Statement> <http://open-services.net/ns/core#Error> } }")"
check "a request names its organisation (pav:createdBy) and the person who submitted it (dct:creator)" True "$(ask "GRAPH <http://mu.semte.ch/graphs/change-requests> { ?r <${MU}uuid> \"$P1\" ; <http://purl.org/pav/createdBy> ?org ; <${DCT}creator> ?person } GRAPH <http://mu.semte.ch/graphs/public> { ?org <${MU}uuid> \"$A_ORG\" . ?person a <http://xmlns.com/foaf/0.1/Person> ; <${MU}uuid> \"$A_PERSON\" }")"
check "the versions of a request hang off its indiening step" True "$(ask "GRAPH <http://mu.semte.ch/graphs/change-requests> { ?r <${MU}uuid> \"$P1\" . ?s a <${CR}Action> ; <${DCT}isPartOf> ?r ; <http://schema.org/position> 1 ; <${PROV}generated> ?v . ?v <${CR}base> ?b . FILTER NOT EXISTS { ?v <${PROV}wasGeneratedBy> ?s } }")"
check "A carries dct:modified and ext:lastModifiedBy, a person" True "$(ask "GRAPH <http://mu.semte.ch/graphs/public> { ?o <${MU}uuid> \"$A_ORG\" ; <${DCT}modified> ?m ; <http://mu.semte.ch/vocabularies/ext/lastModifiedBy> ?by . ?by a <http://xmlns.com/foaf/0.1/Person> }")"

# --- put things back ----------------------------------------------------------------------------
for id in "${PENDING[@]}"; do
  if [ "$(fetch "$JABB" "/change-requests/$id")" = 200 ] && [ "$(py "a['status']")" = ingediend ]; then
    take_step "$JABB" "$id" afkeuring "closed by the end-to-end script" >/dev/null
    nok "request $id was still pending at the end; ABB closed it"
  fi
done
check "ABB renames A back" 201 "$(rename "$JABB" "$A_ORG" "$A_NAME")"
check "the original name is back" "$A_NAME" "$(name_of "$JA" "$A_ORG")"
check "ABB puts the legal name back" 201 "$(post "$JABB" /change-requests "$(cr_body "$A_ORG" "[{\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"attributes\":{\"legal-name\":$A_LEGAL}}}]")")"
fetch "$JA" "/administrative-units/$A_ORG" >/dev/null
check "the original legal name is back" "$A_LEGAL" "$(py "json.dumps(a.get('legal-name'))")"
UNSITE="{\"data\":{\"type\":\"change-requests\",\"attributes\":{\"aggregate\":\"site\",\"operations\":[
 {\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"relationships\":{\"sites\":{\"data\":[]}},\"meta\":{\"base\":{\"relationships\":{\"sites\":{\"data\":[{\"type\":\"sites\",\"id\":\"$SITE_ID\"},{\"type\":\"sites\",\"id\":\"$SITE2_ID\"}]}}}}}},
 {\"op\":\"delete\",\"data\":{\"type\":\"sites\",\"id\":\"$SITE_ID\"}},
 {\"op\":\"delete\",\"data\":{\"type\":\"addresses\",\"id\":\"$ADDR_ID\"}},
 {\"op\":\"delete\",\"data\":{\"type\":\"contact-points\",\"id\":\"$CP_ID\"}},
 {\"op\":\"delete\",\"data\":{\"type\":\"sites\",\"id\":\"$SITE2_ID\"}}
 ]},\"relationships\":{\"target\":{\"data\":{\"type\":\"organizations\",\"id\":\"$A_ORG\"}}}}}"
check "A removes the test vestigingen again" 201 "$(post "$JA" /change-requests "$UNSITE")"
check "the test vestigingen are gone" "False False" "$(ask "?s <http://mu.semte.ch/vocabularies/core/uuid> \"$SITE_ID\"") $(ask "?s <http://mu.semte.ch/vocabularies/core/uuid> \"$SITE2_ID\"")"
check "the history keeps its links to them: the deletes leave the versions alone" True "$(ask "GRAPH <http://mu.semte.ch/graphs/change-requests> { ?v a <${CR}ProposedVersion> ; <${CR}masterUuid> \"$A_ORG\" ; <http://www.w3.org/ns/org#hasSite> <http://data.lblod.info/id/vestigingen/$SITE2_ID> }")"
check "and the states the removal replaced hold the vestigingen A had" True "$(ask "GRAPH <http://mu.semte.ch/graphs/change-requests> { ?state a <${CR}RecordState> ; <${DCT}isVersionOf> ?o ; <http://www.w3.org/ns/org#hasSite> <http://data.lblod.info/id/vestigingen/$SITE2_ID> . ?s <${PROV}invalidated> ?state } GRAPH <http://mu.semte.ch/graphs/public> { ?o <${MU}uuid> \"$A_ORG\" }")"
check "no request of this run is left pending" 0 "$(fetch "$JABB" "/change-requests?filter[target]=$A_ORG&filter[status]=ingediend" >/dev/null; py "d['meta']['count']")"

echo; echo "$pass passed, $fail failed"
rm -rf "$TMP"
[ "$fail" -eq 0 ]
