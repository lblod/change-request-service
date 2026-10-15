# change-request-service

Every edit of organisation data in app-rvs is a change request. The frontend posts the proposed
state of one aggregate (the kerngegevens of an organisation, a vestiging, ...) as an ordered
list of JSON:API documents. This service turns that into RDF version objects, one per entity,
checks who may edit what and that every record belongs to the organisation being edited, writes
the request with its versions into the change-requests graph and, since every request is
auto-approved in iteration 1, applies it to the application graph. The versions stay with their
request: they are the history, pending and applied state have the same shape and only the
request status differs. A stored version holds everything the apply needs, so a request that
failed to apply can be applied again from the graph.

The service reads the same `config/resources/*.json` files mu-cl-resources reads, so it knows every
type's class, attributes with predicate and datatype, relationships with predicate, target and
cardinality, and the URI base for new resources. There is no second copy of the model.

Built on [mu-javascript-template](https://github.com/mu-semtech/mu-javascript-template) 1.9.1.
No sudo anywhere: the service writes through a sparql-parser scope (see [Authorization](#authorization)).

## Flow of a POST

1. Resolve the session: `<session> session:account ?account` and `<session> ext:sessionGroup ?organisation`
   (the Loket shape mock-login writes). No session, no account or no organisation: 401.
2. Policy check with the `canEdit` rules. Denied: 403 with the rule that denied.
3. Look up, in one round, the records the operations name and the records of the target's
   aggregate: everything reachable from the target organisation over the relationships between
   the aggregate's types (`org:hasSite`, `org:hasPrimarySite`, `organisatie:bestaatUit`,
   `org:siteAddress`, `locn:address`, `adms:identifier`, `generiek:gestructureerdeIdentificator`,
   `schema:contactPoint` for the kerngegevens).
4. Build the version objects from the operations with the model: an update takes the master URI
   from the id, a create mints a uuid and a master URI from the type's `new-resource-base`, a
   delete yields a tombstone. Refused with 422: a type outside the aggregate, an unknown
   attribute or relationship, a value that does not fit its datatype, a relationship target of
   the wrong type, an unknown id or lid, an id that does not belong to the target's aggregate, an
   organisation document that is not an update of the target, a relationship outside the
   aggregate that differs from what the master holds (checked with one query).
5. Write the request record, status `ingediend`, with its versions into the change-requests graph.
6. Decide with the `autoApprove` rules (always true in iteration 1). When false: 201 with status `ingediend`.
7. Apply, one SPARQL update: for every version, delete on the master the predicates of the keys
   its document carried and insert the version's triples with the master URI as subject; a create
   also writes the class tree and the uuid of the new master; a tombstone deletes the master's
   outgoing triples and the incoming relationship triples. The same update stamps `dct:modified`
   and `ext:lastModifiedBy` on the target organisation and sets the request to `goedgekeurd` with
   `cr:appliedAt`. The update is idempotent but **not one transaction**: sparql-parser evaluates
   it and sends the effective quads to Virtuoso in several requests, deletes first, so a failure
   half-way can leave a master stripped. A failed update is therefore run once more right away;
   when that fails too the request is marked `mislukt` with the error, the answer is 409, and
   `POST /change-requests/:id/apply` applies the stored versions again.
8. Respond 201 with the request.

## API

All endpoints need a logged-in session (`mu-session-id`, as mu-identifier sets it). Bodies and
responses are JSON:API (`application/vnd.api+json`; the POST also accepts `application/json`).
Bodies up to `MAX_BODY_SIZE` (5 MB in the image) are accepted; above that the answer is 413.

### `POST /change-requests`

The kerngegevens page of a gemeente, saved as one request: its address, a new contact point, its
primary site, its KBO number and the organisation itself.

```json
{
  "data": {
    "type": "change-requests",
    "attributes": {
      "aggregate": "organization-core-data",
      "operations": [
        { "op": "update", "data": { "type": "addresses", "id": "4b6e…",
            "attributes": { "street": "Grote Markt", "number": "3", "box-number": null, "postcode": "9300",
                            "municipality": "Aalst", "province": "Oost-Vlaanderen", "country": "België",
                            "full-address": "Grote Markt 3, 9300 Aalst, België",
                            "address-register-uri": "https://data.vlaanderen.be/id/adres/123456" } } },
        { "op": "create", "data": { "type": "contact-points", "lid": "c1",
            "attributes": { "email": "info@aalst.be", "telephone": "+32 53 77 93 00", "type": "Primary" } } },
        { "op": "update", "data": { "type": "sites", "id": "77c2…",
            "relationships": { "address": { "data": { "type": "addresses", "id": "4b6e…" } },
                               "contacts": { "data": [ { "type": "contact-points", "lid": "c1" } ] },
                               "site-type": { "data": { "type": "site-types", "id": "dcc0…" } } } } },
        { "op": "delete", "data": { "type": "contact-points", "id": "c0ff…" } },
        { "op": "update", "data": { "type": "structured-identifiers", "id": "2e4a…", "attributes": { "local-id": "0207437468" } } },
        { "op": "update", "data": { "type": "administrative-units", "id": "9a01…",
            "attributes": { "name": "Stad Aalst", "legal-name": "Stad Aalst", "alternative-name": ["Aalst"], "purpose": null, "expected-end-date": null },
            "relationships": { "primary-site": { "data": { "type": "sites", "id": "77c2…" } },
                               "identifiers": { "data": [ { "type": "identifiers", "id": "1d3f…" } ] },
                               "scope": { "data": { "type": "locations", "id": "a2f6…" } },
                               "classification": { "data": { "type": "administrative-unit-classification-codes", "id": "5ab0…" } } } } }
      ]
    },
    "relationships": { "target": { "data": { "type": "organizations", "id": "9a01…" } } }
  }
}
```

- `aggregate` names an aggregate of the configuration; it whitelists the types the operations may
  touch (the configured types and their subtypes: a gemeente is an `administrative-units` document
  under the `organizations` root) and the code lists a document may link to (its `references`).
- `target` is the organisation the request is about (`organizations` or a subtype). The acting
  organisation comes from the session, never from the payload; the policy compares the two.
- `op` is `create`, `update` or `delete`. A create carries a `lid` (local id) instead of an `id`;
  other operations in the same request refer to it with `{ "type": "contact-points", "lid": "c1" }`.
  Creates may be referred to before or after their own position.
- **Every id must belong to the target.** The id of an update or delete, and every id a
  relationship inside the aggregate points at, must be a record of the target's aggregate: reachable
  from the target organisation over the relationships between the aggregate's types. Anything else
  is a 422, for ABB as well. A record that is no longer linked to the organisation is no longer part
  of its aggregate, so unlink and delete in the same request, as the pages do. References (code
  lists) only have to exist.
- **An organisation is only ever updated, and only the target itself.** A create or delete of an
  organisation type, or an update of another organisation, is a 422. New organisations and
  tombstones of organisations are out of scope.
- **Per-key semantics**, as a mu-cl-resources PATCH: applying a version replaces, on the master,
  exactly the attributes and relationships the document carries. A key that is absent is left as
  it is; `null` or `[]` clears it; a to-many relationship that is carried replaces the whole list,
  so a document that carries `sites` carries all of them. Ember omits a to-many relationship it has
  not loaded, which is then simply untouched.
- A relationship is part of the aggregate's state when its target type is in the aggregate
  (`sites`, `contacts`, `identifiers`, `primary-site`, `address`, ...) or one of its references
  (`scope`, `legal-form`, `content-themes`, `site-type`, `source`, ...).
- **A relationship outside the aggregate** (`classification`, `organization-status`,
  `additional-qualifications` where the aggregate has no `concepts` reference, ...) may be carried,
  as the frontend's serializer does, but must equal what the master holds: a value that differs is
  a 422, since the aggregate does not admit changing it. Classification and status changes stay out
  of reach until an aggregate or a rule admits them. Inverse relationships (`memberships`,
  `kbo-organization`, ...) are the other record's state and are ignored.
- Attribute values follow the model's attribute type (see [Datatypes](#datatypes)); `null` means no value.

Response `201 Created`:

```json
{
  "data": {
    "type": "change-requests",
    "id": "e0b1…",
    "attributes": {
      "status": "goedgekeurd",
      "created": "2026-11-03T10:12:00.000Z",
      "applied-at": "2026-11-03T10:12:01.000Z",
      "aggregate": "organization-core-data",
      "lids": { "c1": "6f3a…" }
    },
    "relationships": {
      "target": { "data": { "type": "organizations", "id": "9a01…" } },
      "requesting-organisation": { "data": { "type": "organizations", "id": "9a01…" } }
    }
  }
}
```

`lids` maps each create's local id to the uuid the service minted, so the frontend can reload the
right records. `status` is the short key of the status concept (`ingediend`, `goedgekeurd`,
`afgekeurd`, `ingetrokken`, `mislukt`).

| Status | When |
| --- | --- |
| 201 | the request is written; `status` says whether it was applied (`goedgekeurd`) or is waiting (`ingediend`) |
| 400 | the JSON could not be parsed |
| 401 | no session, or the session has no account or no acting organisation |
| 403 | the policy denies; `meta.rule` names the rule that denied (`null` when no rule allowed it) |
| 404 | the target organisation does not exist |
| 409 | the apply failed twice; the request is kept with status `mislukt` and `error`, `meta["change-request"]` carries its id, and `POST /change-requests/:id/apply` applies it again |
| 413 | the body exceeds `MAX_BODY_SIZE` |
| 422 | an operation falls outside the aggregate, an attribute or relationship is unknown, a relationship target has the wrong type, an id or lid is unknown, an id does not belong to the target organisation, an organisation document is not an update of the target, a relationship outside the aggregate differs from the master, a value does not fit its datatype; `source.pointer` points at the operation |

### `GET /change-requests?filter[target]=<organisation uuid>` and `GET /change-requests/:id`

The requests the acting organisation may see: those about it and those it submitted; ABB sees
all. Newest first, no pagination. A filter on another organisation (or an unknown one) returns an
empty list, not an error; a single request that is not visible is a 404. The documents have the
same shape as above, without `lids`, plus `error` on a failed request.

### `POST /change-requests/:id/apply`

Applies the stored versions of a request with status `mislukt` again, with the same `canEdit`
policy as a POST on its target. `200` with the request (status `goedgekeurd`, `applied-at`) when
it lands; `409` when the request did not fail, when it failed again (it stays `mislukt`), or when
a later request on the same organisation was applied since: the stored versions would overwrite
what that one changed, so the change is submitted again instead. The frontend keeps its edits on
a 409, so the usual way out of a failed apply is to save again; this endpoint is for a request
whose organisation was left stripped after the user went away.

### `GET /change-requests/permissions?target=<organisation uuid>`

```json
{ "can-edit": true, "rules": ["own-organisation"] }
```

The same `canEdit` evaluation the POST runs, so the frontend and the server cannot disagree.
`rules` names the rule that decided (empty when no rule answered, which is a deny). 404 when the
organisation does not exist.

### Errors

```json
{ "errors": [ { "status": "422", "title": "Unprocessable change request",
                "detail": "unknown attribute \"colour\" for type \"addresses\"",
                "source": { "pointer": "/data/attributes/operations/0/data/attributes/colour" } } ] }
```

## What is written

```turtle
@prefix cr: <http://lblod.data.gift/vocabularies/change-requests/> .

<http://data.lblod.info/id/change-requests/UUID> a cr:ChangeRequest ;
  mu:uuid "UUID" ;
  dct:created "2026-11-03T10:12:00Z"^^xsd:dateTime ;
  adms:status <http://lblod.data.gift/concepts/change-request-status/goedgekeurd> ;
  cr:aggregate "organization-core-data" ;
  cr:target <http://data.lblod.info/id/bestuurseenheden/…> ;
  cr:requestingOrganisation <http://data.lblod.info/id/bestuurseenheden/…> ;
  prov:wasAttributedTo <account uri> ;
  cr:appliedAt "2026-11-03T10:12:01Z"^^xsd:dateTime ;
  prov:generated <http://data.lblod.info/id/versions/UUID2>, <…UUID3>, <…UUID4> .

<http://data.lblod.info/id/versions/UUID2> a cr:Version ;
  mu:uuid "UUID2" ;
  dct:isVersionOf <http://data.lblod.info/id/bestuurseenheden/…> ;
  cr:masterUuid "…" ;
  prov:generatedAtTime "2026-11-03T10:12:00Z"^^xsd:dateTime ;
  prov:wasGeneratedBy <http://data.lblod.info/id/change-requests/UUID> ;
  cr:resourceType "administrative-units" ;
  cr:operation "update" ;
  cr:replaces skos:prefLabel, org:hasPrimarySite, … ;     # the predicates the document carried
  skos:prefLabel "…" ; org:hasPrimarySite <site uri> ; … .

<http://data.lblod.info/id/versions/UUID3> a cr:Version ;     # a create: no cr:replaces
  dct:isVersionOf <http://data.lblod.info/id/contact-punten/…> ;
  cr:masterUuid "…" ;
  cr:resourceType "contact-points" ;
  cr:operation "create" ;
  schema:email "…" ; … .

<http://data.lblod.info/id/versions/UUID4> a cr:Version ;     # a tombstone
  dct:isVersionOf <http://data.lblod.info/id/contact-punten/…> ;
  cr:resourceType "contact-points" ;
  cr:operation "delete" ;
  cr:deleted true ; … .
```

Relationships in a version point at master URIs, never at other versions. `cr:resourceType` is
the JSON:API type of the entity, `cr:operation` what was done to it, `cr:replaces` which predicates
the apply removes from the master before inserting the version's triples, so a stored version can
be applied again from the model and the graph alone (`POST /change-requests/:id/apply`). A failed
request carries `cr:error "…"`. Both records live in the change-requests graph; the masters live in
the application graph.

## Configuration

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEFAULT_MU_AUTH_SCOPE` | `http://services.lblod.info/change-request-service` (set in the Dockerfile) | the scope the template sends on every query; sparql-parser grants the writes to it |
| `MAX_BODY_SIZE` | `5mb` (set in the Dockerfile; the template's own default is `100kb`) | the body limit of the template's JSON:API parser, which runs before the routes; above it the answer is 413. A stack that runs the template image with the sources mounted (development mode) must set it itself |
| `MODEL_DIR` | `/config/resources` | the mu-cl-resources JSON model files; every `*.json` in it is read |
| `CONFIG_FILE` | `/config/change-requests.json` | the aggregates and policy configuration (below) |
| `APPLICATION_GRAPH` | `MU_APPLICATION_GRAPH` or `http://mu.semte.ch/application` | the graph of the masters |
| `CHANGE_REQUESTS_GRAPH` | `http://mu.semte.ch/graphs/change-requests` | the graph of the requests and versions |
| `MU_SPARQL_ENDPOINT` | `http://database:8890/sparql` | the template's database endpoint |
| `LOG_SPARQL_ALL`, `LOG_SPARQL_QUERIES`, `LOG_SPARQL_UPDATES`, `DEBUG_AUTH_HEADERS` | template defaults | query logging |

### `/config/change-requests.json`

```json
{
  "aggregates": {
    "organization-core-data": {
      "root": "organizations",
      "members": ["addresses", "contact-points", "sites", "structured-identifiers", "identifiers"],
      "references": ["locations", "concepts", "site-types"]
    },
    "site": {
      "root": "sites",
      "members": ["addresses", "contact-points", "organizations"],
      "references": ["site-types", "concepts"]
    }
  },
  "abbUri": "http://data.lblod.info/id/bestuurseenheden/141d9d6b-54af-4d17-b313-8d1c30bc3f5b",
  "statusScheme": "http://lblod.data.gift/concept-schemes/change-request-status"
}
```

An aggregate is a whitelist. `root` and `members` are the types a request may create, update and
delete (an organisation type is only ever updated, see above); for each type the model says which
predicates. `references` are types a document may link to but never operate on: the code lists
the pages pick from (werkingsgebied is a `locations`, juridische vorm and inhoudelijke thema's are
`concepts`, vestigingstype a `site-types`). A relationship is editable inside an aggregate when its
target type is a member, the root or a reference; any other relationship a document carries must
be unchanged. `abbUri` is the organisation whose sessions may edit everything. The file ships with
the image (`config/change-requests.json`) and is overridden by mounting `/config`. Every type an
aggregate names must exist in the model, and a reference cannot also be a member, or the service
refuses to start.

The `site` aggregate covers a site with its address and contact points, plus the organisation so
the page can link the site: the vestiging page sends the organisation as an update of the target
with `sites` (all of them, the new one by `lid`) and, when it is the primary site, `primary-site`.
Under the per-key rule that document changes nothing but the keys it carries.

### The resources model mount

app-rvs runs the service like this (docker-compose.yml); the configuration and the model are
mounted side by side, not nested, so docker creates no mount points inside the app's config:

```yaml
change-requests:
  image: lblod/change-request-service:0.1.0
  environment:
    DEFAULT_MU_AUTH_SCOPE: "http://services.lblod.info/change-request-service"
    APPLICATION_GRAPH: "http://mu.semte.ch/graphs/public"
    CONFIG_FILE: "/config/change-requests/change-requests.json"
  volumes:
    - ./config/change-requests:/config/change-requests:ro
    - ./config/resources:/config/resources:ro
```

The template talks to `http://database:8890/sparql`, which is sparql-parser in app-rvs. A model
that loads only part of OP's files (app-rvs reads `domain.json` and `auth.json`) may hold
relationships to types it does not define; the service logs them at start-up and leaves them out,
as mu-cl-resources only fails when such a relationship is used.

Dispatcher:

```elixir
match "/change-requests/*path", %{accept: [:json], layer: :api} do
  Proxy.forward(conn, path, "http://change-requests/change-requests/")
end
```

A field added to a page is added to the resources model and to the frontend; the service picks it
up from the model files. A new type is also added to its aggregate, a new code list to its references.

## Authorization

sparql-parser stays the single place where access is defined. The template sends
`DEFAULT_MU_AUTH_SCOPE` with every query and forwards the user's session, so every write is
still attributed to the user in deltas and logs.

The design rests on the scope header being settable by services inside the stack only. That needs
**mu-identifier 1.11.0 or later**: 1.11.0 is the first version that strips `mu-auth-scope` from
what a browser sends (1.10.3 strips `mu-auth-sudo` and `mu-auth-allowed-groups` but lets
`mu-auth-scope` through). It also rests on no proxied service forwarding an incoming
`mu-auth-scope` to the database: mu-cl-resources 1.27.2 forwards only `mu-session-id`,
`mu-call-id` and `mu-auth-allowed-groups`, and the template sets the scope from
`DEFAULT_MU_AUTH_SCOPE` only. `scripts/integration.sh` checks both: a PATCH on a resource route with
a forged `mu-auth-scope` is refused through the dispatcher and, with `IDENTIFIER_URL` set, through
the identifier.

This is the configuration in app-rvs (`config/authorization/config.lisp`), where all data lives in
`http://mu.semte.ch/graphs/public` and every session carries the `public` group:

```lisp
;; read side: anyone reads the organisation data; nobody gets a write grant on this spec
(define-graph public ("http://mu.semte.ch/graphs/public")
  (_ -> _))

;; the same graph as the service may write it: only the types of its aggregates
(define-graph organisation-data ("http://mu.semte.ch/graphs/public")
  ("org:Organization" -> _) ("besluit:Bestuurseenheid" -> _) ("regorg:RegisteredOrganization" -> _)
  ("org:Site" -> _) ("locn:Address" -> _) ("schema:ContactPoint" -> _) ("adms:Identifier" -> _)
  ("generiek:GestructureerdeIdentificator" -> _))

(define-graph change-requests ("http://mu.semte.ch/graphs/change-requests" :delta nil)
  ("cr:ChangeRequest" -> _)
  ("cr:Version" -> _))

(define-graph sessions ("http://mu.semte.ch/graphs/sessions")
  ("session:Session" -> _))

;; Nobody writes the organisation data directly: every edit is a change request.
;; Writes happen only through change-request-service (POST /change-requests), which sends the
;; scope below and enforces who may edit what (its policies/ folder). Reads of change requests
;; are filtered per organisation by that service, not here.
(grant (read) :to-graph public :for-allowed-group "public")

(with-scope "http://services.lblod.info/change-request-service"
  (grant (read) :to-graph (public sessions) :for-allowed-group "public")
  (grant (read write) :to-graph (organisation-data change-requests) :for-allowed-group "public"))
```

What the configuration must provide, because of how sparql-parser works:

- **Scoped grants are the only grants a scoped call gets.** sparql-parser matches a grant on the
  scope of the call (`acl/acl.lisp`, `accessible-graphs`), and a grant without `with-scope`
  belongs to the no-scope call only. The service resolves the session with the same scoped
  query, so the scope must also grant read on the graph where mock-login writes
  `session:account` and `ext:sessionGroup` (`http://mu.semte.ch/graphs/sessions`).
- **Placement follows the type specs, not the GRAPH clause.** The service names the graphs in its
  updates (that makes it correct on a bare triplestore too), but sparql-parser dispatches every
  quad to *every* writable graph whose `define-graph` matches the type of its subject, and refuses
  the update when a quad matches none. So `cr:ChangeRequest` and `cr:Version` must be in the
  change-requests spec, every class the service writes to (`org:Site`, `locn:Address`, ...) in a
  writable spec of the data graph, and that writable spec must not be `(_ -> _)`: such a spec
  matches the service's own records too, and they would be written to the data graph as well,
  readable by everyone. Hence the second, typed spec on the same graph for the write grant.
- **No other write grant on the data graph**, so a direct POST, PATCH or DELETE from the frontend
  to a resource route has no writable graph and is refused (mu-cl-resources answers 500).

sparql-parser 0.0.15 passes the service's property-path query (the records reachable from the
target) and its `VALUES (?s ?p)` query (the unchanged check) through to Virtuoso unchanged.

## Policies

`policies/rules.js` holds one function per rule, `async (ctx) => "allow" | "deny" | undefined`,
with `ctx = { session, account, actor: { uri, uuid, classification }, target: { uri, uuid,
classification }, aggregate, operations, config }`. `policies/index.js` orders them:

```js
export const canEdit = [abbEditsAll, ownOrganisation];
export const autoApprove = [always];
```

The first rule that answers decides; no answer means deny. The permissions endpoint, the POST and
the re-apply run the same lists. A rule is reported under its kebab-case name (`own-organisation`,
`abb-edits-all`). Later rules slot in without touching the flow: `memberOfTargetPartnership`,
`targetTypeIn([...])`, `aggregateIn([...])`; "auto-approve when actor equals target, otherwise
ingediend" is a one-line change in `autoApprove`. Kept for later, not built now:
`POST /change-requests/:id/approve`, `POST /change-requests/:id/reject`, `PATCH` and `DELETE`
on a request while it is ingediend.

## Datatypes

`lib/literals.js` is the table that turns a JSON:API attribute value into an RDF term per
attribute `type` of the model. It mirrors what mu-cl-resources writes
(`framework/request-parsing.lisp`) for a stack with `*use-custom-boolean-type-p*` set to nil, as
OP's `domain.lisp` does; `test/literals.test.js` compares the two for the values of one organisation.

| model type | written as |
| --- | --- |
| `string` | plain literal |
| `uri` | plain literal: mu-cl-resources has no `uri` write type, the value takes its default path |
| `url` | IRI; the value must be an absolute URI without whitespace or `< > " { } \| ^ \` \\` |
| `date`, `datetime`, `time`, `g-year` | `xsd:date`, `xsd:dateTime` (normalised to UTC), `xsd:time`, `xsd:gYear` |
| `number`, `integer`, `float` | `xsd:decimal`, `xsd:integer`, `xsd:float` |
| `boolean` | `xsd:boolean` |
| `string-set`, `uri-set` | one literal or IRI per value (IRIs checked as for `url`) |
| `language-string`, `language-string-set` | `"content"@language` from `{ "content", "language" }` |
| `geometry` | `geo:wktLiteral` |

A value that does not fit its type is a 422. Every term is rendered with the template's
`sparqlEscape` helpers.

## Development

```sh
npm run setup      # once: installs the template's node_modules and its `mu` helper locally (needs docker)
npm test           # unit tests (node:test) against OP's model files
MODEL_DIR=../app-rvs/config/resources npm test   # the same against app-rvs's files (domain.json and auth.json only)
npm run check      # node --check app.js
```

The tests read the model from `MODEL_DIR`, by default `../app-organization-portal/config/resources`;
they assert on the types both models define (assertions on types from change-events.json, file.json
or dcat.json run only when the model has them) and the fixture documents carry only keys both define,
so the suite and the golden files hold for either. `test/fixtures/*.sparql` are golden copies of
the generated updates for a small organization-core-data request; `UPDATE_GOLDEN=1 npm test`
rewrites them after an intended change, review the diff.

`scripts/e2e-mock-login.sh` runs the end-to-end flow against app-rvs as a browser would: through
mu-identifier, logged in with mock-login as two gemeenten and ABB. It checks the permissions, a
rename through a change request, a refused cross-organisation request, refused direct and
forged-scope writes, the listings, a new vestiging, the graphs the records land in, and puts the
data back. It needs `curl` and `python3`; `BASE_URL` (default `http://localhost:88`, app-rvs's
identifier in docker-compose.dev.yml) and `SPARQL_ENDPOINT` (default `http://localhost:8899/sparql`,
its Virtuoso) can be overridden, as can the organisations by label (`ORG_A_LABEL`, `ORG_B_LABEL`).

`scripts/integration.sh` runs a larger set of calls (validation errors, body limits, the re-apply
endpoint) with the sessions sent as a raw `mu-session-id` header: `BASE_URL`, `SESSION_ORG_A`,
`SESSION_ORG_B`, `SESSION_ABB`, `ORG_A_UUID`, `ORG_B_UUID`, optionally `SPARQL_ENDPOINT` and
`IDENTIFIER_URL`. A raw header only works on a port that bypasses mu-identifier (the dispatcher's
or the service's), which app-rvs does not publish; take the session URIs from mock-login logins
(the `sessions` graph) and publish the dispatcher port locally to use it. The checks that need a
code list (site types) are skipped when the stack has none loaded.

To run the service against a mounted checkout in a stack, use the template's development mode
(`NODE_ENV: development`, sources mounted at `/app`), with `MODEL_DIR` pointing at the mounted
model and `MAX_BODY_SIZE` set in the compose file (the Dockerfile's ENV does not apply there).

## Open points

- Versions are not exposed over the API yet (the history is read from the graph); an approval
  screen renders pending versions straight from the change-requests graph.
- The `lid` convention and the session contract (`session:account`, `ext:sessionGroup`) are the
  Loket shape, to be aligned with mock-login and the frontend.
- A create does not have to be linked from the request: a record created without a link is
  outside every aggregate from then on. The pages always link what they create.
