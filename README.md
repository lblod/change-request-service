# change-request-service

Every edit of organisation data in app-rvs is a change request. The frontend posts the proposed
state of one aggregate (the kerngegevens of an organisation, a vestiging, ...) as an ordered
list of JSON:API documents, each update with the values its form started from. This service turns
that into RDF version objects, one per entity that changes, checks who may edit what and that
every record belongs to the organisation being edited, writes the request with its versions into
the change-requests graph and applies it to the application graph once it is approved: at once,
by the service, when nobody changed the same values since the form was loaded; otherwise it waits
for ABB, who approves or rejects it. Every request carries an ordered trail of steps (indiening,
goedkeuring, afkeuring, intrekking, hertoepassing) that records who did what, when and under which
rule; its status is the status of its last step. The versions stay with their request: they are
the history, pending and applied state have the same shape and only the status differs. A stored
version holds everything the apply needs, so a request approved later, or one that failed to
apply, is applied from the graph.

The service reads the same `config/resources/*.json` files mu-cl-resources reads, so it knows every
type's class, attributes with predicate and datatype, relationships with predicate, target and
cardinality, and the URI base for new resources. There is no second copy of the model.

Built on [mu-javascript-template](https://github.com/mu-semtech/mu-javascript-template) 1.9.1.
No sudo anywhere: the service writes through a sparql-parser scope (see [Authorization](#authorization)).

## Flow of a POST

1. Resolve the session: `<session> session:account ?account` and `<session> ext:sessionGroup ?organisation`
   (the Loket shape mock-login writes), and the person of the account (`?person foaf:account
   ?account`), whom the service records. No session, no account, no organisation or no person: 401.
2. Policy check with the `canEdit` rules. Denied: 403 with the rule that denied.
3. Take the lock of the target organisation: steps 4 to 10 run for one request at a time per
   organisation, so a request reads what a request on the same organisation applied a moment
   earlier (see [Simultaneous requests](#simultaneous-requests)).
4. Look up, in one round, the records the operations and their base values name, and the records
   of the target's aggregate: everything reachable from the target organisation over the
   relationships between the aggregate's types (`org:hasSite`, `org:hasPrimarySite`,
   `organisatie:bestaatUit`, `org:siteAddress`, `locn:address`, `adms:identifier`,
   `generiek:gestructureerdeIdentificator`, `schema:contactPoint` for the kerngegevens). A base
   value may name a record that was deleted after the form was loaded; such an id is found through
   its versions.
5. Build the version objects from the operations with the model: an update takes the master URI
   from the id, a create mints a uuid and a master URI from the type's `new-resource-base`, a
   delete yields a tombstone, which removes every attribute and relationship of its type. Refused
   with 422: a type outside the aggregate, an unknown attribute or relationship, a value that does
   not fit its datatype, a relationship target of the wrong type, an unknown id or lid, an id that
   does not belong to the target's aggregate, an organisation document that is not an update of
   the target, a malformed `meta.base`.
6. Read the current value of every key the updates and tombstones carry (one query, in batches)
   and the records that link to the records it deletes, and settle each key with the
   [base rule](#base-values): a key the user did not change and a key the master already holds
   are dropped, a key someone else changed since the form was loaded is a conflict and stays in
   the version; a set (a to-many relationship, a set attribute) merges the user's additions and
   removals into what the master holds now; a tombstone conflicts on a value set or added since
   its page loaded the record. An update that ends up changing nothing leaves no version (the
   request is still recorded). A relationship outside the aggregate that the document changes is
   a 422.
7. Look up the competing requests of every key the versions write: other pending requests whose
   versions write the same key of the same record and disagree with it (see
   [Conflicts](#conflicts)).
8. Write the request, its indiening step (sequence 1, with the person, the acting organisation and
   the `canEdit` rule that allowed it) and the versions with the states they started from (for a
   tombstone with the links to its master) into the change-requests graph, status `ingediend`, in
   one INSERT DATA.
9. Decide with the `autoApprove` rules: `holdOnConflict` keeps a request with conflicts for ABB,
   `always` approves the rest. Held: 201 with status `ingediend`, the conflicts and their token.
10. Apply, one SPARQL update: for every version, delete on the master the values of the
    single-valued keys it changes and the set values it removes, and insert the values it writes
    with the master URI as subject; a create also writes the class tree and the uuid of the new
    master; a tombstone deletes the master's outgoing triples and the incoming relationship
    triples. When a version is applied the same update stamps
    `dct:modified` and `ext:lastModifiedBy` (the person who submitted the request) on the target
    organisation; it always adds the goedkeuring step (sequence 2, taken by the service, with the
    `autoApprove` rule) with the states it replaced (what the masters held, read under the lock,
    for the keys the versions change) and sets the request to `goedgekeurd`. The update is
    idempotent but **not one transaction**: sparql-parser evaluates it and sends the effective
    quads to Virtuoso in several requests, deletes first, so a failure half-way can leave a master
    stripped. A failed update is therefore run once more right away; when that fails too the
    goedkeuring step is recorded with status `mislukt` and an `oslc:Error`, the request becomes
    `mislukt`, the answer is 409, and a hertoepassing step applies the stored versions again.
11. Withdraw the older pending requests this one replaces (the `supersede` rules): a request of
    the same organisation about the same target, submitted before this one, whose every version
    updates only single-valued keys that this request wrote. The service takes an intrekking on
    each (rule `superseded-by-own-request`, reason "Vervangen door wijzigingsaanvraag <uuid>") and
    records the newer request as its `dct:isReplacedBy`.
    An older request that also proposes other keys, changes a set, creates or deletes a record,
    or comes from another organisation keeps waiting for ABB. A failure here is logged and does
    not undo the apply. The same happens after a goedkeuring or a hertoepassing step.
12. Respond 201 with the request, its conflicts, the keys other pending requests compete for, and
    the uuids of the requests it replaced (`superseded`).

## API

All endpoints need a logged-in session (`mu-session-id`, as mu-identifier sets it). Bodies and
responses are JSON:API (`application/vnd.api+json`; the POSTs also accept `application/json`).
Bodies up to `MAX_BODY_SIZE` (5 MB in the image) are accepted; above that the answer is 413.

### `POST /change-requests`

The kerngegevens page of a gemeente, saved as one request: its address, a new contact point, its
primary site, its KBO number and the organisation itself. Each update carries in `meta.base` the
values its form loaded.

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
                            "address-register-uri": "https://data.vlaanderen.be/id/adres/123456" },
            "meta": { "base": { "attributes": { "street": "Grote Markt", "number": "1", "box-number": null, "postcode": "9300",
                                                "municipality": "Aalst", "province": "Oost-Vlaanderen", "country": "België",
                                                "full-address": "Grote Markt 1, 9300 Aalst, België",
                                                "address-register-uri": "https://data.vlaanderen.be/id/adres/123455" } } } } },
        { "op": "create", "data": { "type": "contact-points", "lid": "c1",
            "attributes": { "email": "info@aalst.be", "telephone": "+32 53 77 93 00", "type": "Primary" } } },
        { "op": "update", "data": { "type": "sites", "id": "77c2…",
            "relationships": { "address": { "data": { "type": "addresses", "id": "4b6e…" } },
                               "contacts": { "data": [ { "type": "contact-points", "lid": "c1" } ] },
                               "site-type": { "data": { "type": "site-types", "id": "dcc0…" } } },
            "meta": { "base": { "relationships": { "address": { "data": { "type": "addresses", "id": "4b6e…" } },
                                                   "contacts": { "data": [ { "type": "contact-points", "id": "c0ff…" } ] },
                                                   "site-type": { "data": null } } } } } },
        { "op": "delete", "data": { "type": "contact-points", "id": "c0ff…" } },
        { "op": "update", "data": { "type": "structured-identifiers", "id": "2e4a…", "attributes": { "local-id": "0207437468" },
            "meta": { "base": { "attributes": { "local-id": "0207437468" } } } } },
        { "op": "update", "data": { "type": "administrative-units", "id": "9a01…",
            "attributes": { "name": "Stad Aalst", "legal-name": "Stad Aalst", "alternative-name": ["Aalst"], "purpose": null, "expected-end-date": null },
            "relationships": { "primary-site": { "data": { "type": "sites", "id": "77c2…" } },
                               "identifiers": { "data": [ { "type": "identifiers", "id": "1d3f…" } ] },
                               "scope": { "data": { "type": "locations", "id": "a2f6…" } },
                               "classification": { "data": { "type": "administrative-unit-classification-codes", "id": "5ab0…" } } },
            "meta": { "base": { "attributes": { "name": "Aalst", "legal-name": null, "alternative-name": ["Aalst"], "purpose": null, "expected-end-date": null },
                                "relationships": { "primary-site": { "data": { "type": "sites", "id": "77c2…" } },
                                                   "identifiers": { "data": [ { "type": "identifiers", "id": "1d3f…" } ] },
                                                   "scope": { "data": { "type": "locations", "id": "a2f6…" } },
                                                   "classification": { "data": { "type": "administrative-unit-classification-codes", "id": "5ab0…" } } } } } } }
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
- **Per-key semantics**, as a mu-cl-resources PATCH: applying a version changes, on the master,
  exactly the attributes and relationships it carries. A key that is absent is left as it is;
  `null` or `[]` clears it. A to-many relationship or a set attribute that is carried holds the
  whole list, so a document that carries `sites` carries all of them; with a base the service
  applies only what the user added and removed (see below), so a site someone else added in the
  meantime stays. Ember omits a to-many relationship it has not loaded, which is then simply
  untouched.
- **Base values** (`meta.base`): see [below](#base-values). In the example the structured identifier
  changes nothing and leaves no version, the address writes its number, full address and register
  link, the site its contacts and site type, the organisation its name and legal name.
- A relationship is part of the aggregate's state when its target type is in the aggregate
  (`sites`, `contacts`, `identifiers`, `primary-site`, `address`, ...) or one of its references
  (`scope`, `legal-form`, `content-themes`, `site-type`, `source`, ...).
- **A relationship outside the aggregate** (`classification`, `organization-status`,
  `additional-qualifications` where the aggregate has no `concepts` reference, ...) may be carried,
  as the frontend's serializer does, but not changed: it must equal its base (the page carries it
  as it loaded it) or what the master holds; anything else is a 422, since the aggregate does not
  admit changing it. Classification and status changes stay out of reach until an aggregate or a
  rule admits them. Inverse relationships (`memberships`, `kbo-organization`, ...) are the other
  record's state and are ignored.
- Attribute values follow the model's attribute type (see [Datatypes](#datatypes)); `null` means no value.

#### Base values

The pages send every attribute of a record, not only the ones the user changed, so a form that
was loaded before someone else saved would put the old values back. An update therefore carries,
in `meta.base`, the values its form started from, for the keys it carries: `attributes` by name,
`relationships` by name as `{ "data": identifier | [identifiers] | null }`.

For every single-valued key K the update carries (an attribute that is not a set, a to-one
relationship), with base B, proposal P and the value C the master holds when the service reads
it (under the [lock](#simultaneous-requests)):

| Case | K is written | Conflict |
| --- | --- | --- |
| P = B: the user did not change K | no, so a change someone made since stays | no |
| P ≠ B and C = B | yes | no |
| P ≠ B and C = P: the same change was made already | no | no |
| P ≠ B and C is neither B nor P: someone else changed K | yes, the proposal is kept in the version | yes |

A set (a to-many relationship, a `string-set`, `uri-set` or `language-string-set` attribute)
merges instead: the version adds to what the master holds what P has and B had not, and removes
what B had and P has not; what others added or removed in the meantime stays. Two changes from the
same base cannot disagree on an item (one can only remove what B has, the other only add what B
lacks), so a set never conflicts: two pages that each add a vestiging both get theirs. The version
keeps P and B, so a request approved later merges the same way into what the master holds then.
It is written when the merge changes the master, and not when the master already holds the result.

A key the base does not carry starts from the current value (B = C): written when P ≠ C, never a
conflict. A client that sends no base at all gets exactly that (and a set is then replaced by P).
Values compare under their model type: strings exactly, language strings by value and tag, dates,
datetimes, numbers and booleans by value, relationships by the URIs of the records they point
at. A base refers to records by `id` (never by `lid`, it holds what was loaded); such an id only
has to be known, also when the record was deleted since (it is found through its versions).
An update that changes no key leaves no version; a request whose operations change nothing is
still recorded, with its steps, and approved like any other.

A **delete** may carry `meta.base` too: the record as its page loaded it, attributes and
relationships by name as for an update. A tombstone removes every attribute and relationship of
its type, and every link to the record, so it conflicts on a key where the master now holds a
value its base did not have: someone changed or set it after the page loaded the record, and the
delete would wipe that without anyone seeing it. A value cleared since is no conflict (the delete
does that anyway). A key its base does not carry starts from the current value, as for an update;
a delete without any base therefore conflicts with nothing when it is submitted. The tombstone
stores its base for every key and the records that linked to its master when it was submitted,
so a delete that waits for ABB is checked again before it is approved: a value set or a link made
in the meantime is a conflict then (see [Conflicts](#conflicts)). Creates carry no base.

A request with a conflict is not approved automatically (`holdOnConflict`): it is answered with
201, status `ingediend` and its conflicts, and waits for ABB.

#### Response

`201 Created`:

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
      "error": null,
      "lids": { "c1": "6f3a…" },
      "steps": [
        { "sequence": 1, "type": "indiening", "status": "ingediend", "at": "2026-11-03T10:12:00.000Z",
          "agent": "user", "person": "1e2f…", "organisation": "9a01…", "rule": "own-organisation",
          "reason": null, "error": null, "overrides-conflict": false, "overridden-conflicts": [] },
        { "sequence": 2, "type": "goedkeuring", "status": "goedgekeurd", "at": "2026-11-03T10:12:01.000Z",
          "agent": "service", "person": null, "organisation": null, "rule": "always",
          "reason": null, "error": null, "overrides-conflict": false, "overridden-conflicts": [] }
      ],
      "conflicts": [],
      "conflicts-token": null,
      "competing": [],
      "replaced-by": null
    },
    "relationships": {
      "target": { "data": { "type": "organizations", "id": "9a01…" } },
      "requesting-organisation": { "data": { "type": "organizations", "id": "9a01…" } }
    }
  }
}
```

- `lids` maps each create's local id to the uuid the service minted, so the frontend can reload
  the right records (POST only).
- `status` is the short key of the request's status, the status of its last step (`ingediend`,
  `goedgekeurd`, `afgekeurd`, `ingetrokken`, `mislukt`); `applied-at` the start of the last step
  with status `goedgekeurd`, or null; `error` the message of the error of the last step, or null.
- `steps`, ordered by `sequence`: `agent` is `user` for a step a person took (`person` and
  `organisation` are then the uuids of the session's person and organisation) and `service` for
  one the service took by itself; `rule` the policy rule that allowed or decided it; `reason` the
  comment of the step (required on an afkeuring); `error` why its apply failed (status `mislukt`);
  `overridden-conflicts` the conflicts an applying step (goedkeuring, hertoepassing) applied the
  request despite, as the approver saw them (without their competing requests), and
  `overrides-conflict` whether there were any. They are derived from the states the step replaced
  (see [What is written](#what-is-written)), not stored as such.
- `conflicts` and `conflicts-token` (the token that overrides exactly these conflicts in a
  goedkeuring, null without conflicts): see [Conflicts](#conflicts).
- `competing`: the keys the request writes that other pending requests propose something else
  for, `{ resource, key, proposed, "competing-requests": [uuid] }`, also when there is no
  conflict. A fresh form that sets a name while an older, stale request of another organisation
  waits for ABB is applied, and names that request here; ABB then sees the newer name as the
  conflict of the older request. An older request of the same organisation that the fresh form
  replaces entirely is withdrawn instead (see `superseded`).
- `superseded`, on the answer of an apply only (a POST that is applied, a goedkeuring, a
  hertoepassing): the uuids of the older pending requests the service withdrew because this one
  replaced them; `[]` when none.
- `replaced-by`: on a request the service withdrew that way, the uuid of the newer request
  (`dct:isReplacedBy`); null otherwise.

The same request from a form that loaded the name "Aalst" after ABB renamed the organisation to
"Aalst (ABB)":

```json
"attributes": {
  "status": "ingediend", "applied-at": null, "error": null, "…": "…",
  "steps": [ { "sequence": 1, "type": "indiening", "status": "ingediend", "…": "…" } ],
  "conflicts": [
    { "resource": { "type": "administrative-units", "id": "9a01…" }, "key": "name",
      "base": "Aalst", "current": "Aalst (ABB)", "proposed": "Stad Aalst",
      "master-exists": true, "competing-requests": [] }
  ],
  "conflicts-token": "5ac5a8f6…",
  "competing": []
}
```

| Status | When |
| --- | --- |
| 201 | the request is written; `status` says whether it was applied (`goedgekeurd`) or waits for ABB (`ingediend`, with its `conflicts`) |
| 400 | the JSON could not be parsed |
| 401 | no session, or the session has no account, no acting organisation or no person |
| 403 | the policy denies; `meta.rule` names the rule that denied (`null` when no rule allowed it) |
| 404 | the target organisation does not exist |
| 409 | the apply failed twice; the goedkeuring step is kept with status `mislukt` and its error, `meta["change-request"]` carries the request's id, and a hertoepassing applies it again |
| 413 | the body exceeds `MAX_BODY_SIZE` |
| 422 | an operation falls outside the aggregate, an attribute or relationship is unknown, a relationship target has the wrong type, an id or lid is unknown, an id does not belong to the target organisation, an organisation document is not an update of the target, a relationship outside the aggregate is changed, a value does not fit its datatype, a `meta.base` is malformed or on a create; `source.pointer` points at the operation |

### `GET /change-requests` and `GET /change-requests/:id`

`GET /change-requests?filter[target]=<organisation uuid>&filter[status]=ingediend&page[number]=0&page[size]=20`

The requests the acting organisation may see: those about it and those it submitted; ABB sees
all. Newest first, one page at a time: `page[number]` counts from 0, `page[size]` is 20 by
default and at most 100; `meta.count` is the number of requests over all pages and `links` has
`first`, `last` and, where they exist, `prev` and `next`. `filter[target]` narrows to the requests
about one organisation, `filter[status]` to one or more statuses (comma-separated), so an
approval screen asks for `ingediend` only. A filter on another organisation (or an unknown one)
returns an empty list, not an error; a malformed filter or page is a 400; a single request that is
not visible is a 404. The steps, versions and current values are read for the requests of the
page only, in batches that stay under the row limit of the triplestore (Virtuoso cuts a larger
result off without an error; a query that would still reach it is an error, never a partial
answer).

The documents have the same shape as above, without `lids`. A pending request (`ingediend`) shows
its conflicts, their token and its competing keys computed live, from the stored base and proposal
against the current values of the masters, so they change as others edit; any other request shows
none. The applying steps of a decided request show the conflicts they overrode, derived from the
states each step replaced.

### `POST /change-requests/:id/steps`

A step on an existing request: ABB approves or rejects a pending request, the requester withdraws
it, a failed request is applied again.

```json
{ "data": { "type": "change-request-steps",
            "attributes": { "step-type": "afkeuring", "reason": "Het KBO-nummer hoort bij een andere organisatie" } } }
```

| `step-type` | from status | to status | allowed by |
| --- | --- | --- | --- |
| `goedkeuring` | `ingediend` | `goedgekeurd`, or `mislukt` when the apply fails | `canDecide`: ABB |
| `afkeuring` | `ingediend`, `mislukt` | `afgekeurd` | `canDecide`: ABB; `reason` required |
| `intrekking` | `ingediend`, `mislukt` | `ingetrokken` | `canWithdraw`: ABB, the requesting organisation |
| `hertoepassing` | `mislukt` | `goedgekeurd`, or `mislukt` | `canEdit` on the target, as a POST |

`indiening` is only the first step of `POST /change-requests`. `wijziging` (an edit of a pending
request) is reserved and not implemented yet. `goedgekeurd`, `afgekeurd` and `ingetrokken` are
final. A request whose apply failed can be rejected or withdrawn as well as applied again, so a
request that can no longer be applied does not stay `mislukt` for good. The service itself also
takes an intrekking, on an older pending request that a newer applied request of the same
organisation replaces (step 11 of the flow); approving an older request never withdraws a newer
one.

- A goedkeuring applies the stored versions with the step in one update, as the POST does, and
  stamps the target with the person who submitted the request (the author of the change; the step
  records the approver). It checks the conflicts again first, live: when there are any it answers 409
  with them in `meta.conflicts` and their token in `meta["conflicts-token"]`, unless the body says
  `"override": "<that token>"`: the token GET shows for the request, or the one of the 409. The
  approver thus overrides exactly the conflicts they reviewed; a change that lands after the
  review gives other conflicts and another token, so the goedkeuring is refused again (409, with
  the new conflicts and token) instead of overwriting what nobody showed them. The states the step
  replaced keep what it overwrote; the step shows `"overrides-conflict": true` and the conflicts
  it overrode (`overridden-conflicts`, with the values it overwrote as `current`).
- A goedkeuring or a hertoepassing of a request that updates a record deleted since is refused
  with 409 (`meta["missing-records"]`), also with `override`: the apply would write values on a
  record without a type, which sparql-parser refuses, so it could never succeed. Such a request
  is rejected or withdrawn.
- The apply plans the stored versions against what the masters hold at that moment: a set merges
  the additions and removals of the request, as at submission.
- A hertoepassing applies what was approved before, without a new review; what it overwrites
  shows as its `overridden-conflicts`. It is refused with 409 when another request on the
  organisation that changed something was applied after this one failed: the stored versions
  would overwrite what it changed, so the change is submitted again instead. On a failed apply the frontend keeps the
  page's edits, blocks saving and offers this step ("Opnieuw toepassen"); when the step is refused
  it asks for a reload, after which the user enters the change again.
- `reason` is optional on the other steps and kept on the step.
- The step gets the next `sequence`.

Response `201 Created` with the request (its `steps` end with the new one).

| Status | When |
| --- | --- |
| 201 | the step is taken |
| 401 | no session, or the session has no account, no acting organisation or no person |
| 403 | the policy denies; `meta.rule` as for the POST |
| 404 | the request is not visible to the acting organisation |
| 409 | the status does not admit the step (`meta.status`, `meta["step-type"]`); a goedkeuring of a conflicting request without the token of its current conflicts as `override` (`meta.conflicts`, `meta["conflicts-token"]`); a goedkeuring or hertoepassing of a request that updates records deleted since (`meta["missing-records"]`); a hertoepassing after a later applied request; an apply that failed twice (the step is kept with status `mislukt`) |
| 422 | an unknown or reserved `step-type`, an afkeuring without `reason`, an `override` that is not a token (`true` is not one), a malformed body |

### `POST /change-requests/:id/apply`

A hertoepassing, as the first version of the service offered it: the same as
`POST /change-requests/:id/steps` with `"step-type": "hertoepassing"`, answered with `200` and the
request.

### `GET /change-requests/permissions?target=<organisation uuid>`

```json
{ "can-edit": true, "rules": ["own-organisation"] }
```

The same `canEdit` evaluation the POST runs, so the frontend and the server cannot disagree.
`rules` names the rule that decided (empty when no rule answered, which is a deny). 404 when the
organisation does not exist.

### Conflicts

```json
{ "resource": { "type": "contact-points", "id": "c0ff…" }, "key": "email",
  "base": "loket@aalst.be", "current": "info@aalst.be", "proposed": null,
  "master-exists": true, "competing-requests": ["5e97…"] }
```

A key of a record (`resource`, `key` the attribute or relationship name) where the request's
proposal disagrees with what the master holds now, and the master no longer holds what the request
started from. Values are rendered as JSON: a string, number, boolean or null, an array for a set,
`{ type, id }` identifiers for relationships. At submission the conflicts are those of the
[base rule](#base-values); for a pending request they are computed live on every read and before
every goedkeuring, from the base and the proposal its versions store:

- an update conflicts on a single-valued key someone changed to another value since its base; a
  set merges and does not conflict;
- a master that no longer exists (deleted since) is a conflict on every key the update writes,
  with `current` null and `"master-exists": false`, so it is not mistaken for an empty value; such
  a request cannot be applied (see the steps above);
- a delete conflicts on a value someone set on the record since its base (the example above: the
  page that removed the contact point showed another e-mail address), and on every link to the
  record made since it was submitted. Such a link is shown on the record that links: its
  relationship (`resource` the linking record, `key` its relationship) holds the deleted record
  now (`current`), not in `base` and `proposed`, which show only that link:

```json
{ "resource": { "type": "sites", "id": "8d2a…" }, "key": "contacts",
  "base": [], "current": [ { "type": "contact-points", "id": "c0ff…" } ], "proposed": [],
  "master-exists": true, "competing-requests": [] }
```

`competing-requests` are the other pending requests whose versions write the same key of the
same record and disagree with it: another value for a single-valued key, an addition of what the
other removes for a set (two additions merge and do not compete), anything but removal against a
delete. Deciding on one of them changes the conflicts of the others. The `competing` attribute of a
request lists them for every key it writes, conflicting or not.

`conflicts-token` is a hash of the conflicts as rendered (without their competing requests); a
goedkeuring passes it as `override` to approve despite exactly these conflicts.

### Errors

```json
{ "errors": [ { "status": "422", "title": "Unprocessable change request",
                "detail": "unknown attribute \"colour\" for type \"addresses\"",
                "source": { "pointer": "/data/attributes/operations/0/data/attributes/colour" } } ] }
```

## Simultaneous requests

Two people saving the same organisation at the same moment must not both read the same current
values: each would find no conflict and the second apply would overwrite the first without anyone
noticing. `POST /change-requests` and every step therefore take an in-process lock per target
organisation around reading the current values, the conflict check, the writes and the apply. The
second request waits for the first and reads what it applied; with base values a second form that
started from the same values then conflicts on a single-valued key and waits for ABB instead of
overwriting, and merges on a set (both new vestigingen are linked). Two steps on one request (ABB
approves while the requester withdraws) are serialised the same way, so the second sees the status
the first left and gets a 409.

Requests that do not run at the same moment but disagree are accounted for too: every key a
request writes is checked against the other pending requests (`competing`), an approval overrides
only the conflicts the approver saw (`conflicts-token`), and a pending delete is checked against
what was changed and linked after it was submitted.

The lock holds within one service instance. app-rvs runs one; running several instances behind the
dispatcher would need a lock they share (or updates conditional on the status they read).

## What is written

The vocabulary is `http://lblod.data.gift/vocabularies/change-requests/` (`cr:`), next to the
standard terms it reuses; `vocabulary/change-requests.ttl` defines its terms and their alignments
(⊑ `prov:Activity`, `prov:Entity`, `dct:subject`, `prov:wasDerivedFrom`, ...). A request the service
approved at once, with its two steps (`cr:Action`), its versions (`cr:ProposedVersion`), the states
they started from and the states the approval replaced (`cr:RecordState`):

```turtle
@prefix cr: <http://lblod.data.gift/vocabularies/change-requests/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .

<http://data.lblod.info/id/change-requests/f6c30f3b-af3e-4f7f-8ec3-11ec48093b5f> a cr:ChangeRequest ;
  mu:uuid "f6c30f3b-af3e-4f7f-8ec3-11ec48093b5f" ;
  dct:created "2026-11-03T10:12:00Z"^^xsd:dateTime ;
  adms:status <http://lblod.data.gift/concepts/ca080d1f-f71c-4fe6-a4ed-a13fe1112989> ;   # goedgekeurd: the status of the last step
  cr:aggregate "organization-core-data" ;
  cr:target <http://data.lblod.info/id/bestuurseenheden/9a01f3e2-4c7b-4d2a-9f1e-0a1b2c3d4e5f> ;
  pav:createdBy <http://data.lblod.info/id/bestuurseenheden/9a01f3e2-4c7b-4d2a-9f1e-0a1b2c3d4e5f> ;   # the requesting organisation
  dct:creator <http://data.lblod.info/id/persoon/1e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b> .               # the person who submitted it

<http://data.lblod.info/id/change-request-actions/ad2a0163-101e-40cb-b4c7-f2df4b3e3fb9> a cr:Action ;
  mu:uuid "ad2a0163-101e-40cb-b4c7-f2df4b3e3fb9" ;
  dct:isPartOf <http://data.lblod.info/id/change-requests/f6c30f3b-af3e-4f7f-8ec3-11ec48093b5f> ;
  dct:type <http://lblod.data.gift/concepts/9ea4e33a-1745-4159-9a24-5706bad7ab38> ;      # indiening
  adms:status <http://lblod.data.gift/concepts/d57aff85-43ce-4bd0-b962-6bd1b1fbc4b6> ;   # ingediend: the status after this step
  schema:position 1 ;
  prov:startedAtTime "2026-11-03T10:12:00Z"^^xsd:dateTime ;
  prov:wasAssociatedWith <http://data.lblod.info/id/persoon/1e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b> ;
  cr:actingOrganisation <http://data.lblod.info/id/bestuurseenheden/9a01f3e2-4c7b-4d2a-9f1e-0a1b2c3d4e5f> ;
  cr:rule "own-organisation" ;                                                          # the canEdit rule that allowed it
  prov:generated <http://data.lblod.info/id/proposed-versions/a1429927-7641-4916-982d-73f09fdc3304>,
                 <http://data.lblod.info/id/proposed-versions/2df12eb4-7abf-4cc4-803c-d6a5cb133f04>,
                 <http://data.lblod.info/id/proposed-versions/f464c0c1-9f1a-4720-8f08-08b6c8fc89ee> .

<http://data.lblod.info/id/change-request-actions/36166629-4a16-4dcf-9eeb-1054baa34ee0> a cr:Action ;
  mu:uuid "36166629-4a16-4dcf-9eeb-1054baa34ee0" ;
  dct:isPartOf <http://data.lblod.info/id/change-requests/f6c30f3b-af3e-4f7f-8ec3-11ec48093b5f> ;
  dct:type <http://lblod.data.gift/concepts/bb2bb632-fc9f-41c6-a1eb-8f50e4008551> ;      # goedkeuring
  adms:status <http://lblod.data.gift/concepts/ca080d1f-f71c-4fe6-a4ed-a13fe1112989> ;   # goedgekeurd
  schema:position 2 ;
  prov:startedAtTime "2026-11-03T10:12:01Z"^^xsd:dateTime ;
  prov:wasAssociatedWith <http://lblod.data.gift/services/change-request-service> ;    # taken by the service
  cr:rule "always" ;                                                                    # the autoApprove rule
  prov:invalidated <http://data.lblod.info/id/record-states/4d4d58ca-b401-45e2-b124-f14e75824f01>,   # the states it replaced
                   <http://data.lblod.info/id/record-states/a25dd05e-c96b-41e1-ae8e-ff4b86d3983b> .

<http://data.lblod.info/id/proposed-versions/a1429927-7641-4916-982d-73f09fdc3304> a cr:ProposedVersion ;
  mu:uuid "a1429927-7641-4916-982d-73f09fdc3304" ;
  dct:isVersionOf <http://data.lblod.info/id/bestuurseenheden/9a01f3e2-4c7b-4d2a-9f1e-0a1b2c3d4e5f> ;
  cr:masterUuid "9a01f3e2-4c7b-4d2a-9f1e-0a1b2c3d4e5f" ;
  prov:generatedAtTime "2026-11-03T10:12:00Z"^^xsd:dateTime ;
  cr:resourceType "administrative-units" ;
  cr:operation as:Update ;
  cr:changesProperty skos:prefLabel, regorg:legalName ;       # the keys it changes
  cr:base <http://data.lblod.info/id/record-states/94bcda5d-416b-4535-b645-a1b031e1c8a7> ;
  skos:prefLabel "Stad Aalst" ;
  regorg:legalName "Stad Aalst" .

<http://data.lblod.info/id/record-states/94bcda5d-416b-4535-b645-a1b031e1c8a7> a cr:RecordState ;   # what the form started from
  mu:uuid "94bcda5d-416b-4535-b645-a1b031e1c8a7" ;
  dct:isVersionOf <http://data.lblod.info/id/bestuurseenheden/9a01f3e2-4c7b-4d2a-9f1e-0a1b2c3d4e5f> ;
  skos:prefLabel "Aalst" .                                    # no triple: the legal name was empty

<http://data.lblod.info/id/record-states/4d4d58ca-b401-45e2-b124-f14e75824f01> a cr:RecordState ;   # what the organisation held when it was applied
  mu:uuid "4d4d58ca-b401-45e2-b124-f14e75824f01" ;
  dct:isVersionOf <http://data.lblod.info/id/bestuurseenheden/9a01f3e2-4c7b-4d2a-9f1e-0a1b2c3d4e5f> ;
  skos:prefLabel "Aalst" .

<http://data.lblod.info/id/proposed-versions/2df12eb4-7abf-4cc4-803c-d6a5cb133f04> a cr:ProposedVersion ;   # a create: no cr:changesProperty, no base, nothing replaced
  mu:uuid "2df12eb4-7abf-4cc4-803c-d6a5cb133f04" ;
  dct:isVersionOf <http://data.lblod.info/id/contact-punten/c08c78e6-26b1-4b57-8604-28f90abc422d> ;
  cr:masterUuid "c08c78e6-26b1-4b57-8604-28f90abc422d" ;
  cr:resourceType "contact-points" ;
  cr:operation as:Create ;
  schema:email "info@aalst.be" ; … .

<http://data.lblod.info/id/proposed-versions/f464c0c1-9f1a-4720-8f08-08b6c8fc89ee> a cr:ProposedVersion ;   # a tombstone
  mu:uuid "f464c0c1-9f1a-4720-8f08-08b6c8fc89ee" ;
  dct:isVersionOf <http://data.lblod.info/id/contact-punten/c0ffee12-3456-4789-8abc-def012345678> ;
  cr:resourceType "contact-points" ;
  cr:operation as:Delete ;
  cr:changesProperty schema:email, schema:telephone, schema:contactType, locn:address, … ;     # every key of its type
  cr:base <http://data.lblod.info/id/record-states/3e22ab22-00ed-43a7-b74d-738cf75194a3> ; … .

<http://data.lblod.info/id/record-states/3e22ab22-00ed-43a7-b74d-738cf75194a3> a cr:RecordState ;   # the record as the delete started from it
  mu:uuid "3e22ab22-00ed-43a7-b74d-738cf75194a3" ;
  dct:isVersionOf <http://data.lblod.info/id/contact-punten/c0ffee12-3456-4789-8abc-def012345678> ;
  schema:email "loket@aalst.be" ;
  schema:contactType "Primary" ;
  cr:incomingLink <http://data.lblod.info/id/record-links/c907432b-539d-4b25-9f90-a7f8ab109263> .

<http://data.lblod.info/id/record-links/c907432b-539d-4b25-9f90-a7f8ab109263> a rdf:Statement ;   # the site linked it
  mu:uuid "c907432b-539d-4b25-9f90-a7f8ab109263" ;
  rdf:subject <http://data.lblod.info/id/vestigingen/77c2a4b6-1d3e-4f5a-8b9c-0d1e2f3a4b5c> ;
  rdf:predicate org:siteAddress ;
  rdf:object <http://data.lblod.info/id/contact-punten/c0ffee12-3456-4789-8abc-def012345678> .
```

The state the approval replaced for the tombstone (`a25d…`) has the shape of its base state, as the
contact point and its links were when it was deleted. A goedkeuring by ABB whose apply failed, and
an older request a newer one replaced:

```turtle
<http://data.lblod.info/id/change-request-actions/3e4825fa-0dcf-4a46-9e95-66edf24d4eb0> a cr:Action ;
  dct:type <http://lblod.data.gift/concepts/bb2bb632-fc9f-41c6-a1eb-8f50e4008551> ;      # goedkeuring
  adms:status <http://lblod.data.gift/concepts/b610e2dc-902c-4874-b65e-78b7f6411c05> ;   # mislukt
  prov:wasAssociatedWith <http://data.lblod.info/id/persoon/3a4b5c6d-7e8f-4a9b-8c1d-2e3f4a5b6c7d> ;   # ABB's person
  cr:actingOrganisation <http://data.lblod.info/id/bestuurseenheden/141d9d6b-54af-4d17-b313-8d1c30bc3f5b> ;
  cr:rule "abb-decides-all" ;
  task:error <http://redpencil.data.gift/id/jobs/error/0e85ca4a-4b6b-4954-8ba3-8b0bd7fe5cc0> ; … .

<http://redpencil.data.gift/id/jobs/error/0e85ca4a-4b6b-4954-8ba3-8b0bd7fe5cc0> a oslc:Error ;
  mu:uuid "0e85ca4a-4b6b-4954-8ba3-8b0bd7fe5cc0" ;
  oslc:message "…" ;
  dct:created "2026-11-04T09:00:01Z"^^xsd:dateTime ;
  dct:creator <http://lblod.data.gift/services/change-request-service> ;
  dct:references <http://data.lblod.info/id/change-requests/…> .

<http://data.lblod.info/id/change-requests/5e97…> dct:isReplacedBy <http://data.lblod.info/id/change-requests/f6c3…> .
```

Relationships in a version point at master URIs, never at other versions. `cr:resourceType` is
the JSON:API type of the entity, `cr:operation` what is done to it (`as:Create`, `as:Update`,
`as:Delete`: the markers LDES uses, as values, so a version does not become an activity),
`cr:changesProperty` the keys the apply changes on the master: a single-valued key loses its values
before the version's triples are inserted, a set key loses what the base had and the version drops
and gains what the version adds, so it merges with what others changed; a tombstone removes the
master's triples and the links to it. A stored version can thus be applied again from the model and
the graph alone. A record state holds, with the master's own predicates, the values of the keys a
version changes at one moment (no triple for a key that was empty) and, for a deleted record, the
links that pointed at it, one `rdf:Statement` each. The base state (`cr:base`) is what the form
started from; the live conflict check compares it with the master. The state an applying step
replaced (`prov:invalidated`) is what the master held when it applied: with the version it gives
the old and the new value of every key, and the conflicts the step overrode (those where it differs
from the base) are derived from it rather than stored. The steps are the only record of who did
what and when; the request's `adms:status` repeats the status of its last step and is written in
the same update that adds the step.

Requests, steps, versions, record states, links and errors live in the change-requests graph; the
masters live in the application graph. A tombstone removes links to its master from the
application data only: the versions and record states that name the record keep it, so the history
stays whole. The change-requests graph is not exported (no delta, no LDES): a version is a
proposal, partial and possibly rejected, not the state of a record; a feed of the records'
history would be made from the application graph.

The concepts of the two code lists (statuses and step types, `skos:Concept`s with `mu:uuid`) are
published by app-rvs's migrations; the service knows their URIs (`constants.js`).

## Configuration

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEFAULT_MU_AUTH_SCOPE` | `http://services.lblod.info/change-request-service` (set in the Dockerfile) | the scope the template sends on every query; sparql-parser grants the writes to it |
| `MAX_BODY_SIZE` | `5mb` (set in the Dockerfile; the template's own default is `100kb`) | the body limit of the template's JSON:API parser, which runs before the routes; above it the answer is 413. A stack that runs the template image with the sources mounted (development mode) must set it itself |
| `MODEL_DIR` | `/config/resources` | the mu-cl-resources JSON model files; every `*.json` in it is read |
| `CONFIG_FILE` | `/config/change-requests.json` | the aggregates and policy configuration (below) |
| `APPLICATION_GRAPH` | `MU_APPLICATION_GRAPH` or `http://mu.semte.ch/application` | the graph of the masters |
| `CHANGE_REQUESTS_GRAPH` | `http://mu.semte.ch/graphs/change-requests` | the graph of the requests, their steps, versions, record states, links and errors |
| `MU_SPARQL_ENDPOINT` | `http://database:8890/sparql` | the template's database endpoint |
| `SPARQL_MAX_ROWS` | `10000` | the most rows the triplestore returns for one SELECT (Virtuoso's `ResultSetMaxRows`, 10000 in app-rvs); the service queries in batches that stay under it and refuses a result that reaches it |
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
  "statusScheme": "http://lblod.data.gift/concept-schemes/e8274055-0834-4511-8b84-a2af41055633"
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
  ("cr:ChangeRequest" -> _) ("cr:Action" -> _) ("cr:ProposedVersion" -> _) ("cr:RecordState" -> _)
  ("rdf:Statement" -> _) ("oslc:Error" -> _))

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
  `session:account` and `ext:sessionGroup` (`http://mu.semte.ch/graphs/sessions`), and on the
  graph of the persons (`foaf:account`; the public graph in app-rvs with mock-login).
- **Placement follows the type specs, not the GRAPH clause.** The service names the graphs in its
  updates (that makes it correct on a bare triplestore too), but sparql-parser dispatches every
  quad to *every* writable graph whose `define-graph` matches the type of its subject, and refuses
  the update when a quad matches none. So `cr:ChangeRequest`, `cr:Action`, `cr:ProposedVersion`,
  `cr:RecordState`, `rdf:Statement` and `oslc:Error` must be in the change-requests spec (a class
  that is missing makes every POST fail), every class the service writes to (`org:Site`, `locn:Address`, ...) in a
  writable spec of the data graph, and that writable spec must not be `(_ -> _)`: such a spec
  matches the service's own records too, and they would be written to the data graph as well,
  readable by everyone. Hence the second, typed spec on the same graph for the write grant.
- **No other write grant on the data graph**, so a direct POST, PATCH or DELETE from the frontend
  to a resource route has no writable graph and is refused (mu-cl-resources answers 500).

sparql-parser 0.0.15 passes the service's property-path query (the records reachable from the
target), its `VALUES (?s ?p)` queries (the current values, the competing requests), the UNIONs
and nested OPTIONALs of its step and version queries, `FILTER NOT EXISTS`, `COUNT` and
`LIMIT`/`OFFSET` through to Virtuoso unchanged. It does not narrow a pattern to the graph a
`GRAPH` clause names: the scope reads the change-requests graph too, where versions and record
states hold the same predicates as the masters. The queries and the apply that look for the links
to a record (a tombstone) therefore leave out subjects of type `cr:ProposedVersion` and
`cr:RecordState`; without that, deleting a record also stripped the stored versions that named it.
A link a record state remembers is an `rdf:Statement`, which does not hold the linking predicate
itself.

## Policies

`policies/rules.js` holds one function per rule, `async (ctx) => "allow" | "deny" | undefined`,
with `ctx = { session, account, actor: { uri, uuid, classification }, target: { uri, uuid,
classification }, aggregate, operations, config }`, plus `conflicts` and `competing` (as the API
renders them) for `autoApprove`, and `request: { uri, uuid, status, aggregate,
requestingOrganisation }` for the steps on an existing request. The `supersede` rules get
`{ applied: { uri, uuid, requestingOrganisation, target }, candidate: { uri, uuid,
requestingOrganisation, fullyCovered }, config }`, where `fullyCovered` says that the applied
request wrote every key the older candidate proposes and that the candidate only updates
single-valued keys. `policies/index.js` orders them:

```js
export const canEdit = [abbEditsAll, ownOrganisation];              // submit, and hertoepassing
export const autoApprove = [holdOnConflict, always];                // applied at once, or waits
export const canDecide = [abbDecidesAll];                           // goedkeuring, afkeuring
export const canWithdraw = [abbEditsAll, requestingOrganisation];   // intrekking
export const supersede = [supersededByOwnRequest];                   // older pending requests an apply withdraws
```

The first rule that answers decides; no answer means deny. The permissions endpoint, the POST and
the steps run the same lists, and the rule that allowed or decided a step is recorded on it
(`cr:rule`). A rule is reported under its kebab-case name (`own-organisation`, `abb-edits-all`,
`hold-on-conflict`). Later rules slot in without touching the flow: `memberOfTargetPartnership`,
`targetTypeIn([...])`, `aggregateIn([...])`; "auto-approve when actor equals target, otherwise
ingediend" is a one-line change in `autoApprove`, and so is holding a request that another pending
request competes with (`ctx.competing.length ? 'deny' : undefined`). The service does not hold
those by default: a competing request is pending because it was stale, and the newer form is the
one that saw the current values. Instead, `supersededByOwnRequest` withdraws the older request when
it comes from the same organisation and the newer one rewrote all of its keys; widening it (for
example to requests of other organisations, or to partly covered requests) is a change of that
rule only.

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
rename through a change request and its steps (indiening by the person and organisation,
goedkeuring by the service), a refused cross-organisation request, refused direct and forged-scope
writes, the listings and their pages, a stale form after ABB renamed the organisation (a conflict
that waits, a competing second request, the same form changing another attribute without
reverting the name), ABB's approval refused on conflicts and on a token of other conflicts, a
rejection with a reason, a withdrawal, a newer request replacing an older one (`dct:isReplacedBy`),
ABB's approval over a conflict and the overridden conflict read back from the state it replaced,
the 403s, 404s, 409s and 422s of the steps, a new
vestiging, a second one from a page that did not show the first (the sites merge), a delete from a
page that showed another e-mail address (a conflict that waits, with the links of the record kept
as statements on its base state), the graphs the records land in and their vocabulary, the history
keeping its links to deleted records, and puts the data back (closing any request it left pending), so it can run again. It needs `curl` and `python3`;
`BASE_URL` (default `http://localhost:88`, app-rvs's identifier in docker-compose.dev.yml) and
`SPARQL_ENDPOINT` (default `http://localhost:8899/sparql`, its Virtuoso) can be overridden, as can
the organisations by label (`ORG_A_LABEL`, `ORG_B_LABEL`).

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

- The `wijziging` step (an edit of a pending request by its requester) is reserved, not
  implemented; it waits for the business to confirm it.
- Versions are not exposed over the API yet (the history is read from the graph); an approval
  screen renders pending versions from the change-requests graph, or from the conflicts.
- The lock that serialises requests per organisation is in-process: one service instance.
- The pages do not send `meta.base` on a delete yet, so a delete is checked against what changed
  since it was submitted (when it waits for ABB), not yet against what changed since its page was
  loaded. The frontend can send the record as it loaded it, as it does for an update.
- No screen uses the approval flow yet: an ABB screen lists `filter[status]=ingediend`, shows the
  conflicts and the `competing` keys, and approves with the `conflicts-token` it showed.
- A set merges what a request added and removed into what the master holds when it is applied. An
  item someone removed and linked again after the request was submitted is removed again by it;
  the service cannot tell that apart from an item nobody touched.
- The `lid` convention and the session contract (`session:account`, `ext:sessionGroup`,
  `foaf:account`) are the Loket shape, to be aligned with mock-login and the frontend.
- The errors of failed applies live in the change-requests graph, which has no deltas; an error
  alert service (loket-error-alert-service) would need them in a graph that has.
- The vocabulary (`vocabulary/change-requests.ttl`) and the two code lists are to be proposed to
  lblod/vocabularies and lblod/codelists.
- A create does not have to be linked from the request: a record created without a link is
  outside every aggregate from then on. The pages always link what they create.
