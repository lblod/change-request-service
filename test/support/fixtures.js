// Shared test fixtures: a real resources model, the service config, and a small
// organization-core-data request for the fixture organisation "Stad Aalst".
import fs from 'node:fs';
import path from 'node:path';
import { loadModel } from '../../lib/model.js';
import { loadConfig } from '../../lib/config.js';

export const MODEL_DIR = process.env.MODEL_DIR || path.resolve('../app-organization-portal/config/resources');
if (!fs.existsSync(MODEL_DIR)) {
  throw new Error(
    `The resources model directory ${MODEL_DIR} does not exist; point MODEL_DIR at app-lokale-verkenner/config/resources ` +
      '(or app-organization-portal/config/resources)',
  );
}

export const model = loadModel(MODEL_DIR);
export const config = loadConfig(path.resolve('config/change-requests.json'), model);

/** A deterministic uuid generator: ...-000000000001, ...-000000000002, ... */
export const uuidSequence = () => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
};
export const sequenceUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** A uuid (v4 format) for stored test data: testUuid('request', 5), testUuid('step', 51), ... */
const TEST_UUID_PREFIX = { request: 'aaaaaaaa', step: 'bbbbbbbb', version: 'cccccccc', state: 'dddddddd', link: 'eeeeeeee', error: 'ffffffff' };
export const testUuid = (kind, n) => `${TEST_UUID_PREFIX[kind]}-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const NOW = new Date('2026-11-03T10:12:00Z');
export const APPLIED_AT = new Date('2026-11-03T10:12:01Z');

export const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  org: 'http://www.w3.org/ns/org#',
  locn: 'http://www.w3.org/ns/locn#',
  adres: 'https://data.vlaanderen.be/ns/adres#',
  schema: 'http://schema.org/',
  adms: 'http://www.w3.org/ns/adms#',
  organisatie: 'https://data.vlaanderen.be/ns/organisatie#',
  generiek: 'https://data.vlaanderen.be/ns/generiek#',
  besluit: 'http://data.vlaanderen.be/ns/besluit#',
  regorg: 'http://www.w3.org/ns/regorg#',
  lblodgeneriek: 'https://data.lblod.info/vocabularies/generiek/',
  ere: 'http://data.lblod.info/vocabularies/erediensten/',
  dct: 'http://purl.org/dc/terms/',
  pav: 'http://purl.org/pav/',
  foaf: 'http://xmlns.com/foaf/0.1/',
  task: 'http://redpencil.data.gift/vocabularies/tasks/',
  oslc: 'http://open-services.net/ns/core#',
  as: 'https://www.w3.org/ns/activitystreams#',
  code: 'http://lblod.data.gift/vocabularies/organisatie/',
  mu: 'http://mu.semte.ch/vocabularies/core/',
  prov: 'http://www.w3.org/ns/prov#',
  cr: 'http://lblod.data.gift/vocabularies/change-requests/',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
};

export const IDS = {
  org: '9a01f3e2-4c7b-4d2a-9f1e-0a1b2c3d4e5f',
  orgB: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
  abb: '141d9d6b-54af-4d17-b313-8d1c30bc3f5b',
  site: '77c2a4b6-1d3e-4f5a-8b9c-0d1e2f3a4b5c',
  address: '4b6e8d0f-2a4c-4e6f-8a0b-2c4d6e8f0a1b',
  oldContact: 'c0ffee12-3456-4789-8abc-def012345678',
  kboIdentifier: '1d3f5a7c-9e0b-4d2f-8a4c-6e8a0c2e4a6c',
  structuredKbo: '2e4a6c8e-0b1d-4f3a-9c5e-7a9c1e3a5c7e',
  // organisation B's primary site and its address: not part of A's aggregate
  siteB: '8d2a1c4e-6f3b-4a5d-9e7c-1b3d5f7a9c2e',
  addressB: '3f5a7c9e-1b3d-4e6f-8a2c-4d6e8f0a2c4e',
  // code lists
  gemeenteCode: '5ab0e9b8a3b2ca7c5e000001',
  siteType: 'dcc01338-842c-4fbd-ba68-3ca6f3af975c',
  location: 'a2f6c8e0-4b1d-4e3f-9a5c-7e9b1d3f5a7c',
  statusCode: '63cc561de9188d64ba5840a42ae8f0d6',
  ilvCode: '3a2649ef-7345-4d3a-8709-f89fc9b44f58',
  oprichtingType: 'f0e2706a-3b64-4464-ad9c-4e65dc976288',
  nameChangeType: '6651dc69b0ae8f7ff9974e8a23db1dec',
};

export const URIS = {
  org: `http://data.lblod.info/id/bestuurseenheden/${IDS.org}`,
  orgB: `http://data.lblod.info/id/bestuurseenheden/${IDS.orgB}`,
  abb: config.abbUri,
  site: `http://data.lblod.info/id/vestigingen/${IDS.site}`,
  address: `http://data.lblod.info/id/adressen/${IDS.address}`,
  oldContact: `http://data.lblod.info/id/contact-punten/${IDS.oldContact}`,
  kboIdentifier: `http://data.lblod.info/id/identificatoren/${IDS.kboIdentifier}`,
  structuredKbo: `http://data.lblod.info/id/gestructureerdeIdentificatoren/${IDS.structuredKbo}`,
  siteB: `http://data.lblod.info/id/vestigingen/${IDS.siteB}`,
  addressB: `http://data.lblod.info/id/adressen/${IDS.addressB}`,
  account: 'http://data.lblod.info/id/account/5f1c2a3b-7d8e-4f90-a1b2-c3d4e5f60718',
  accountB: 'http://data.lblod.info/id/account/7b3e4c5d-9f0a-4b12-c3d4-e5f60718293a',
  accountAbb: 'http://data.lblod.info/id/account/6a2d3b4c-8e9f-4a01-b2c3-d4e5f6071829',
  // the persons of those accounts (foaf:account): who the service records
  person: 'http://data.lblod.info/id/persoon/1e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b',
  personB: 'http://data.lblod.info/id/persoon/2f3a4b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c',
  personAbb: 'http://data.lblod.info/id/persoon/3a4b5c6d-7e8f-4a9b-8c1d-2e3f4a5b6c7d',
  gemeenteCode: `http://data.vlaanderen.be/id/concept/BestuurseenheidClassificatieCode/${IDS.gemeenteCode}`,
  siteType: `http://lblod.data.gift/concepts/${IDS.siteType}`,
  location: `http://data.lblod.info/id/werkingsgebieden/${IDS.location}`,
  statusCode: `http://lblod.data.gift/concepts/${IDS.statusCode}`,
  ilvCode: `http://data.vlaanderen.be/id/concept/BestuurseenheidClassificatieCode/${IDS.ilvCode}`,
  oprichtingType: `http://lblod.data.gift/concepts/${IDS.oprichtingType}`,
  nameChangeType: `http://lblod.data.gift/concepts/${IDS.nameChangeType}`,
};

const organisationClasses = [`${NS.besluit}Bestuurseenheid`, `${NS.org}Organization`, `${NS.dct}Agent`];

/** What resolveResources would answer for the ids above. */
export const resources = new Map([
  [IDS.org, { uri: URIS.org, classes: organisationClasses }],
  [IDS.orgB, { uri: URIS.orgB, classes: organisationClasses }],
  [IDS.abb, { uri: URIS.abb, classes: organisationClasses }],
  [IDS.site, { uri: URIS.site, classes: [`${NS.org}Site`] }],
  [IDS.address, { uri: URIS.address, classes: [`${NS.locn}Address`] }],
  [IDS.oldContact, { uri: URIS.oldContact, classes: [`${NS.schema}ContactPoint`] }],
  [IDS.kboIdentifier, { uri: URIS.kboIdentifier, classes: [`${NS.adms}Identifier`] }],
  [IDS.structuredKbo, { uri: URIS.structuredKbo, classes: [`${NS.generiek}GestructureerdeIdentificator`] }],
  [IDS.siteB, { uri: URIS.siteB, classes: [`${NS.org}Site`] }],
  [IDS.addressB, { uri: URIS.addressB, classes: [`${NS.locn}Address`] }],
  [IDS.gemeenteCode, { uri: URIS.gemeenteCode, classes: [model.get('administrative-unit-classification-codes').class] }],
  [IDS.siteType, { uri: URIS.siteType, classes: [model.get('site-types').class] }],
  [IDS.location, { uri: URIS.location, classes: [model.get('locations').class] }],
  [IDS.statusCode, { uri: URIS.statusCode, classes: [model.get('organization-status-codes').class] }],
  [IDS.ilvCode, { uri: URIS.ilvCode, classes: [model.get('administrative-unit-classification-codes').class] }],
  [IDS.oprichtingType, { uri: URIS.oprichtingType, classes: [model.get('change-event-types').class] }],
  [IDS.nameChangeType, { uri: URIS.nameChangeType, classes: [model.get('change-event-types').class] }],
]);

/** The organisations findOrganisation can answer for. */
export const organisations = {
  [IDS.org]: { uri: URIS.org, uuid: IDS.org, classes: organisationClasses, classification: URIS.gemeenteCode },
  [IDS.orgB]: { uri: URIS.orgB, uuid: IDS.orgB, classes: organisationClasses, classification: URIS.gemeenteCode },
  [IDS.abb]: { uri: URIS.abb, uuid: IDS.abb, classes: organisationClasses, classification: null },
};

/** The records of each organisation's aggregate, as reachableFromTarget answers (the target included). */
export const reachableByOrganisation = {
  [URIS.org]: new Set([URIS.org, URIS.site, URIS.address, URIS.oldContact, URIS.kboIdentifier, URIS.structuredKbo]),
  [URIS.orgB]: new Set([URIS.orgB, URIS.siteB, URIS.addressB]),
  [URIS.abb]: new Set([URIS.abb]),
};
export const reachable = reachableByOrganisation[URIS.org];
export const target = organisations[IDS.org];

/** SPARQL JSON bindings, as the triplestore answers them. */
export const uri = (value) => ({ type: 'uri', value });
export const literal = (value, language) => (language ? { type: 'literal', value, 'xml:lang': language } : { type: 'literal', value });
export const typed = (value, datatype) => ({ type: 'typed-literal', value, datatype: datatype.startsWith('http') ? datatype : `${NS.xsd}${datatype}` });

const masters = [URIS.org, URIS.orgB, URIS.abb, URIS.site, URIS.address, URIS.oldContact, URIS.kboIdentifier, URIS.structuredKbo, URIS.siteB, URIS.addressB];

/**
 * What the masters hold before the fixture request, as currentTerms answers it ("<s> <p>" ->
 * bindings). Against it the request changes the house number, the full address and the address
 * register link of the address, the contacts and the site type of the site, the name, the sites
 * and the werkingsgebied of the organisation; it carries every other key as it is, so the
 * structured identifier ends up changing nothing.
 */
export const masterState = () => ({
  // every master exists: currentTerms answers (master, rdf:type) with its classes
  ...Object.fromEntries(
    [...resources.values()].filter((resource) => masters.includes(resource.uri)).map((resource) => [`${resource.uri} ${NS.rdf}type`, resource.classes.map(uri)]),
  ),
  [`${URIS.address} ${NS.locn}thoroughfare`]: [literal('Grote Markt')],
  [`${URIS.address} ${NS.adres}Adresvoorstelling.huisnummer`]: [literal('1')],
  [`${URIS.address} ${NS.locn}postCode`]: [literal('9300')],
  [`${URIS.address} ${NS.adres}gemeentenaam`]: [literal('Aalst')],
  [`${URIS.address} ${NS.locn}adminUnitL2`]: [literal('Oost-Vlaanderen')],
  [`${URIS.address} ${NS.adres}land`]: [literal('België')],
  [`${URIS.address} ${NS.locn}fullAddress`]: [literal('Grote Markt 1, 9300 Aalst, België')],
  [`${URIS.address} ${NS.adres}verwijstNaar`]: [uri('https://data.vlaanderen.be/id/adres/123455')],
  [`${URIS.site} ${NS.organisatie}bestaatUit`]: [uri(URIS.address)],
  [`${URIS.site} ${NS.org}siteAddress`]: [uri(URIS.oldContact)],
  [`${URIS.structuredKbo} ${NS.generiek}lokaleIdentificator`]: [literal('0207437468')],
  [`${URIS.org} ${NS.skos}prefLabel`]: [literal('Aalst')],
  [`${URIS.org} ${NS.skos}altLabel`]: [literal('Aalst')],
  [`${URIS.org} ${NS.org}hasPrimarySite`]: [uri(URIS.site)],
  [`${URIS.org} ${NS.org}hasSite`]: [uri(URIS.site)],
  [`${URIS.org} ${NS.adms}identifier`]: [uri(URIS.kboIdentifier)],
  [`${URIS.org} ${NS.besluit}werkingsgebied`]: [uri(URIS.location)],
  [`${URIS.org} ${NS.org}classification`]: [uri(URIS.gemeenteCode)],
  [`${URIS.org} ${NS.regorg}orgStatus`]: [uri(URIS.statusCode)],
  [`${URIS.orgB} ${NS.skos}prefLabel`]: [literal('Gent')],
  [`${URIS.orgB} ${NS.org}classification`]: [uri(URIS.gemeenteCode)],
});

/** A Map as currentTerms returns it, for the given state. */
export const currentMap = (state = masterState()) => new Map(Object.entries(state));

/**
 * The records that link to a record in the given state: Map "<object> <predicate>" -> the SPARQL
 * JSON bindings of the subjects, as incomingTerms returns it (every pair that has links).
 */
export const incomingMap = (state = masterState()) => {
  const links = new Map();
  for (const [pair, objects] of Object.entries(state)) {
    const [subject, predicate] = pair.split(' ');
    for (const object of objects) {
      if (object.type !== 'uri') continue;
      const key = `${object.value} ${predicate}`;
      if (!links.has(key)) links.set(key, []);
      links.get(key).push({ type: 'uri', value: subject });
    }
  }
  return links;
};

export const sessions = {
  orgA: {
    session: 'http://mu.semte.ch/sessions/a1',
    account: URIS.account,
    accountUuid: '5f1c2a3b-7d8e-4f90-a1b2-c3d4e5f60718',
    person: URIS.person,
    personUuid: '1e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b',
    actor: { uri: URIS.org, uuid: IDS.org, classification: URIS.gemeenteCode },
  },
  orgB: {
    session: 'http://mu.semte.ch/sessions/b1',
    account: URIS.accountB,
    accountUuid: '7b3e4c5d-9f0a-4b12-c3d4-e5f60718293a',
    person: URIS.personB,
    personUuid: '2f3a4b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c',
    actor: { uri: URIS.orgB, uuid: IDS.orgB, classification: URIS.gemeenteCode },
  },
  abb: {
    session: 'http://mu.semte.ch/sessions/abb1',
    account: URIS.accountAbb,
    accountUuid: '6a2d3b4c-8e9f-4a01-b2c3-d4e5f6071829',
    person: URIS.personAbb,
    personUuid: '3a4b5c6d-7e8f-4a9b-8c1d-2e3f4a5b6c7d',
    actor: { uri: URIS.abb, uuid: IDS.abb, classification: null },
  },
};

/**
 * The kerngegevens page of Stad Aalst saved as one request. The documents carry only keys that
 * both OP's and app-lokale-verkenner's model define, so the generated updates are the same under either.
 */
export const operations = [
  {
    op: 'update',
    data: {
      type: 'addresses',
      id: IDS.address,
      attributes: {
        street: 'Grote Markt',
        number: '3',
        'box-number': null,
        postcode: '9300',
        municipality: 'Aalst',
        province: 'Oost-Vlaanderen',
        country: 'België',
        'full-address': 'Grote Markt 3, 9300 Aalst, België',
        'address-register-uri': 'https://data.vlaanderen.be/id/adres/123456',
      },
      relationships: { source: { data: null } },
    },
  },
  {
    op: 'create',
    data: {
      type: 'contact-points',
      lid: 'c1',
      attributes: { email: 'info@aalst.be', telephone: '+32 53 77 93 00', type: 'Primary' },
      relationships: { 'contact-address': { data: { type: 'addresses', id: IDS.address } } },
    },
  },
  {
    op: 'update',
    data: {
      type: 'sites',
      id: IDS.site,
      attributes: { 'site-type-name': null },
      relationships: {
        address: { data: { type: 'addresses', id: IDS.address } },
        contacts: { data: [{ type: 'contact-points', lid: 'c1' }] },
        'site-type': { data: { type: 'site-types', id: IDS.siteType } },
      },
      // the contacts as the page loaded them
      meta: { base: { relationships: { contacts: { data: [{ type: 'contact-points', id: IDS.oldContact }] } } } },
    },
  },
  {
    op: 'update',
    data: {
      type: 'structured-identifiers',
      id: IDS.structuredKbo,
      attributes: { 'local-id': '0207437468' },
    },
  },
  {
    op: 'update',
    data: {
      type: 'administrative-units',
      id: IDS.org,
      attributes: {
        name: 'Stad Aalst',
        'alternative-name': ['Aalst'],
        'legal-name': null,
        'expected-end-date': null,
        purpose: null,
      },
      relationships: {
        'primary-site': { data: { type: 'sites', id: IDS.site } },
        sites: { data: [] },
        identifiers: { data: [{ type: 'identifiers', id: IDS.kboIdentifier }] },
        // outside the aggregate: carried as the page loaded it, unchanged
        classification: { data: { type: 'administrative-unit-classification-codes', id: IDS.gemeenteCode } },
        // a reference: the werkingsgebied is cleared
        scope: { data: null },
        // inverse: the other record's state, ignored
        memberships: { data: [] },
      },
      // the name as the page loaded it
      meta: { base: { attributes: { name: 'Aalst' } } },
    },
  },
  { op: 'delete', data: { type: 'contact-points', id: IDS.oldContact } },
];

/** The besluit links of a decision, under the model at hand: OP has document-links (uri-set), app-lokale-verkenner document-link. */
export const decisionLinks = (links) => (model.attribute('decisions', 'document-links') ? { 'document-links': links } : { 'document-link': links[0] ?? null });

/**
 * A gemeente requests a new interlokale vereniging: the organisation with its KBO number, its
 * primary site with an address, and the Oprichting change event with the besluit it rests on.
 */
export const creationOperations = () => [
  {
    op: 'create',
    data: {
      type: 'administrative-units',
      lid: 'o1',
      attributes: { name: 'ILV Denderland', 'legal-name': 'Interlokale vereniging Denderland' },
      relationships: {
        classification: { data: { type: 'administrative-unit-classification-codes', id: IDS.ilvCode } },
        'organization-status': { data: { type: 'organization-status-codes', id: IDS.statusCode } },
        identifiers: { data: [{ type: 'identifiers', lid: 'i1' }] },
        'primary-site': { data: { type: 'sites', lid: 'v1' } },
        sites: { data: [{ type: 'sites', lid: 'v1' }] },
      },
    },
  },
  { op: 'create', data: { type: 'identifiers', lid: 'i1', attributes: { 'id-name': 'KBO nummer' }, relationships: { 'structured-identifier': { data: { type: 'structured-identifiers', lid: 's1' } } } } },
  { op: 'create', data: { type: 'structured-identifiers', lid: 's1', attributes: { 'local-id': '0123456789' } } },
  { op: 'create', data: { type: 'sites', lid: 'v1', relationships: { address: { data: { type: 'addresses', lid: 'a1' } } } } },
  { op: 'create', data: { type: 'addresses', lid: 'a1', attributes: { street: 'Grote Markt', number: '1', postcode: '9300', municipality: 'Aalst', country: 'België', 'full-address': 'Grote Markt 1, 9300 Aalst, België' } } },
  {
    op: 'create',
    data: {
      type: 'change-events',
      lid: 'e1',
      attributes: { date: '2026-10-01', description: 'Opgericht bij besluit van de gemeenteraad' },
      relationships: { type: { data: { type: 'change-event-types', id: IDS.oprichtingType } }, 'original-organizations': { data: [{ type: 'administrative-units', lid: 'o1' }] }, decision: { data: { type: 'decisions', lid: 'd1' } } },
    },
  },
  { op: 'create', data: { type: 'decisions', lid: 'd1', attributes: decisionLinks(['https://aalst.be/besluiten/2026/123']) } },
];

export const creationBody = (ops = creationOperations(), extra = {}) => ({
  data: { type: 'change-requests', attributes: { aggregate: 'new-organisation', operations: ops, ...extra } },
});

/** Organisation A registers a change of name as a change event, with the besluit and the new name on itself. */
export const changeEventOperations = (name = 'Stad Aalst') => [
  {
    op: 'create',
    data: {
      type: 'change-events',
      lid: 'e1',
      attributes: { date: '2026-10-01', description: 'Naamswijziging' },
      relationships: { type: { data: { type: 'change-event-types', id: IDS.nameChangeType } }, 'original-organizations': { data: [{ type: 'administrative-units', id: IDS.org }] }, decision: { data: { type: 'decisions', lid: 'd1' } } },
    },
  },
  { op: 'create', data: { type: 'decisions', lid: 'd1', attributes: decisionLinks(['https://aalst.be/besluiten/2026/124']) } },
  { op: 'update', data: { type: 'administrative-units', id: IDS.org, attributes: { name }, meta: { base: { attributes: { name: 'Aalst' } } } } },
];

export const body = (target = IDS.org, aggregate = 'organization-core-data', ops = operations) => ({
  data: {
    type: 'change-requests',
    attributes: { aggregate, operations: ops },
    relationships: { target: { data: { type: 'administrative-units', id: target } } },
  },
});
