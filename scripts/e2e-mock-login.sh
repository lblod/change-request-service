#!/usr/bin/env bash
# End-to-end check of change-request-service in app-lokale-verkenner, as a browser would do it: through
# mu-identifier, logged in with mock-login as two gemeenten and as ABB. It walks the validation flow
# of the designs: an edit of own data is applied at once and a stale one refused; a request to
# register a new organisation and a veranderingsgebeurtenis wait for ABB (question, answer,
# rejection, contest, approval); everyone sees the requests, only the involved see who and why;
# edits are the history of the data and are listed only when asked for. It checks these rules too:
# KBO numbers (normalised, required, claimed again on approval), what the kerngegevens and a
# vestiging may change, ABB's own stale change event, the limits of the API.
# Every change it makes is put back at the end, also when it is interrupted: the organisations it
# registered and the change events it applied are removed from the organisation graph (directly in
# Virtuoso: an organisation is never deleted through a request), the audit stamps of A get their old
# values, the requests stay as history, and the ones it leaves pending are closed. The change-event
# types the dev data may lack are inserted for the run and removed again. It writes to Virtuoso
# directly, so it runs against a SPARQL endpoint on this machine only (E2E_ALLOW_REMOTE=1 overrides).
# Run it while nobody else writes to the stack: it renames A for a while.
#
#   BASE_URL         the identifier (default http://localhost:88, app-lokale-verkenner docker-compose.dev.yml)
#   SPARQL_ENDPOINT  Virtuoso, to look up accounts, check graphs and clean up (default http://localhost:8899/sparql)
#   ORG_A_LABEL, ORG_B_LABEL  two gemeenten by name (default Aalst and Gent)
#   ORGS_GRAPH       the graph of the organisation data (default http://mu.semte.ch/graphs/administrative-unit)
set -u
BASE=${BASE_URL:-http://localhost:88}
SPARQL=${SPARQL_ENDPOINT:-http://localhost:8899/sparql}
ORG_A_LABEL=${ORG_A_LABEL:-Aalst}
ORG_B_LABEL=${ORG_B_LABEL:-Gent}
case "$SPARQL" in
  http://localhost:*|http://127.0.0.1:*|http://\[::1\]:*) ;;
  *) if [ "${E2E_ALLOW_REMOTE:-}" != 1 ]; then echo "SPARQL_ENDPOINT $SPARQL is not on this machine; the script writes to it directly. Set E2E_ALLOW_REMOTE=1 to run it there anyway." >&2; exit 2; fi ;;
esac
J='Accept: application/vnd.api+json'
CT='Content-Type: application/vnd.api+json'
TMP=$(mktemp -d)
pass=0; fail=0
ok()  { echo "PASS  $*"; pass=$((pass+1)); }
nok() { echo "FAIL  $*"; fail=$((fail+1)); }
check() { local name="$1" expected="$2" actual="$3"; if [ "$actual" = "$expected" ]; then ok "$name ($actual)"; else nok "$name: expected $expected, got $actual"; fi; }

sparql() { curl -s -H 'Accept: application/sparql-results+json' --data-urlencode "query=$1" "$SPARQL"; }
sparql_update() { curl -s -o /dev/null -w '%{http_code}' --data-urlencode "query=$1" "$SPARQL"; }
ask() { sparql "ASK { $1 }" | python3 -c "import json,sys; print(json.load(sys.stdin)['boolean'])"; }

# The code lists and the mock-login accounts; the organisation data has a graph of its own, which
# only logged-in sessions read (as in OP).
PUBLIC=http://mu.semte.ch/graphs/public
ORGS=${ORGS_GRAPH:-http://mu.semte.ch/graphs/administrative-unit}
CRG=http://mu.semte.ch/graphs/change-requests
CR=http://lblod.data.gift/vocabularies/change-requests/
RDF=http://www.w3.org/1999/02/22-rdf-syntax-ns#
DCT=http://purl.org/dc/terms/
PROV=http://www.w3.org/ns/prov#
MU=http://mu.semte.ch/vocabularies/core/
SKOS=http://www.w3.org/2004/02/skos/core#
ORG=http://www.w3.org/ns/org#
CODE=http://lblod.data.gift/vocabularies/organisatie/
CH=http://data.lblod.info/vocabularies/contacthub/
GEMEENTE=http://data.vlaanderen.be/id/concept/BestuurseenheidClassificatieCode/5ab0e9b8a3b2ca7c5e000001
ABBCODE=http://data.vlaanderen.be/id/concept/BestuurseenheidClassificatieCode/52cc9d8d-1c9a-4d92-9936-da9d4a622ec4
# What a gemeente may request ("Wie beheert"): an autonoom gemeentebedrijf; a welzijnsvereniging is the OCMW's
AGB=36a82ba0-7ff1-4697-a9dd-2e94df73b721
AGB_URI=http://data.vlaanderen.be/id/concept/BestuurseenheidClassificatieCode/$AGB
WELZIJNSVERENIGING=e8294b73-87c9-4fa2-9441-1937350763c9
# an interlokale vereniging is registered without a KBO number
ILV=3a2649ef-7345-4d3a-8709-f89fc9b44f58
# Change-event types of OP's code list; the dev data gets them with the OP dump
OPRICHTING=f0e2706a-3b64-4464-ad9c-4e65dc976288
NAAMSWIJZIGING=6651dc69b0ae8f7ff9974e8a23db1dec

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
SELECT ?orgUuid ?accUuid ?personUuid WHERE {
  GRAPH <$ORGS> { ?org a besluit:Bestuurseenheid ; mu:uuid ?orgUuid ; skos:prefLabel \"$1\" ; org:classification <$2> . }
  GRAPH <$PUBLIC> { ?p foaf:member ?org ; foaf:account ?acc ; mu:uuid ?personUuid . ?acc mu:uuid ?accUuid . } } LIMIT 1" |
  python3 -c "import json,sys; b=json.load(sys.stdin)['results']['bindings'][0]; print(b['orgUuid']['value'], b['accUuid']['value'], b['personUuid']['value'])"
}
read -r A_ORG A_ACC A_PERSON < <(lookup "$ORG_A_LABEL" "$GEMEENTE")
read -r B_ORG B_ACC B_PERSON < <(lookup "$ORG_B_LABEL" "$GEMEENTE")
read -r ABB_ORG ABB_ACC ABB_PERSON < <(lookup "Agentschap Binnenlands Bestuur" "$ABBCODE")
echo "A=$ORG_A_LABEL $A_ORG  B=$ORG_B_LABEL $B_ORG  ABB $ABB_ORG"
uri_of() { sparql "SELECT ?s WHERE { GRAPH <$ORGS> { ?s <${MU}uuid> \"$1\" } } LIMIT 1" | python3 -c "import json,sys; print(json.load(sys.stdin)['results']['bindings'][0]['s']['value'])"; }
A_URI=$(uri_of "$A_ORG"); B_URI=$(uri_of "$B_ORG")
# the audit stamps of a record (dct:modified, ext:lastModifiedBy) as triples, to put A's back at the end
stamps_of() {
  sparql "SELECT ?p ?o WHERE { GRAPH <$ORGS> { <$1> ?p ?o . VALUES ?p { <${DCT}modified> <http://mu.semte.ch/vocabularies/ext/lastModifiedBy> } } }" | python3 -c "
import json, sys
for b in json.load(sys.stdin)['results']['bindings']:
    o = b['o']
    term = '<%s>' % o['value'] if o['type'] == 'uri' else json.dumps(o['value']) + ('^^<%s>' % o['datatype'] if o.get('datatype') else '')
    print('<$1> <%s> %s .' % (b['p']['value'], term))"
}
A_STAMPS=$(stamps_of "$A_URI")

# A change-event type the dev data may lack: inserted for the run, removed at the end.
FIXTURES=()
ensure_concept() { # uuid label
  if [ "$(ask "GRAPH <$PUBLIC> { <http://lblod.data.gift/concepts/$1> <${MU}uuid> ?u }")" = False ]; then
    sparql_update "INSERT DATA { GRAPH <$PUBLIC> { <http://lblod.data.gift/concepts/$1> a <${SKOS}Concept>, <${CODE}Veranderingsgebeurtenis> ; <${MU}uuid> \"$1\" ; <${SKOS}prefLabel> \"$2\" } }" >/dev/null
    FIXTURES+=("$1")
  fi
}

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
def ids(d=d):
    return [r['id'] for r in d['data']]
value = eval(sys.argv[1])
print(json.dumps(value) if isinstance(value, (dict, list)) or value is None else value)
PY
}
cr_body() { # target operations-json [aggregate]: an edit of the kerngegevens (or of the given aggregate)
  printf '{"data":{"type":"change-requests","attributes":{"aggregate":"%s","operations":%s},"relationships":{"target":{"data":{"type":"organizations","id":"%s"}}}}}' "${3:-organization-core-data}" "$2" "$1"
}
rename() { # jar target name
  post "$1" /change-requests "$(cr_body "$2" "[{\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$2\",\"attributes\":{\"name\":\"$3\"}}}]")"
}
stale_rename() { # jar target name base-name: a form that loaded base-name proposes name
  post "$1" /change-requests "$(cr_body "$2" "[{\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$2\",\"attributes\":{\"name\":\"$3\"},\"meta\":{\"base\":{\"attributes\":{\"name\":\"$4\"}}}}}]")"
}
# creation_body name kbo classification-uuid reason: a gemeente registers a new organisation with its
# KBO number, its site and the oprichting with the link to the besluit
creation_body() {
  cat <<JSON
{"data":{"type":"change-requests","attributes":{"aggregate":"new-organisation","reason":"$4","operations":[
 {"op":"create","data":{"type":"administrative-units","lid":"o1","attributes":{"name":"$1","legal-name":"$1 (juridische naam)"},"relationships":{"classification":{"data":{"type":"administrative-unit-classification-codes","id":"$3"}},"identifiers":{"data":[{"type":"identifiers","lid":"i1"}]},"primary-site":{"data":{"type":"sites","lid":"v1"}}}}},
 {"op":"create","data":{"type":"identifiers","lid":"i1","attributes":{"id-name":"KBO nummer"},"relationships":{"structured-identifier":{"data":{"type":"structured-identifiers","lid":"s1"}}}}},
 {"op":"create","data":{"type":"structured-identifiers","lid":"s1","attributes":{"local-id":"$2"}}},
 {"op":"create","data":{"type":"sites","lid":"v1","relationships":{"address":{"data":{"type":"addresses","lid":"a1"}}}}},
 {"op":"create","data":{"type":"addresses","lid":"a1","attributes":{"street":"Grote Markt","number":"1","postcode":"9300","municipality":"$ORG_A_LABEL","country":"België","full-address":"Grote Markt 1, 9300 $ORG_A_LABEL, België"}}},
 {"op":"create","data":{"type":"change-events","lid":"e1","attributes":{"date":"2026-10-01","description":"Oprichting (test Lokale Verkenner)"},"relationships":{"type":{"data":{"type":"change-event-types","id":"$OPRICHTING"}},"original-organizations":{"data":[{"type":"administrative-units","lid":"o1"}]},"resulting-organizations":{"data":[{"type":"administrative-units","lid":"o1"}]},"results":{"data":[{"type":"change-event-results","lid":"r1"}]},"decision":{"data":{"type":"decisions","lid":"d1"}}}}},
 {"op":"create","data":{"type":"change-event-results","lid":"r1","relationships":{"result-from":{"data":{"type":"change-events","lid":"e1"}},"resulting-organization":{"data":{"type":"administrative-units","lid":"o1"}}}}},
 {"op":"create","data":{"type":"decisions","lid":"d1","attributes":{"document-links":["https://$ORG_A_LABEL.example.org/besluiten/2026/123"]}}}
]}}}
JSON
}
# without_kbo: a creation body (stdin) without its KBO identifier, as the form sends an ILV without one
without_kbo() {
  python3 -c "
import json, sys
d = json.load(sys.stdin)
ops = d['data']['attributes']['operations']
d['data']['attributes']['operations'] = [o for o in ops if o['data']['type'] not in ('identifiers', 'structured-identifiers')]
d['data']['attributes']['operations'][0]['data']['relationships']['identifiers'] = {'data': []}
print(json.dumps(d))"
}
# change_event_body target new-name base-name: a naamswijziging about the target, with the besluit and the new name on the organisation
change_event_body() {
  cat <<JSON
{"data":{"type":"change-requests","attributes":{"aggregate":"change-event","operations":[
 {"op":"create","data":{"type":"change-events","lid":"e1","attributes":{"date":"2026-10-02","description":"Naamswijziging (test Lokale Verkenner)"},"relationships":{"type":{"data":{"type":"change-event-types","id":"$NAAMSWIJZIGING"}},"original-organizations":{"data":[{"type":"administrative-units","id":"$1"}]},"decision":{"data":{"type":"decisions","lid":"d1"}}}}},
 {"op":"create","data":{"type":"decisions","lid":"d1","attributes":{"document-links":["https://$ORG_A_LABEL.example.org/besluiten/2026/124"]}}},
 {"op":"update","data":{"type":"administrative-units","id":"$1","attributes":{"name":"$2"},"meta":{"base":{"attributes":{"name":"$3"}}}}}
]},"relationships":{"target":{"data":{"type":"organizations","id":"$1"}}}}}
JSON
}
take_step() { # jar request-id step-type [reason] [override]
  local attributes="\"step-type\":\"$3\""
  if [ -n "${4:-}" ]; then attributes="$attributes,\"reason\":\"$4\""; fi
  if [ -n "${5:-}" ]; then attributes="$attributes,\"override\":$5"; fi
  post "$1" "/change-requests/$2/steps" "{\"data\":{\"type\":\"change-request-steps\",\"attributes\":{$attributes}}}"
}
PENDING=()   # requests this run leaves waiting for a while; closed at the end if still pending
CREATED=()   # uuids of records this run wrote to the organisation graph outside the kerngegevens of A; removed at the end
remember_lids() { # the uuids the last answer minted
  while read -r id; do CREATED+=("$id"); done < <(py "'\n'.join(a['lids'].values())" | tr -d '"')
}
remove_record() { # uuid: a record and the links to it, out of the organisation graph (test data of this run)
  sparql_update "DELETE { GRAPH <$ORGS> { ?x ?q ?s } } WHERE { GRAPH <$ORGS> { ?s <${MU}uuid> \"$1\" . ?x ?q ?s } }" >/dev/null
  sparql_update "DELETE { GRAPH <$ORGS> { ?s ?p ?o } } WHERE { GRAPH <$ORGS> { ?s <${MU}uuid> \"$1\" ; ?p ?o } }" >/dev/null
}
# --- put things back ----------------------------------------------------------------------------
# Also when the run is interrupted or a command fails: restore runs once, from the EXIT trap at the
# latest, and puts back what the run got as far as changing.
RESTORED=0
restore() {
  [ "$RESTORED" = 1 ] && return
  RESTORED=1
  echo "--- putting things back"
  # what the run did through the API needs the sessions: only when it got as far as logging in
  if [ -n "${JABB:-}" ] && [ -s "${JABB:-}" ]; then
  for id in "${PENDING[@]}"; do
    if [ "$(fetch "$JABB" "/change-requests/$id")" = 200 ]; then
      case "$(py "a['status']")" in
        ingediend|informatie-gevraagd) take_step "$JABB" "$id" afkeuring "closed by the end-to-end script" >/dev/null; nok "request $id was still pending at the end; ABB closed it" ;;
      esac
    fi
  done
  if [ -n "${A_NAME:-}" ]; then
    rename "$JABB" "$A_ORG" "$A_NAME" >/dev/null
    check "the original name is back" "$A_NAME" "$(name_of "$JA" "$A_ORG")"
  fi
  if [ -n "${A_LEGAL:-}" ]; then
    post "$JABB" /change-requests "$(cr_body "$A_ORG" "[{\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"attributes\":{\"legal-name\":$A_LEGAL}}}]")" >/dev/null
    fetch "$JA" "/administrative-units/$A_ORG" >/dev/null
    check "the original legal name is back" "$A_LEGAL" "$(py "json.dumps(a.get('legal-name'))")"
  fi
  if [ -n "${SITE_ID:-}" ] && [ -n "${SITE2_ID:-}" ]; then
    UNSITE="{\"data\":{\"type\":\"change-requests\",\"attributes\":{\"aggregate\":\"site\",\"operations\":[
 {\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"relationships\":{\"sites\":{\"data\":[]}},\"meta\":{\"base\":{\"relationships\":{\"sites\":{\"data\":[{\"type\":\"sites\",\"id\":\"$SITE_ID\"},{\"type\":\"sites\",\"id\":\"$SITE2_ID\"}]}}}}}},
 {\"op\":\"delete\",\"data\":{\"type\":\"sites\",\"id\":\"$SITE_ID\"}},
 {\"op\":\"delete\",\"data\":{\"type\":\"addresses\",\"id\":\"$ADDR_ID\"}},
 {\"op\":\"delete\",\"data\":{\"type\":\"contact-points\",\"id\":\"$CP_ID\"}},
 {\"op\":\"delete\",\"data\":{\"type\":\"sites\",\"id\":\"$SITE2_ID\"}}
 ]},\"relationships\":{\"target\":{\"data\":{\"type\":\"organizations\",\"id\":\"$A_ORG\"}}}}}"
    check "A removes the test vestigingen again" 201 "$(post "$JA" /change-requests "$UNSITE")"
    check "the test vestigingen are gone" "False False" "$(ask "?s <${MU}uuid> \"$SITE_ID\"") $(ask "?s <${MU}uuid> \"$SITE2_ID\"")"
    check "the history keeps its links to them: the deletes leave the versions alone" True "$(ask "GRAPH <$CRG> { ?v a <${CR}ProposedVersion> ; <${CR}masterUuid> \"$A_ORG\" ; <${ORG}hasSite> <http://data.lblod.info/id/vestigingen/$SITE2_ID> }")"
    check "and the states the removal replaced hold the vestigingen A had" True "$(ask "GRAPH <$CRG> { ?state a <${CR}RecordState> ; <${DCT}isVersionOf> ?o ; <${ORG}hasSite> <http://data.lblod.info/id/vestigingen/$SITE2_ID> . ?s <${PROV}invalidated> ?state } GRAPH <$ORGS> { ?o <${MU}uuid> \"$A_ORG\" }")"
  fi
  fi
  # The organisations this run registered and the change events it applied: out of the organisation graph
  # (mu-cl-resources may cache them for a while; the dev stack holds test data only).
  for id in "${CREATED[@]}"; do remove_record "$id"; done
  if [ -n "${NEW_ORG:-}" ] && [ -n "${ABB_NEW_ORG:-}" ] && [ -n "${JABB:-}" ]; then
    check "the registered organisations and the change events are removed from the organisation graph" "False False False" "$(ask "?s <${MU}uuid> \"$NEW_ORG\"") $(ask "?s <${MU}uuid> \"$ABB_NEW_ORG\"") $(ask "GRAPH <$ORGS> { ?o <${MU}uuid> \"$A_ORG\" . ?e <${ORG}originalOrganization> ?o ; <${DCT}description> \"Naamswijziging (test Lokale Verkenner)\" }")"
  fi
  for id in "${FIXTURES[@]}"; do sparql_update "DELETE WHERE { GRAPH <$PUBLIC> { <http://lblod.data.gift/concepts/$id> ?p ?o } }" >/dev/null; done
  # A's audit stamps as they were before the run: the applies of the run set them
  if [ -n "${A_URI:-}" ]; then
    sparql_update "DELETE WHERE { GRAPH <$ORGS> { <$A_URI> <${DCT}modified> ?modified } }" >/dev/null
    sparql_update "DELETE WHERE { GRAPH <$ORGS> { <$A_URI> <http://mu.semte.ch/vocabularies/ext/lastModifiedBy> ?by } }" >/dev/null
    [ -n "$A_STAMPS" ] && sparql_update "INSERT DATA { GRAPH <$ORGS> { $A_STAMPS } }" >/dev/null
    check "A's audit stamps are what they were before the run" "$(echo "$A_STAMPS" | sort)" "$(stamps_of "$A_URI" | sort)"
  fi
  if [ -n "${JABB:-}" ] && [ -n "${RUN_START:-}" ]; then
    check "no request of this run is left pending" 0 "$(fetch "$JABB" "/change-requests?filter[requester]=$A_ORG&filter[status]=ingediend,informatie-gevraagd&filter[created][gte]=$RUN_START" >/dev/null; py "d['meta']['count']")"
  fi
}
trap 'restore; rm -rf "$TMP"' EXIT
trap 'echo "interrupted"; exit 130' INT TERM

# the change-event types the run needs, inserted where the dev data lacks them (removed by restore)
ensure_concept "$OPRICHTING" "Oprichting"
ensure_concept "$NAAMSWIJZIGING" "Naamswijziging"

RUN_START=$(date -u -d '-5 seconds' +%Y-%m-%dT%H:%M:%SZ)
STAMP=$(date +%s)
KBO1="0${STAMP: -9}"; KBO2="1${STAMP: -9}"; KBO3="2${STAMP: -9}"; KBO4="3${STAMP: -9}"; KBO5="4${STAMP: -9}"   # ten digits, unique per run

JA=$TMP/a; JB=$TMP/b; JABB=$TMP/abb; JANON=$TMP/anon
check "mock-login as A" 201 "$(login "$JA" "$A_ACC" "$A_ORG")"
check "mock-login as B" 201 "$(login "$JB" "$B_ACC" "$B_ORG")"
check "mock-login as ABB" 201 "$(login "$JABB" "$ABB_ACC" "$ABB_ORG")"

A_NAME=$(name_of "$JA" "$A_ORG")
B_NAME=$(name_of "$JB" "$B_ORG")
[ -n "$A_NAME" ] && ok "A reads its organisation ($A_NAME)" || nok "A cannot read its organisation"
# A visitor without a session reads the type and the uuid of an organisation of a mock account (the
# mock-login page lists the accounts with them), none of its data
fetch "$JANON" "/administrative-units/$A_ORG" >/dev/null
check "without a session an organisation has no name: its data is for logged-in sessions" null "$(py "a.get('name')")"
fetch "$JANON" "/sites?page[size]=1" >/dev/null
check "without a session no vestiging is listed" 0 "$(py "d['meta']['count']")"
fetch "$JANON" "/accounts?filter[user]=$ORG_A_LABEL&include=user.organizations&page[size]=20" >/dev/null
check "the mock-login page lists A's account with its organisation" True "$(py "'$A_ORG' in [r['id'] for r in d.get('included', [])]")"
check "the organisation data is in the organisation graph, not in the public one" "True False" "$(ask "GRAPH <$ORGS> { <$A_URI> <http://www.w3.org/2004/02/skos/core#prefLabel> ?n }") $(ask "GRAPH <$PUBLIC> { <$A_URI> <http://www.w3.org/2004/02/skos/core#prefLabel> ?n }")"
fetch "$JA" "/administrative-units/$A_ORG" >/dev/null
A_LEGAL=$(py "json.dumps(a.get('legal-name'))")

# --- permissions ------------------------------------------------------------------------------------
perm() { fetch "$1" "/change-requests/permissions?target=$2" >/dev/null; py "f\"{d.get('can-edit')} {d.get('can-submit-change-event')} {d.get('can-decide')} {','.join(d.get('rules', []))}\""; }
check "permissions: A on A edits itself and registers events about itself, does not decide" "True True False own-organisation" "$(perm "$JA" "$A_ORG")"
check "permissions: B on A: nothing" "False False False " "$(perm "$JB" "$A_ORG")"
check "permissions: ABB on B: edits everything and decides" "True True True abb-edits-all" "$(perm "$JABB" "$B_ORG")"
check "permissions without a target: a gemeente may request an AGB (Wie beheert), not a welzijnsvereniging" "True False False" "$(fetch "$JA" "/change-requests/permissions" >/dev/null; py "f\"{'$AGB_URI' in d['can-create']} {any(u.endswith('$WELZIJNSVERENIGING') for u in d['can-create'])} {d['can-decide']}\"")"
check "permissions without a target: ABB may request every configured classification and decides" "True True" "$(fetch "$JABB" "/change-requests/permissions" >/dev/null; py "f\"{len(d['can-create']) > 10} {d['can-decide']}\"")"
check "permissions without login" 401 "$(code "$JANON" "/change-requests/permissions?target=$A_ORG")"

# --- an edit is applied at once ----------------------------------------------------------------------
NAME0="$A_NAME (test Lokale Verkenner)"
check "A renames itself through a change request" 201 "$(rename "$JA" "$A_ORG" "$NAME0")"
check "the request is applied at once: afgehandeld, kind edit, mine" "afgehandeld edit True" "$(py "f\"{a['status']} {a['kind']} {a['mine']}\"")"
AUTO_ID=$(py "d['data']['id']")
EXPECTED_STEPS="1 indiening ingediend user $A_PERSON $A_ORG own-organisation | 2 goedkeuring goedgekeurd service None None edits-apply-at-once | 3 afhandeling afgehandeld service None None None"
check "its steps: indiening by A's person and organisation, goedkeuring by the service (rule edits-apply-at-once), afhandeling by the service" "$EXPECTED_STEPS" "$(py "steps()")"
check "its status is the status of its last step" True "$(py "a['status'] == a['steps'][-1]['status']")"
check "the new name is visible through mu-cl-resources" "$NAME0" "$(name_of "$JA" "$A_ORG")"
check "the stored request reads back" 200 "$(fetch "$JA" "/change-requests/$AUTO_ID")"
check "the stored steps read back the same" "$EXPECTED_STEPS" "$(py "steps()")"
check "applied-at is the start of the afhandeling step; the target is named and classified" "True $NAME0 5ab0e9b8a3b2ca7c5e000001" "$(py "f\"{a['applied-at'] == a['steps'][2]['at'] and a['error'] is None and a['conflicts'] == []} {a['target-name']} {a['target-classification']}\"")"
check "the detail returns the operations as submitted" "update administrative-units $A_ORG $NAME0" "$(py "f\"{a['operations'][0]['op']} {a['operations'][0]['data']['type']} {a['operations'][0]['data']['id']} {a['operations'][0]['data']['attributes']['name']}\"")"

check "B cannot rename A" 403 "$(rename "$JB" "$A_ORG" "Gent was here")"
check "A keeps its name" "$NAME0" "$(name_of "$JA" "$A_ORG")"

patch=$(curl -s -o /dev/null -w '%{http_code}' -c "$JA" -b "$JA" -X PATCH -H "$J" -H "$CT" --data "{\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"attributes\":{\"name\":\"direct write\"}}}" "$BASE/administrative-units/$A_ORG")
if [ "$patch" != 200 ] && [ "$patch" != 204 ]; then ok "a direct PATCH on the resource route is refused ($patch)"; else nok "a direct PATCH succeeded ($patch)"; fi
forged=$(curl -s -o /dev/null -w '%{http_code}' -c "$JA" -b "$JA" -X PATCH -H "$J" -H "$CT" -H 'mu-auth-scope: http://services.lblod.info/change-request-service' -H 'mu-auth-sudo: true' --data "{\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"attributes\":{\"name\":\"forged scope\"}}}" "$BASE/administrative-units/$A_ORG")
if [ "$forged" != 200 ] && [ "$forged" != 204 ]; then ok "a PATCH with forged mu-auth-scope and mu-auth-sudo headers is refused ($forged)"; else nok "a forged-scope PATCH succeeded ($forged)"; fi
forged_groups=$(curl -s -o /dev/null -w '%{http_code}' -c "$JA" -b "$JA" -X PATCH -H "$J" -H "$CT" -H 'mu-auth-allowed-groups: sudo' --data "{\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"attributes\":{\"name\":\"forged groups\"}}}" "$BASE/administrative-units/$A_ORG")
if [ "$forged_groups" != 200 ] && [ "$forged_groups" != 204 ]; then ok "a PATCH with a forged mu-auth-allowed-groups: sudo header is refused ($forged_groups)"; else nok "a forged-groups PATCH succeeded ($forged_groups)"; fi
check "A still carries the change-request name" "$NAME0" "$(name_of "$JA" "$A_ORG")"

# --- everyone sees the requests; who and why only the involved --------------------------------------------
list_count() { fetch "$1" "/change-requests?$2" >/dev/null; py "d['meta']['count']"; }
EDITS="filter[target]=$A_ORG&filter[kind]=edit"
na=$(list_count "$JA" "$EDITS"); nb=$(list_count "$JB" "$EDITS"); nabb=$(list_count "$JABB" "$EDITS")
[ "$na" -ge 1 ] && ok "A lists its edits when it asks for them ($na)" || nok "A lists $na edits"
check "without filter[kind] the list leaves the edits out: they are the history of the data" 0 "$(list_count "$JA" "filter[target]=$A_ORG&filter[created][gte]=$RUN_START")"
check "B lists A's edits too: everyone sees every request" "$na" "$nb"
check "and so does ABB" "$na" "$nabb"
check "A sees who submitted its request: mine, with the person on the step" "True $A_PERSON" "$(fetch "$JA" "/change-requests/$AUTO_ID" >/dev/null; py "f\"{a['mine']} {a['steps'][0]['person']}\"")"
check "B sees the request but not the person: not mine, person hidden, the organisation shown" "False None $A_ORG" "$(fetch "$JB" "/change-requests/$AUTO_ID" >/dev/null; py "f\"{a['mine']} {a['steps'][0]['person']} {a['steps'][0]['organisation']}\"")"
check "ABB sees the person" "$A_PERSON" "$(fetch "$JABB" "/change-requests/$AUTO_ID" >/dev/null; py "a['steps'][0]['person']")"
check "filter[mine]: the edits A's person submitted about A (ABB's renames are not mine), none for B" "$(list_count "$JA" "$EDITS&filter[requester]=$A_ORG") 0" "$(list_count "$JA" "$EDITS&filter[mine]=true") $(list_count "$JB" "$EDITS&filter[mine]=true")"
nc=$(list_count "$JA" "filter[target]=$A_ORG&filter[kind]=change-event")
check "filter[kind]=edit,change-event lists both kinds about A, filter[kind]=creation none of them" "$((na + nc)) 0" "$(list_count "$JA" "filter[target]=$A_ORG&filter[kind]=edit,change-event") $(list_count "$JA" "filter[target]=$A_ORG&filter[kind]=creation")"
check "the list is oldest first; sort=-created newest first" "True True" "$(fetch "$JA" "/change-requests?$EDITS" >/dev/null; py "d['data'][0]['attributes']['created'] <= d['data'][-1]['attributes']['created']") $(fetch "$JA" "/change-requests?$EDITS&sort=-created" >/dev/null; py "d['data'][0]['attributes']['created'] >= d['data'][-1]['attributes']['created']")"
check "every listed request has steps and conflicts, and no operations (the detail has them)" True "$(fetch "$JA" "/change-requests?$EDITS" >/dev/null; py "all(isinstance(r['attributes']['steps'], list) and isinstance(r['attributes']['conflicts'], list) and 'operations' not in r['attributes'] for r in d['data'])")"
check "the list is paged: page[size]=1 gives one request, meta.count counts them all, next links the rest" "1 True True" "$(fetch "$JA" "/change-requests?$EDITS&page[size]=1" >/dev/null; py "f\"{len(d['data'])} {d['meta']['count'] >= $na} {('next' in d['links']) == (d['meta']['count'] > 1)}\"")"
check "a page size above the maximum: 400" 400 "$(code "$JA" "/change-requests?page[size]=1000")"
check "a page past the triplestore's row limit: 400" 400 "$(code "$JA" "/change-requests?page[number]=500")"
check "an unknown kind: 400; an unknown filter: 400" "400 400" "$(code "$JA" "/change-requests?filter[kind]=foo") $(code "$JA" "/change-requests?filter[colour]=red")"
check "an id with a control character: a quick 404" 404 "$(code "$JA" "/change-requests/a%00b")"

# --- a stale form is refused: ABB renamed A after A's page loaded it ------------------------------------
ABB_NAME="$A_NAME (ABB, test Lokale Verkenner)"
check "ABB renames A" 201 "$(rename "$JABB" "$A_ORG" "$ABB_NAME")"
check "ABB's rename is applied (rule abb-edits-all, then edits-apply-at-once)" "afgehandeld abb-edits-all edits-apply-at-once" "$(py "f\"{a['status']} {a['steps'][0]['rule']} {a['steps'][1]['rule']}\"")"
before=$(list_count "$JABB" "$EDITS")

STALE="$A_NAME (A, stale form)"
check "A submits a rename from a form that still shows the old name: 409, nothing saved" 409 "$(stale_rename "$JA" "$A_ORG" "$STALE" "$NAME0")"
check "the 409 lists the conflict" "administrative-units name: base $NAME0, current $ABB_NAME, proposed $STALE, competing -" "$(py "conflicts(d['errors'][0]['meta']['conflicts'])")"
check "the name is ABB's and no request was written" "$ABB_NAME $before" "$(name_of "$JA" "$A_ORG") $(list_count "$JABB" "$EDITS")"

LEGAL="$A_NAME (legal name, test Lokale Verkenner)"
SAME_FORM=$(cr_body "$A_ORG" "[{\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"attributes\":{\"name\":\"$NAME0\",\"legal-name\":\"$LEGAL\"},\"meta\":{\"base\":{\"attributes\":{\"name\":\"$NAME0\",\"legal-name\":$A_LEGAL}}}}}]")
check "the same stale form changes only the legal name (the old name carried unchanged)" 201 "$(post "$JA" /change-requests "$SAME_FORM")"
check "it is applied: no conflict on a key the user did not change" "afgehandeld []" "$(py "a['status'] + ' ' + json.dumps(a['conflicts'])")"
fetch "$JA" "/administrative-units/$A_ORG" >/dev/null
check "the legal name is changed and the name is NOT reverted" "$LEGAL / $ABB_NAME" "$(py "a['legal-name'] + ' / ' + a['name']")"
check "an edit that changes nothing is not stored: 200, data null, meta.unchanged" "200 null True" "$(rename "$JA" "$A_ORG" "$ABB_NAME") $(py "d['data']") $(py "d['meta']['unchanged']")"
check "through a vestiging the organisation's name is read-only: 422 at the key" "422 /data/attributes/operations/0/data/attributes/name" "$(post "$JA" /change-requests "$(cr_body "$A_ORG" "[{\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"attributes\":{\"name\":\"Gent was here\"}}}]" site)") $(py "d['errors'][0]['source']['pointer']")"
check "a body that is not JSON: 415" 415 "$(curl -s -o /dev/null -w '%{http_code}' -c "$JA" -b "$JA" -X POST -H "$J" -H 'Content-Type: text/plain' --data 'x' "$BASE/change-requests")"
check "malformed JSON: 400" 400 "$(curl -s -o /dev/null -w '%{http_code}' -c "$JA" -b "$JA" -X POST -H "$J" -H 'Content-Type: application/json' --data '{"data":' "$BASE/change-requests")"

# --- a new organisation: a gemeente requests an AGB, ABB validates ----------------------------------------
NEW_NAME="AGB $ORG_A_LABEL (test Lokale Verkenner $STAMP)"
REASON="Opgericht bij besluit van de gemeenteraad van 1 oktober 2026"
check "A requests a new AGB with its KBO number, site and oprichting" 201 "$(post "$JA" /change-requests "$(creation_body "$NEW_NAME" "$KBO1" "$AGB" "$REASON")")"
CREATE_ID=$(py "d['data']['id']"); PENDING+=("$CREATE_ID")
NEW_ORG=$(py "d['data']['relationships']['target']['data']['id']")
remember_lids
check "it waits: ingediend, kind creation, the target pending, named and classified from the proposal" "ingediend creation True $NEW_NAME $AGB" "$(py "f\"{a['status']} {a['kind']} {d['data']['relationships']['target'].get('meta', {}).get('pending')} {a['target-name']} {a['target-classification']}\"")"
check "the organisation got its uuid at submission (the lid o1), and the request carries the reason on its indiening" "True may-create-classification $REASON" "$(py "f\"{a['lids']['o1'] == '$NEW_ORG'} {a['steps'][0]['rule']} {a['steps'][0]['reason']}\"")"
check "the organisation does not exist yet" 404 "$(code "$JA" "/administrative-units/$NEW_ORG")"
check "a second request with the same KBO number: 409, it names the waiting request" "409 $CREATE_ID" "$(post "$JA" /change-requests "$(creation_body "$NEW_NAME (bis)" "$KBO1" "$AGB" "")") $(py "d['errors'][0]['meta']['change-request']['id']")"
check "a gemeente may not request a welzijnsvereniging: 403, no rule allowed it" "403 null" "$(post "$JA" /change-requests "$(creation_body "Welzijnsvereniging (test)" "$KBO3" "$WELZIJNSVERENIGING" "")") $(py "d['errors'][0]['meta']['rule']")"
check "a creation with a target: 422" 422 "$(post "$JA" /change-requests "$(creation_body "x" "$KBO3" "$AGB" "" | python3 -c "import json,sys; d=json.load(sys.stdin); d['data']['relationships']={'target':{'data':{'type':'organizations','id':'$A_ORG'}}}; print(json.dumps(d))")")"
check "B lists the waiting creation (everyone sees), without the person or the reason" "True False None None" "$(fetch "$JB" "/change-requests?filter[kind]=creation&filter[status]=ingediend&filter[requester]=$A_ORG" >/dev/null; py "f\"{'$CREATE_ID' in ids()} {[r for r in d['data'] if r['id']=='$CREATE_ID'][0]['attributes']['mine']} {[r for r in d['data'] if r['id']=='$CREATE_ID'][0]['attributes']['steps'][0]['person']} {[r for r in d['data'] if r['id']=='$CREATE_ID'][0]['attributes']['steps'][0]['reason']}\"")"
check "ABB sees the person and the reason" "$A_PERSON $REASON" "$(fetch "$JABB" "/change-requests/$CREATE_ID" >/dev/null; py "f\"{a['steps'][0]['person']} {a['steps'][0]['reason']}\"")"
check "filter[target-classification] finds the waiting creation through what it proposes" True "$(fetch "$JB" "/change-requests?filter[target-classification]=$AGB&filter[status]=ingediend&filter[created][gte]=$RUN_START" >/dev/null; py "'$CREATE_ID' in ids()")"
check "filter[created][gte] (this run) finds it, filter[created][lte] (before this run) does not" "True False" "$(fetch "$JB" "/change-requests?filter[created][gte]=$RUN_START&filter[kind]=creation" >/dev/null; py "'$CREATE_ID' in ids()") $(fetch "$JB" "/change-requests?filter[created][lte]=$RUN_START&filter[kind]=creation" >/dev/null; py "'$CREATE_ID' in ids()")"

check "B cannot ask for information on A's request: 403" 403 "$(take_step "$JB" "$CREATE_ID" informatievraag "Welk besluit?")"
check "A cannot approve its own request: 403" 403 "$(take_step "$JA" "$CREATE_ID" goedkeuring)"
check "ABB asks for information without a question: 422" 422 "$(take_step "$JABB" "$CREATE_ID" informatievraag)"
QUESTION="Kan u het besluit van de gemeenteraad bezorgen?"
check "ABB asks for information" 201 "$(take_step "$JABB" "$CREATE_ID" informatievraag "$QUESTION")"
check "the request is informatie-gevraagd; the step is ABB's with the question" "informatie-gevraagd | 2 informatievraag informatie-gevraagd user $ABB_PERSON $ABB_ORG abb-decides-all | $QUESTION" "$(py "a['status'] + ' | ' + steps().split(' | ')[1] + ' | ' + a['steps'][1]['reason']")"
check "ABB cannot approve while the question is open: 409" 409 "$(take_step "$JABB" "$CREATE_ID" goedkeuring)"
check "B cannot answer for A: 403" 403 "$(take_step "$JB" "$CREATE_ID" informatieantwoord "Hier is het")"
check "A answers without text: 422" 422 "$(take_step "$JA" "$CREATE_ID" informatieantwoord)"
ANSWER="Zie https://$ORG_A_LABEL.example.org/besluiten/2026/123"
check "A answers" 201 "$(take_step "$JA" "$CREATE_ID" informatieantwoord "$ANSWER")"
check "the request is back in validation: ingediend; the step is A's (rule requesting-organisation)" "ingediend | 3 informatieantwoord ingediend user $A_PERSON $A_ORG requesting-organisation" "$(py "a['status'] + ' | ' + steps().split(' | ')[2]")"
check "B reads the thread without its texts" "None None" "$(fetch "$JB" "/change-requests/$CREATE_ID" >/dev/null; py "f\"{a['steps'][1]['reason']} {a['steps'][2]['reason']}\"")"
check "A reads the thread with its texts" "$QUESTION / $ANSWER" "$(fetch "$JA" "/change-requests/$CREATE_ID" >/dev/null; py "a['steps'][1]['reason'] + ' / ' + a['steps'][2]['reason']")"
check "a rejection without a reason: 422" 422 "$(take_step "$JABB" "$CREATE_ID" afkeuring)"
REJECTION="Het KBO-nummer hoort niet bij een AGB"
check "ABB rejects with a reason" 201 "$(take_step "$JABB" "$CREATE_ID" afkeuring "$REJECTION")"
check "it is afgekeurd" "afgekeurd | 4 afkeuring afgekeurd user $ABB_PERSON $ABB_ORG abb-decides-all | $REJECTION" "$(py "a['status'] + ' | ' + steps().split(' | ')[3] + ' | ' + a['steps'][3]['reason']")"
check "a rejected request cannot be withdrawn: 409" 409 "$(take_step "$JA" "$CREATE_ID" intrekking)"
check "nor approved: 409" 409 "$(take_step "$JABB" "$CREATE_ID" goedkeuring)"
check "A contests without a reason: 422" 422 "$(take_step "$JA" "$CREATE_ID" betwisting)"
CONTEST="Het KBO-nummer is wel degelijk dat van het AGB, zie de bijlage van het besluit"
check "A contests the rejection" 201 "$(take_step "$JA" "$CREATE_ID" betwisting "$CONTEST")"
check "the request is in validation again" "ingediend | 5 betwisting ingediend user $A_PERSON $A_ORG requesting-organisation" "$(py "a['status'] + ' | ' + steps().split(' | ')[4]")"
check "ABB approves" 201 "$(take_step "$JABB" "$CREATE_ID" goedkeuring)"
check "it is afgehandeld: ABB's goedkeuring and the service's afhandeling" "afgehandeld | 6 goedkeuring goedgekeurd user $ABB_PERSON $ABB_ORG abb-decides-all | 7 afhandeling afgehandeld service None None None" "$(py "a['status'] + ' | ' + ' | '.join(steps().split(' | ')[5:7])")"
check "applied-at is the afhandeling; the target is no longer pending" "True False" "$(py "f\"{a['applied-at'] == a['steps'][6]['at']} {'meta' in d['data']['relationships']['target']}\"")"
check "the organisation exists now, with its name" "$NEW_NAME" "$(name_of "$JA" "$NEW_ORG")"
check "with its KBO number" "$KBO1" "$(get "$JA" "/administrative-units/$NEW_ORG/identifiers?include=structured-identifier" | python3 -c "import json,sys; d=json.load(sys.stdin); print(','.join(i['attributes'].get('local-id','') for i in d.get('included',[]) if i['type']=='structured-identifiers'))")"
check "classified as an AGB, with its primary site (once, not also among its sites) and its oprichting with the link to the besluit, in the organisation graph" "True False" "$(ask "GRAPH <$ORGS> { ?o <${MU}uuid> \"$NEW_ORG\" ; <${ORG}classification> <$AGB_URI> ; <${ORG}hasPrimarySite> ?s . ?e a <${ORG}ChangeEvent> ; <${ORG}originalOrganization> ?o ; <http://data.europa.eu/m8g/hasFormalFramework> ?d . ?d <http://xmlns.com/foaf/0.1/page> ?link }") $(ask "GRAPH <$ORGS> { ?o <${MU}uuid> \"$NEW_ORG\" ; <${ORG}hasSite> ?s }")"
check "its oprichting has its result, the organisation as resulting organisation, and a date" True "$(ask "GRAPH <$ORGS> { ?o <${MU}uuid> \"$NEW_ORG\" . ?e a <${ORG}ChangeEvent> ; <${ORG}resultingOrganization> ?o ; <http://purl.org/dc/terms/date> ?date ; <http://lblod.data.gift/vocabularies/organisatie/veranderingsgebeurtenisResultaat> ?r . ?r <http://mu.semte.ch/vocabularies/ext/resultingOrganization> ?o }")"
check "the detail returns the eight operations, the organisation first under its minted uuid" "8 create administrative-units $NEW_ORG $NEW_NAME" "$(fetch "$JA" "/change-requests/$CREATE_ID" >/dev/null; py "f\"{len(a['operations'])} {a['operations'][0]['op']} {a['operations'][0]['data']['type']} {a['operations'][0]['data']['id']} {a['operations'][0]['data']['attributes']['name']}\"")"
check "filter[target-classification] still finds it, now through the organisation" True "$(fetch "$JB" "/change-requests?filter[target-classification]=$AGB&filter[status]=afgehandeld&filter[created][gte]=$RUN_START" >/dev/null; py "'$CREATE_ID' in ids()")"
check "the same KBO number again: 409, it names the registered organisation" "409 $NEW_ORG" "$(post "$JA" /change-requests "$(creation_body "$NEW_NAME (ter)" "$KBO1" "$AGB" "")") $(py "d['errors'][0]['meta']['organisation']['id']")"
DOTTED="${KBO4:0:4}.${KBO4:4:3}.${KBO4:7:3}"
check "a KBO number with dots is kept as its ten digits" "201 $KBO4" "$(post "$JA" /change-requests "$(creation_body "AGB met punten (test Lokale Verkenner $STAMP)" "$DOTTED" "$AGB" "")") $(fetch "$JA" "/change-requests/$(py "d['data']['id']")" >/dev/null; py "[o['data']['attributes']['local-id'] for o in a['operations'] if o['data']['type'] == 'structured-identifiers'][0]")"
check "it is withdrawn again" 201 "$(take_step "$JA" "$(py "d['data']['id']")" intrekking)"
check "a KBO number that is not ten digits: 422" 422 "$(post "$JA" /change-requests "$(creation_body "AGB (test)" "12345" "$AGB" "")")"
check "an AGB without a KBO number: 422" 422 "$(post "$JA" /change-requests "$(creation_body "AGB zonder KBO (test)" "" "$AGB" "" | without_kbo)")"
check "an interlokale vereniging without a KBO number: it waits" "201 ingediend" "$(post "$JA" /change-requests "$(creation_body "ILV zonder KBO (test Lokale Verkenner $STAMP)" "" "$ILV" "" | without_kbo)") $(py "a['status']")"
check "it is withdrawn again" 201 "$(take_step "$JA" "$(py "d['data']['id']")" intrekking)"
# The KBO number is claimed again on approval: B gets it in the register while A's creation waits.
check "A requests another AGB" 201 "$(post "$JA" /change-requests "$(creation_body "AGB met betwist nummer (test Lokale Verkenner $STAMP)" "$KBO5" "$AGB" "")")"
P5=$(py "d['data']['id']"); PENDING+=("$P5")
KBO5_ID="http://data.lblod.info/id/identificatoren/e2e-$STAMP"; KBO5_SID="http://data.lblod.info/id/gestructureerdeIdentificatoren/e2e-$STAMP"
sparql_update "INSERT DATA { GRAPH <$ORGS> { <$B_URI> <http://www.w3.org/ns/adms#identifier> <$KBO5_ID> . <$KBO5_ID> a <http://www.w3.org/ns/adms#Identifier> ; <${MU}uuid> \"e2e-id-$STAMP\" ; <${SKOS}notation> \"KBO nummer\" ; <https://data.vlaanderen.be/ns/generiek#gestructureerdeIdentificator> <$KBO5_SID> . <$KBO5_SID> a <https://data.vlaanderen.be/ns/generiek#GestructureerdeIdentificator> ; <${MU}uuid> \"e2e-sid-$STAMP\" ; <https://data.vlaanderen.be/ns/generiek#lokaleIdentificator> \"$KBO5\" } }" >/dev/null
check "ABB approves it after B got the number: 409, it names B, nothing applied" "409 $B_ORG ingediend" "$(take_step "$JABB" "$P5" goedkeuring) $(py "d['errors'][0]['meta']['organisation']['id']") $(fetch "$JA" "/change-requests/$P5" >/dev/null; py "a['status']")"
sparql_update "DELETE WHERE { GRAPH <$ORGS> { <$B_URI> <http://www.w3.org/ns/adms#identifier> <$KBO5_ID> } }" >/dev/null
sparql_update "DELETE WHERE { GRAPH <$ORGS> { <$KBO5_ID> ?p ?o } }" >/dev/null
sparql_update "DELETE WHERE { GRAPH <$ORGS> { <$KBO5_SID> ?p ?o } }" >/dev/null
check "A withdraws it" 201 "$(take_step "$JA" "$P5" intrekking)"

ABB_NEW="AGB van ABB (test Lokale Verkenner $STAMP)"
check "ABB registers an organisation itself" 201 "$(post "$JABB" /change-requests "$(creation_body "$ABB_NEW" "$KBO2" "$AGB" "")")"
ABB_NEW_ORG=$(py "d['data']['relationships']['target']['data']['id']"); remember_lids
check "it is applied at once (rule abb-auto-approves)" "afgehandeld | 1 indiening ingediend user $ABB_PERSON $ABB_ORG abb-edits-all | 2 goedkeuring goedgekeurd service None None abb-auto-approves | 3 afhandeling afgehandeld service None None None" "$(py "a['status'] + ' | ' + steps()")"
check "the organisation exists" "$ABB_NEW" "$(name_of "$JABB" "$ABB_NEW_ORG")"

check "A requests another organisation" 201 "$(post "$JA" /change-requests "$(creation_body "Derde AGB (test Lokale Verkenner $STAMP)" "$KBO3" "$AGB" "")")"
P3=$(py "d['data']['id']"); PENDING+=("$P3")
check "B cannot withdraw it: 403 (B sees it, but it is not B's)" 403 "$(take_step "$JB" "$P3" intrekking)"
check "A withdraws it" 201 "$(take_step "$JA" "$P3" intrekking)"
check "it is ingetrokken; the organisation never existed" "ingetrokken 404" "$(py "a['status']") $(code "$JA" "/administrative-units/$(python3 -c "import json; print(json.load(open('$TMP/body'))['data']['relationships']['target']['data']['id'])")")"
check "an unknown step type: 422" 422 "$(take_step "$JA" "$P3" goedkeuren)"

# --- a veranderingsgebeurtenis: A registers a naamswijziging, ABB approves over a conflict ----------------
EVENT_NAME="$A_NAME (na naamswijziging, test Lokale Verkenner)"
check "A requests a naamswijziging about itself, with the besluit and the new name" 201 "$(post "$JA" /change-requests "$(change_event_body "$A_ORG" "$EVENT_NAME" "$ABB_NAME")")"
EVENT_ID=$(py "d['data']['id']"); PENDING+=("$EVENT_ID"); remember_lids
check "it waits: ingediend, kind change-event, no conflict" "ingediend change-event []" "$(py "a['status'] + ' ' + a['kind'] + ' ' + json.dumps(a['conflicts'])")"
check "the name is unchanged meanwhile" "$ABB_NAME" "$(name_of "$JA" "$A_ORG")"
check "B lists it among the requests about A" True "$(fetch "$JB" "/change-requests?filter[target]=$A_ORG&filter[kind]=change-event&filter[status]=ingediend" >/dev/null; py "'$EVENT_ID' in ids()")"
FRESH="$A_NAME (ABB, intussen hernoemd)"
check "ABB renames A while the request waits" 201 "$(rename "$JABB" "$A_ORG" "$FRESH")"
check "the waiting request now shows a conflict on the name, computed live" "administrative-units name: base $ABB_NAME, current $FRESH, proposed $EVENT_NAME, competing -" "$(fetch "$JABB" "/change-requests/$EVENT_ID" >/dev/null; py "conflicts(a['conflicts'])")"
TOKEN=$(py "a['conflicts-token']")
check "ABB's approval without override: 409, the conflict re-checked" 409 "$(take_step "$JABB" "$EVENT_ID" goedkeuring)"
check "the 409 carries the token GET shows" "$TOKEN" "$(py "d['errors'][0]['meta']['conflicts-token']")"
check "approving with the token of other conflicts: 409, nothing applied" "409 $FRESH" "$(take_step "$JABB" "$EVENT_ID" goedkeuring "" '"0123abcd"') $(name_of "$JA" "$A_ORG")"
check "override true is refused: it must be the token of the conflicts reviewed" 422 "$(take_step "$JABB" "$EVENT_ID" goedkeuring "" true)"
check "ABB approves with the token of that conflict" 201 "$(take_step "$JABB" "$EVENT_ID" goedkeuring "" "\"$TOKEN\"")"
check "the afhandeling shows the conflict it overrode" "afgehandeld True administrative-units name: base $ABB_NAME, current $FRESH, proposed $EVENT_NAME, competing -" "$(py "a['status'] + ' ' + str(a['steps'][-1]['overrides-conflict']) + ' ' + conflicts([dict(c, **{'competing-requests': []}) for c in a['steps'][-1]['overridden-conflicts']])")"
check "read back, it is derived from the state the afhandeling replaced" "True" "$(fetch "$JA" "/change-requests/$EVENT_ID" >/dev/null; py "str(a['steps'][-1]['overrides-conflict'])")"
check "that state holds the name the approval overwrote" True "$(ask "GRAPH <$CRG> { ?r <${MU}uuid> \"$EVENT_ID\" . ?s a <${CR}Action> ; <${DCT}isPartOf> ?r ; <${PROV}invalidated> ?state . ?state a <${CR}RecordState> ; <${SKOS}prefLabel> \"$FRESH\" }")"
check "the name is the one of the naamswijziging" "$EVENT_NAME" "$(name_of "$JA" "$A_ORG")"
ABB_EVENT_NAME="$A_NAME (ABB, naamswijziging, test Lokale Verkenner)"
check "ABB registers a naamswijziging of A from a form that still shows an older name: it waits, with the conflict" "201 ingediend 1" "$(post "$JABB" /change-requests "$(change_event_body "$A_ORG" "$ABB_EVENT_NAME" "$ABB_NAME")") $(py "a['status']") $(py "len(a['conflicts'])")"
ABB_EVENT_ID=$(py "d['data']['id']"); PENDING+=("$ABB_EVENT_ID"); remember_lids
check "the name is unchanged meanwhile" "$EVENT_NAME" "$(name_of "$JA" "$A_ORG")"
check "ABB approves it with the token of the conflict it saw" "201 afgehandeld $ABB_EVENT_NAME" "$(take_step "$JABB" "$ABB_EVENT_ID" goedkeuring "" "\"$(fetch "$JABB" "/change-requests/$ABB_EVENT_ID" >/dev/null; py "a['conflicts-token']")\"") $(py "a['status']") $(name_of "$JA" "$A_ORG")"
check "the change event hangs off A in the organisation graph, with its type and the link to the besluit" True "$(ask "GRAPH <$ORGS> { ?o <${MU}uuid> \"$A_ORG\" . ?e a <${ORG}ChangeEvent> ; <${ORG}originalOrganization> ?o ; <${CH}typeWijziging> <http://lblod.data.gift/concepts/$NAAMSWIJZIGING> ; <http://data.europa.eu/m8g/hasFormalFramework> ?d . ?d <http://xmlns.com/foaf/0.1/page> ?link }")"

# --- a new vestiging with address and contact point, linked to A (site aggregate) ------------------
SITE="{\"data\":{\"type\":\"change-requests\",\"attributes\":{\"aggregate\":\"site\",\"operations\":[
 {\"op\":\"create\",\"data\":{\"type\":\"addresses\",\"lid\":\"a1\",\"attributes\":{\"street\":\"Grote Markt\",\"number\":\"3\",\"postcode\":\"9300\",\"municipality\":\"$ORG_A_LABEL\",\"country\":\"België\",\"full-address\":\"Grote Markt 3, $ORG_A_LABEL, België\"}}},
 {\"op\":\"create\",\"data\":{\"type\":\"contact-points\",\"lid\":\"c1\",\"attributes\":{\"email\":\"loket@example.org\",\"type\":\"Primary\"}}},
 {\"op\":\"create\",\"data\":{\"type\":\"sites\",\"lid\":\"s1\",\"attributes\":{\"site-type-name\":\"Testvestiging\"},\"relationships\":{\"address\":{\"data\":{\"type\":\"addresses\",\"lid\":\"a1\"}},\"contacts\":{\"data\":[{\"type\":\"contact-points\",\"lid\":\"c1\"}]}}}},
 {\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"relationships\":{\"sites\":{\"data\":[{\"type\":\"sites\",\"lid\":\"s1\"}]}}}}
 ]},\"relationships\":{\"target\":{\"data\":{\"type\":\"organizations\",\"id\":\"$A_ORG\"}}}}}"
check "A adds a vestiging with address and contact point" 201 "$(post "$JA" /change-requests "$SITE")"
SITE_ID=$(py "a['lids']['s1']"); ADDR_ID=$(py "a['lids']['a1']"); CP_ID=$(py "a['lids']['c1']")
street=$(get "$JA" "/administrative-units/$A_ORG/sites?include=address" | python3 -c "import json,sys; d=json.load(sys.stdin); print(','.join(i['attributes'].get('street','') for i in d.get('included',[]) if i['type']=='addresses'))")
check "the vestiging and its address are visible under A" "Grote Markt" "$street"

# a second vestiging from a page that loaded A before the first one existed: the sites merge
SITE2="{\"data\":{\"type\":\"change-requests\",\"attributes\":{\"aggregate\":\"site\",\"operations\":[
 {\"op\":\"create\",\"data\":{\"type\":\"sites\",\"lid\":\"s2\",\"attributes\":{\"site-type-name\":\"Tweede testvestiging\"}}},
 {\"op\":\"update\",\"data\":{\"type\":\"administrative-units\",\"id\":\"$A_ORG\",\"relationships\":{\"sites\":{\"data\":[{\"type\":\"sites\",\"lid\":\"s2\"}]}},\"meta\":{\"base\":{\"relationships\":{\"sites\":{\"data\":[]}}}}}}
 ]},\"relationships\":{\"target\":{\"data\":{\"type\":\"organizations\",\"id\":\"$A_ORG\"}}}}}"
check "a page that loaded A without the first vestiging adds a second one" 201 "$(post "$JA" /change-requests "$SITE2")"
check "it is applied without a conflict: the new vestiging is added to the sites, not put in their place" "afgehandeld []" "$(py "a['status'] + ' ' + json.dumps(a['conflicts'])")"
SITE2_ID=$(py "a['lids']['s2']")
linked() { ask "GRAPH <$ORGS> { ?o <${MU}uuid> \"$A_ORG\" ; <${ORG}hasSite> <http://data.lblod.info/id/vestigingen/$1> }"; }
check "A has both test vestigingen" "True True" "$(linked "$SITE_ID") $(linked "$SITE2_ID")"

# a delete from a page that loaded another e-mail address than the contact point has now
STALE_DELETE="{\"data\":{\"type\":\"change-requests\",\"attributes\":{\"aggregate\":\"site\",\"operations\":[
 {\"op\":\"update\",\"data\":{\"type\":\"sites\",\"id\":\"$SITE_ID\",\"relationships\":{\"contacts\":{\"data\":[]}},\"meta\":{\"base\":{\"relationships\":{\"contacts\":{\"data\":[{\"type\":\"contact-points\",\"id\":\"$CP_ID\"}]}}}}}},
 {\"op\":\"delete\",\"data\":{\"type\":\"contact-points\",\"id\":\"$CP_ID\",\"meta\":{\"base\":{\"attributes\":{\"email\":\"oud@example.org\",\"type\":\"Primary\"}}}}}
 ]},\"relationships\":{\"target\":{\"data\":{\"type\":\"organizations\",\"id\":\"$A_ORG\"}}}}}"
check "A deletes the contact point from a page that showed another e-mail address: 409" 409 "$(post "$JA" /change-requests "$STALE_DELETE")"
check "the conflict: the address changed since the page loaded it" "contact-points email: base oud@example.org, current loket@example.org, proposed None, competing -" "$(py "conflicts(d['errors'][0]['meta']['conflicts'])")"
check "the contact point stays" True "$(ask "?s <${MU}uuid> \"$CP_ID\"")"

# the records live in the right graphs
check "requests, steps, versions, states and links are in the change-requests graph" True "$(ask "GRAPH <$CRG> { ?r a <${CR}ChangeRequest> . ?s a <${CR}Action> ; <${DCT}isPartOf> ?r . ?v a <${CR}ProposedVersion> . ?b a <${CR}RecordState> }")"
check "no request, step, version, state or link leaks into the public graph or the organisation graph" False "$(ask "VALUES ?g { <$PUBLIC> <$ORGS> } GRAPH ?g { ?r a ?t . VALUES ?t { <${CR}ChangeRequest> <${CR}ProposedVersion> <${CR}Action> <${CR}RecordState> <${RDF}Statement> <http://open-services.net/ns/core#Error> } }")"
check "a request names its organisation (pav:createdBy) and the person who submitted it (dct:creator)" True "$(ask "GRAPH <$CRG> { ?r <${MU}uuid> \"$CREATE_ID\" ; <http://purl.org/pav/createdBy> ?org ; <${DCT}creator> ?person } GRAPH <$PUBLIC> { ?org <${MU}uuid> \"$A_ORG\" . ?person a <http://xmlns.com/foaf/0.1/Person> ; <${MU}uuid> \"$A_PERSON\" }")"
check "the versions of a request hang off its indiening step; the question, answer, rejection and contest are on their steps" True "$(ask "GRAPH <$CRG> { ?r <${MU}uuid> \"$CREATE_ID\" . ?s a <${CR}Action> ; <${DCT}isPartOf> ?r ; <http://schema.org/position> 1 ; <${PROV}generated> ?v . ?q <${DCT}isPartOf> ?r ; <http://schema.org/position> 2 ; <${DCT}description> \"$QUESTION\" . ?c <${DCT}isPartOf> ?r ; <http://schema.org/position> 5 ; <${DCT}description> \"$CONTEST\" }")"
check "A carries dct:modified and ext:lastModifiedBy, a person" True "$(ask "GRAPH <$ORGS> { ?o <${MU}uuid> \"$A_ORG\" ; <${DCT}modified> ?m ; <http://mu.semte.ch/vocabularies/ext/lastModifiedBy> ?by . } GRAPH <$PUBLIC> { ?by a <http://xmlns.com/foaf/0.1/Person> }")"


# --- the end of the run: put things back, then the summary --------------------------------------
restore
echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
