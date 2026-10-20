# API

All calls need a logged-in session (`mu-session-id`, as mu-identifier sets it): no session, or a
session without account, acting organisation or person, is a 401. Bodies and answers are JSON:API
(`application/vnd.api+json`; the POSTs also accept `application/json`). Bodies up to
`MAX_BODY_SIZE` (5 MB in the image) are accepted; above that the answer is 413.

- [What happens on a POST](#what-happens-on-a-post)
- [`POST /change-requests`](#post-change-requests): [an edit](#an-edit), [a new organisation](#a-new-organisation), [a veranderingsgebeurtenis](#a-veranderingsgebeurtenis), [the rules](#the-rules), [base values](#base-values), [the answer](#the-answer)
- [`GET /change-requests` and `GET /change-requests/:id`](#get-change-requests-and-get-change-requestsid)
- [`POST /change-requests/:id/steps`](#post-change-requestsidsteps)
- [`GET /change-requests/permissions`](#get-change-requestspermissionstargetuuid)
- [Conflicts](#conflicts), [errors](#errors)

## What happens on a POST

1. **Session.** `<session> session:account ?account` and `ext:sessionGroup ?organisation` (the
   Loket shape mock-login writes), and the person of the account (`?person foaf:account ?account`).
2. **Aggregate and kind.** The aggregate names the configured whitelist and its kind: an `edit`
   (the records of an organisation that exists), a `creation` (a new organisation) or a
   `change-event` (a veranderingsgebeurtenis about an organisation that exists). An edit and a
   change event name their target; a creation has none: its organisation is minted here, from the
   one organisation document the operations create, with the `new-resource-base` of its type.
3. **Policy.** The `canEdit` rules for an edit or a change event, `canCreate` for a creation (the
   classification the document proposes must be one the acting organisation manages); denied is a
   403 with the rule.
4. **KBO number.** A creation that proposes a KBO number the register holds, or that a pending
   creation proposes already, is a 409.
5. **Lock.** Steps 6 to 13 run for one request at a time per target organisation.
6. **Look up records.** The records the operations and their bases name, and the target's
   aggregate: everything reachable from the target over the relationships between the aggregate's
   types (`org:hasSite`, `org:hasPrimarySite`, `org:siteAddress`, `locn:address`, `adms:identifier`,
   `generiek:gestructureerdeIdentificator`, `schema:contactPoint` for the kerngegevens;
   `org:originalOrganization`, `code:veranderingsgebeurtenisResultaat`, `m8g:hasFormalFramework`
   for a change event). A base may name a record deleted since; it is found through its versions.
7. **Build versions.** One per operation: an update takes the record from its id, a create mints a
   uuid and a URI from the type's `new-resource-base` (the organisation of a creation keeps the one
   minted in step 2), a delete gives a tombstone that removes every field of its type. Anything
   that does not fit is a 422 (see the rules below).
8. **Settle.** Read the current value of every field the updates and tombstones carry, and the
   links to the records they delete; apply the [base rule](#base-values). An update that changes
   nothing leaves no version.
9. **Competing requests.** Other pending requests that write the same field of the same record with
   another value.
10. **An edit with a conflict stops here**: 409 with the conflicts, nothing is written. The user
    reloads the form and saves again. A creation or change event with a conflict goes on and shows
    it to ABB.
11. **Write** the request, its indiening step (with the `reason` of the body, when given) and the
    versions with their base states, in one `INSERT DATA`, status `ingediend`.
12. **Decide.** The `autoApprove` rules: `editsApplyAtOnce` approves an edit, `abbAutoApproves` a
    creation or change event ABB requests itself. Anything else waits: 201 with status
    `ingediend`, its conflicts and their token.
13. **Apply**, one SPARQL update: per version delete the values of the single-valued fields it
    changes and the list values it removes, insert its triples on the record; a create also writes
    the class tree and the uuid; a tombstone deletes the record's triples and the links to it. The
    same update stamps `dct:modified` and `ext:lastModifiedBy` (the person) on the target, adds
    the service's goedkeuring step (status `goedgekeurd`, the rule that approved) and its
    afhandeling step (status `afgehandeld`, with the states it replaced) and sets the request to
    `afgehandeld`. The update is idempotent but not one transaction (sparql-parser sends the
    effective quads in several requests, deletes first), so a failure is retried once; a second
    failure records the afhandeling as `mislukt` with an `oslc:Error` and answers 409.
14. **Replace older requests.** The `supersede` rules: a pending request of the same organisation
    about the same target, older, whose every version updates only single-valued fields this
    request wrote, is withdrawn by the service (rule `superseded-by-own-request`, reason
    "Vervangen door wijzigingsaanvraag <uuid>", `dct:isReplacedBy`). A failure here is logged and
    does not undo the apply.
15. **Answer** 201 with the request, its conflicts, its competing keys and the uuids it replaced.

## `POST /change-requests`

### An edit

The kerngegevens page of a gemeente as one request: its address, a new contact point, its primary
site, its KBO number and the organisation itself. Each update carries in `meta.base` the values its
form loaded.

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

In this example the structured identifier changes nothing and leaves no version; the address
writes its number, full address and register link; the site its contacts and site type; the
organisation its name and legal name. An edit is applied at once: 201 with status `afgehandeld`.

### A new organisation

A gemeente registers the autonoom gemeentebedrijf it founded: the aggregate `new-organisation`,
no target, and the organisation itself as a create with a `lid`. It carries its classification,
its KBO number (an identifier named `KBO nummer` with a structured identifier), its site and the
oprichting as a change event with the link to the besluit. `reason` is the submitter's text; it
is kept on the indiening step and shown to the requesting organisation and ABB.

```json
{
  "data": {
    "type": "change-requests",
    "attributes": {
      "aggregate": "new-organisation",
      "reason": "Opgericht bij besluit van de gemeenteraad van 1 oktober 2026",
      "operations": [
        { "op": "create", "data": { "type": "administrative-units", "lid": "o1",
            "attributes": { "name": "AGB Aalst", "legal-name": "Autonoom gemeentebedrijf Aalst" },
            "relationships": { "classification": { "data": { "type": "administrative-unit-classification-codes", "id": "36a8…" } },
                               "identifiers": { "data": [ { "type": "identifiers", "lid": "i1" } ] },
                               "primary-site": { "data": { "type": "sites", "lid": "v1" } },
                               "sites": { "data": [ { "type": "sites", "lid": "v1" } ] } } } },
        { "op": "create", "data": { "type": "identifiers", "lid": "i1", "attributes": { "id-name": "KBO nummer" },
            "relationships": { "structured-identifier": { "data": { "type": "structured-identifiers", "lid": "s1" } } } } },
        { "op": "create", "data": { "type": "structured-identifiers", "lid": "s1", "attributes": { "local-id": "0123456789" } } },
        { "op": "create", "data": { "type": "sites", "lid": "v1", "relationships": { "address": { "data": { "type": "addresses", "lid": "a1" } } } } },
        { "op": "create", "data": { "type": "addresses", "lid": "a1",
            "attributes": { "street": "Grote Markt", "number": "1", "postcode": "9300", "municipality": "Aalst", "country": "België", "full-address": "Grote Markt 1, 9300 Aalst, België" } } },
        { "op": "create", "data": { "type": "change-events", "lid": "e1",
            "attributes": { "date": "2026-10-01", "description": "Oprichting" },
            "relationships": { "type": { "data": { "type": "change-event-types", "id": "f0e2…" } },
                               "original-organizations": { "data": [ { "type": "administrative-units", "lid": "o1" } ] },
                               "decision": { "data": { "type": "decisions", "lid": "d1" } } } } },
        { "op": "create", "data": { "type": "decisions", "lid": "d1", "attributes": { "document-links": ["https://aalst.be/besluiten/2026/123"] } } }
      ]
    }
  }
}
```

The organisation gets its uuid and URI at submission; the answer's `target` is that uuid, with
`meta.pending` as long as the request waits (the organisation then exists in the request only: the
resource routes do not find it). Status `ingediend`: the request waits for ABB, unless ABB
submitted it. On approval the organisation lands in the application graph with everything the
request carries.

### A veranderingsgebeurtenis

An organisation registers a change about itself as one request: the change event with its
besluit, and the fields of the organisation the event changes (a naamswijziging writes the name;
an ontbinding the status; a wijziging juridische vorm the legal form, ...). The target is the
organisation.

```json
{
  "data": {
    "type": "change-requests",
    "attributes": {
      "aggregate": "change-event",
      "operations": [
        { "op": "create", "data": { "type": "change-events", "lid": "e1",
            "attributes": { "date": "2026-10-01", "description": "Naamswijziging" },
            "relationships": { "type": { "data": { "type": "change-event-types", "id": "6651…" } },
                               "original-organizations": { "data": [ { "type": "administrative-units", "id": "9a01…" } ] },
                               "decision": { "data": { "type": "decisions", "lid": "d1" } } } } },
        { "op": "create", "data": { "type": "decisions", "lid": "d1", "attributes": { "document-links": ["https://aalst.be/besluiten/2026/124"] } } },
        { "op": "update", "data": { "type": "administrative-units", "id": "9a01…",
            "attributes": { "name": "Stad Aalst" }, "meta": { "base": { "attributes": { "name": "Aalst" } } } } }
      ]
    },
    "relationships": { "target": { "data": { "type": "organizations", "id": "9a01…" } } }
  }
}
```

Status `ingediend`: nothing is applied until ABB approves, and the organisation keeps its current
values meanwhile. A change someone makes to the same field in the meantime shows as a conflict on
the request, which ABB overrides knowingly or not at all (see the steps).

### The rules

- `aggregate` names an aggregate of the configuration. It whitelists the types the operations may
  touch (the configured types and their subtypes: a gemeente is an `administrative-units` document
  under the `organizations` root) and the code lists a document may link to (`references`).
- `target` is the organisation the request is about (`organizations` or a subtype). The acting
  organisation comes from the session, never from the body. A creation has no target; an edit and
  a change event need one.
- `op` is `create`, `update` or `delete`. A create carries a `lid` (local id) instead of an `id`;
  other operations refer to it with `{ "type": "contact-points", "lid": "c1" }`, before or after it.
- **Every id must belong to the target.** The id of an update or delete, and every id a
  relationship inside the aggregate points at, must be reachable from the target organisation over
  the aggregate's relationships. Anything else is a 422, for ABB too. A record that is no longer
  linked to the organisation is no longer part of its aggregate, so unlink and delete in the same
  request, as the pages do. References only have to exist.
- **An organisation is only ever updated, and only the target itself.** Creating or deleting an
  organisation, or updating another one, is a 422. The exception is a creation, which creates
  exactly one organisation (and updates none): the document must be a create with a `lid` of an
  organisation type with a `new-resource-base`, and its `classification` decides who may request
  it.
- **The KBO number of a creation is unique.** An identifier named `KBO nummer` whose structured
  identifier's `local-id` the register holds, or that another pending creation proposes, is a 409.
- **Per-field semantics**, as a mu-cl-resources PATCH: a version changes exactly the attributes and
  relationships it carries; an absent field is left alone; `null` or `[]` clears it. A list that is
  carried holds the whole list; with a base only the user's additions and removals are applied.
- **A relationship outside the aggregate** (`classification`, `organization-status`, ...) may be
  carried, as the frontend's serializer does, but not changed: it must equal its base or the
  current value, else 422. Inverse relationships (`memberships`, ...) are ignored.
- Attribute values follow the model's type (see [the datatype table](development.md#datatypes));
  `null` means no value.
- `reason` is optional, a string: the submitter's explanation, kept on the indiening step.

### Base values

The pages send every attribute of a record, not only the changed ones, so a form loaded before
someone else saved would put old values back. An update therefore carries in `meta.base` the
values its form started from, for the fields it carries: `attributes` by name, `relationships` by
name as `{ "data": identifier | [identifiers] | null }`.

For every single-valued field (an attribute that is not a set, a to-one relationship), with base
**B**, proposal **P** and current value **C** (read under the lock):

| Case | Written | Conflict |
| --- | --- | --- |
| P = B: the user did not change it | no, so a change made since stays | no |
| P ≠ B and C = B | yes | no |
| P ≠ B and C = P: the same change was made already | no | no |
| P ≠ B and C is neither B nor P: someone else changed it | yes, the proposal is kept in the version | yes |

- **Lists merge.** A to-many relationship, a `string-set`, `uri-set` or `language-string-set`
  adds what P has and B had not, and removes what B had and P has not; what others changed stays.
  Two changes from the same base cannot disagree on an item, so a list never conflicts. The version
  keeps P and B, so a request approved later merges the same way into what the record holds then.
- **No base** for a field means B = C: written when P ≠ C, never a conflict. A client that sends no
  base at all gets exactly that, and a list is then replaced by P.
- Values compare under their type: strings exactly, language strings by value and tag, dates,
  datetimes, numbers and booleans by value, relationships by the URIs they point at. A base refers
  to records by `id` (never `lid`); the id only has to be known, also for a record deleted since.
- **A delete** may carry `meta.base` too: the record as its page loaded it. A tombstone removes
  every field of its type and every link to the record, so it conflicts on a field the record now
  holds a value for that its base did not have. A field cleared since is no conflict. The tombstone
  stores its base and the records that linked to it, so a delete that waits for ABB is checked
  again before approval: a value set or a link made in the meantime is a conflict then.
- **An edit with a conflict is refused**: 409 with the conflicts in `meta.conflicts`, their token
  and the competing keys; nothing is written. The form reloads and the user saves again from the
  current values. A creation or change event with a conflict is written and waits for ABB, who sees
  the conflict.

### The answer

`201 Created`, for the edit above:

```json
{
  "data": {
    "type": "change-requests",
    "id": "e0b1…",
    "attributes": {
      "status": "afgehandeld",
      "kind": "edit",
      "created": "2026-11-03T10:12:00.000Z",
      "applied-at": "2026-11-03T10:12:01.000Z",
      "aggregate": "organization-core-data",
      "mine": true,
      "target-name": "Stad Aalst",
      "target-classification": "5ab0…",
      "error": null,
      "lids": { "c1": "6f3a…" },
      "steps": [
        { "sequence": 1, "type": "indiening", "status": "ingediend", "at": "2026-11-03T10:12:00.000Z",
          "agent": "user", "person": "1e2f…", "organisation": "9a01…", "rule": "own-organisation",
          "reason": null, "error": null, "overrides-conflict": false, "overridden-conflicts": [] },
        { "sequence": 2, "type": "goedkeuring", "status": "goedgekeurd", "at": "2026-11-03T10:12:01.000Z",
          "agent": "service", "person": null, "organisation": null, "rule": "edits-apply-at-once",
          "reason": null, "error": null, "overrides-conflict": false, "overridden-conflicts": [] },
        { "sequence": 3, "type": "afhandeling", "status": "afgehandeld", "at": "2026-11-03T10:12:01.000Z",
          "agent": "service", "person": null, "organisation": null, "rule": null,
          "reason": null, "error": null, "overrides-conflict": false, "overridden-conflicts": [] }
      ],
      "conflicts": [],
      "conflicts-token": null,
      "competing": [],
      "replaced-by": null,
      "superseded": []
    },
    "relationships": {
      "target": { "data": { "type": "organizations", "id": "9a01…" } },
      "requesting-organisation": { "data": { "type": "organizations", "id": "9a01…" } }
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `status` | the status of the last step: `ingediend` (waits for ABB), `informatie-gevraagd` (ABB asked the requester for information), `goedgekeurd` (approved, being applied), `afgehandeld` (applied), `afgekeurd` (rejected, can be contested), `ingetrokken`, `mislukt` (the apply failed) |
| `kind` | `edit`, `creation` or `change-event`, from the aggregate |
| `mine` | whether the person of the session submitted it |
| `target-name`, `target-classification` | the name and the classification (uuid) of the organisation, for the listing; for a creation that waits, what the request proposes |
| `applied-at` | the start of the last step with status `afgehandeld`, or null |
| `error` | the error message of the last step, or null |
| `lids` | each create's local id → the uuid the service minted (POST only), so the frontend reloads the right records |
| `steps` | ordered by `sequence`. `agent` is `user` (then `person` and `organisation` are the session's) or `service`; `rule` the policy rule; `reason` the text (the question of an informatievraag, the answer, the reason of an afkeuring or betwisting, the submitter's explanation on the indiening); `error` why an apply failed; `overridden-conflicts` the conflicts an applying step applied the request despite, as the approver saw them, derived from the states the step replaced |
| `conflicts`, `conflicts-token` | see [Conflicts](#conflicts); the token overrides exactly these conflicts in a goedkeuring |
| `competing` | the fields other pending requests propose something else for, `{ resource, key, proposed, "competing-requests": [uuid] }`, also without a conflict |
| `superseded` | on the answer of an apply: the uuids of the older pending requests this one replaced |
| `replaced-by` | on a request the service withdrew that way: the uuid of the newer request |
| `operations` | `GET /change-requests/:id` only: the operations as submitted, rebuilt from the stored versions (see below) |

**Who sees what.** Everyone who is logged in sees every request (with `pendingVisibleTo`
`involved` in the configuration, a request that waits is seen by the requesting organisation, the
organisation it is about and ABB only). The `person` of the steps and their `reason` texts are
shown to the requesting organisation and ABB only; anyone else gets null there. The requesting
organisation is always shown.

The same creation submitted by a gemeente, waiting for ABB:

```json
"attributes": {
  "status": "ingediend", "kind": "creation", "mine": true, "applied-at": null, "error": null,
  "target-name": "AGB Aalst", "target-classification": "36a8…", "…": "…",
  "steps": [ { "sequence": 1, "type": "indiening", "status": "ingediend", "rule": "may-create-classification",
               "reason": "Opgericht bij besluit van de gemeenteraad van 1 oktober 2026", "…": "…" } ],
  "conflicts": [], "conflicts-token": null, "competing": []
},
"relationships": {
  "target": { "data": { "type": "organizations", "id": "c3d0…" }, "meta": { "pending": true } },
  "requesting-organisation": { "data": { "type": "organizations", "id": "9a01…" } }
}
```

| Status | When |
| --- | --- |
| 201 | the request is written; `status` says whether it was applied (`afgehandeld`) or waits for ABB (`ingediend`) |
| 400 | the JSON could not be parsed |
| 401 | no session, or the session has no account, no acting organisation or no person |
| 403 | the policy denies; `meta.rule` names the rule that denied (`null` when no rule allowed it) |
| 404 | the target organisation does not exist |
| 409 | an edit with conflicts (`meta.conflicts`, `meta["conflicts-token"]`, `meta.competing`; nothing was saved); a creation whose KBO number is registered (`meta["kbo-number"]`, `meta.organisation`) or proposed by a pending creation (`meta["change-request"]`); the apply failed twice (the afhandeling is kept with status `mislukt`, `meta["change-request"]` carries the request's id, and a hertoepassing applies it again) |
| 413 | the body exceeds `MAX_BODY_SIZE` |
| 422 | an operation breaks one of the rules above; `source.pointer` points at it |

## `GET /change-requests` and `GET /change-requests/:id`

`GET /change-requests?filter[kind]=creation&filter[status]=ingediend,informatie-gevraagd&filter[mine]=true&page[number]=0&page[size]=20`

- Every request the session may see (everyone, or the involved organisations while a request
  waits, see above), **oldest first**; `sort=-created` for newest first.
- `page[number]` counts from 0; `page[size]` is 20 by default and at most 100. `meta.count` is the
  total; `links` has `first`, `last` and, where they exist, `prev` and `next`.
- Filters, combinable: `filter[kind]` (one or more of `edit`, `creation`, `change-event`,
  comma-separated); `filter[status]` (one or more statuses); `filter[mine]=true` (submitted by
  the session's person); `filter[requester]` (the uuid of the organisation that submitted them);
  `filter[target]` (the uuid of the organisation they are about; for a creation, the uuid the
  request minted); `filter[target-classification]` (the uuid of a classification concept, matched
  on the organisation or, for a creation that waits, on what it proposes);
  `filter[created][gte]` and `filter[created][lte]` (ISO 8601, inclusive).
- A filter on an unknown organisation gives an empty list; a malformed filter, sort or page a 400;
  a single request that is not visible a 404.
- The steps, versions and current values are read for the requests of the page only, in batches
  under Virtuoso's row limit (a result that would reach it is an error, never a cut-off answer).
- The documents have the shape above, without `lids`. A pending request shows its conflicts, their
  token and its competing keys computed live, so they change as others edit; a decided request
  shows none, but its applying steps show the conflicts they overrode. A creation that waits has
  `meta.pending` on its target and takes `target-name` and `target-classification` from what it
  proposes.
- `GET /change-requests/:id` adds `operations`: the submitted operations rebuilt from the stored
  versions, one `{ "op", "data": { "type", "id", "attributes", "relationships" } }` per version
  (`id` is the uuid the service minted for a create; an update lists the keys it clears as null
  or `[]`; a delete carries type and id only). The values render as in the conflicts. The
  document of the aggregate's root type comes first (the organisation of a creation, the change
  event of a change-event request), then the others by type. It is what the Aanvraagformulier
  tab shows.

## `POST /change-requests/:id/steps`

```json
{ "data": { "type": "change-request-steps",
            "attributes": { "step-type": "afkeuring", "reason": "Het KBO-nummer hoort bij een andere organisatie" } } }
```

| `step-type` | from status | to status | allowed by | `reason` |
| --- | --- | --- | --- | --- |
| `goedkeuring` | `ingediend` | `afgehandeld` (through `goedgekeurd`), or `mislukt` when the apply fails | `canDecide`: ABB | optional |
| `afkeuring` | `ingediend`, `informatie-gevraagd`, `mislukt` | `afgekeurd` | `canDecide`: ABB | required: the reason |
| `informatievraag` | `ingediend` | `informatie-gevraagd` | `canDecide`: ABB | required: the question |
| `informatieantwoord` | `informatie-gevraagd` | `ingediend` | `canReply`: the requesting organisation | required: the answer |
| `betwisting` | `afgekeurd` | `ingediend` | `canReply`: the requesting organisation | required: why the rejection is contested |
| `intrekking` | `ingediend`, `informatie-gevraagd`, `mislukt` | `ingetrokken` | `canWithdraw`: ABB, the requesting organisation | optional |
| `hertoepassing` | `mislukt` | `afgehandeld`, or `mislukt` | `canEdit` on the target (`canCreate` for a creation), as a POST | optional |

- `indiening` is only the first step of `POST /change-requests`; `afhandeling` is the service's
  (it follows every goedkeuring); `wijziging` is reserved: a pending request is answered,
  contested or withdrawn, never amended.
- **A goedkeuring** is ABB's decision; the service applies the stored versions in the same update,
  as the POST does, with the goedkeuring (status `goedgekeurd`, the person's) and the afhandeling
  (status `afgehandeld`, the service's) as two steps, and stamps the target with the person who
  submitted the request. It checks the conflicts again first, live: when there are any it answers
  409 with them in `meta.conflicts` and their token in `meta["conflicts-token"]`, unless the body
  says `"override": "<that token>"` (the token GET shows, or the one of the 409). So the approver
  overrides exactly the conflicts they reviewed; a change that lands after the review gives
  another token and another 409. The states the afhandeling replaced keep what it overwrote; the
  step shows `"overrides-conflict": true` and `overridden-conflicts`.
- A goedkeuring or hertoepassing of a request that updates a record deleted since is refused with
  409 (`meta["missing-records"]`), also with `override`: it could never succeed. Reject or
  withdraw it.
- The apply plans the stored versions against what the records hold at that moment: a list merges
  the request's additions and removals, as at submission. A creation writes its organisation with
  everything the request carries.
- **A hertoepassing** applies what was approved before, without a new review; what it overwrites
  shows as its `overridden-conflicts`. It is refused with 409 when another request on the
  organisation that changed something was applied after this one failed. The frontend then asks
  for a reload and the user enters the change again.
- `reason` is kept on the step. The step gets the next `sequence`.
- `POST /change-requests/:id/apply` is the same as a `hertoepassing` step, answered with 200, as
  the first version of the service offered it.

Answer: `201 Created` with the request, its `steps` ending with the new one(s).

| Status | When |
| --- | --- |
| 201 | the step is taken |
| 401 | no session, or the session has no account, no acting organisation or no person |
| 403 | the policy denies; `meta.rule` as for the POST |
| 404 | the request is not visible to the acting organisation |
| 409 | the status does not admit the step (`meta.status`, `meta["step-type"]`); a goedkeuring without the token of the current conflicts (`meta.conflicts`, `meta["conflicts-token"]`); a request that updates deleted records (`meta["missing-records"]`); a hertoepassing after a later applied request; an apply that failed twice |
| 422 | an unknown or reserved `step-type`, an afkeuring, informatievraag, informatieantwoord or betwisting without `reason`, an `override` that is not a token (`true` is not one), a malformed body |

## `GET /change-requests/permissions?target=<uuid>`

```json
{ "can-edit": true, "can-submit-change-event": true, "can-decide": false, "rules": ["own-organisation"] }
```

The same `canEdit` evaluation the POST runs, so the frontend and the server cannot disagree:
`can-edit` is whether the session may edit the organisation, `can-submit-change-event` whether it
may register a veranderingsgebeurtenis about it (the same rules today), `rules` names the rule
that decided (empty when none did, which is a deny). `can-decide` is the `canDecide` evaluation:
whether the session approves, rejects and asks for information. 404 when the organisation does
not exist.

Without `target`:

```json
{ "can-create": ["http://data.vlaanderen.be/id/concept/BestuurseenheidClassificatieCode/36a8…", "…"], "can-decide": false }
```

`can-create` lists the classifications (as URIs, from `creatableClassifications` in the
configuration) of the organisations the session may request; empty when it may request none.

## Conflicts

```json
{ "resource": { "type": "contact-points", "id": "c0ff…" }, "key": "email",
  "base": "loket@aalst.be", "current": "info@aalst.be", "proposed": null,
  "master-exists": true, "competing-requests": ["5e97…"] }
```

A field (`key`) of a record (`resource`) where the proposal disagrees with the current value, and
the record no longer holds what the request started from. Values are JSON: a string, number,
boolean or null, an array for a list, `{ type, id }` identifiers for relationships.

- An update conflicts on a single-valued field someone changed to another value since its base;
  a list merges and does not conflict.
- A record that no longer exists is a conflict on every field the update writes, with `current`
  null and `"master-exists": false`; such a request cannot be applied.
- A delete conflicts on a value someone set on the record since its base, and on every link to the
  record made since it was submitted. Such a link is shown on the record that links: its
  relationship holds the deleted record now (`current`), not in `base` and `proposed`:

```json
{ "resource": { "type": "sites", "id": "8d2a…" }, "key": "contacts",
  "base": [], "current": [ { "type": "contact-points", "id": "c0ff…" } ], "proposed": [],
  "master-exists": true, "competing-requests": [] }
```

- `competing-requests` are the other pending requests that write the same field of the same
  record and disagree: another value for a single-valued field, an addition of what the other
  removes for a list, anything but removal against a delete.
- `conflicts-token` is a hash of the conflicts as rendered (without their competing requests); a
  goedkeuring passes it as `override`.

## Errors

```json
{ "errors": [ { "status": "422", "title": "Unprocessable change request",
                "detail": "unknown attribute \"colour\" for type \"addresses\"",
                "source": { "pointer": "/data/attributes/operations/0/data/attributes/colour" } } ] }
```
