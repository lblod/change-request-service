// Shared test fixtures: a real resources model, the service config, and a small
// organization-core-data request for the fixture organisation "Stad Aalst".
import fs from 'node:fs';
import path from 'node:path';
import { loadModel } from '../../lib/model.js';
import { loadConfig } from '../../lib/config.js';

export const MODEL_DIR = process.env.MODEL_DIR || path.resolve('../app-organization-portal/config/resources');
if (!fs.existsSync(MODEL_DIR)) {
  throw new Error(
    `The resources model directory ${MODEL_DIR} does not exist; point MODEL_DIR at app-rvs/config/resources ` +
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
  foaf: 'http://xmlns.com/foaf/0.1/',
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
  accountAbb: 'http://data.lblod.info/id/account/6a2d3b4c-8e9f-4a01-b2c3-d4e5f6071829',
  gemeenteCode: `http://data.vlaanderen.be/id/concept/BestuurseenheidClassificatieCode/${IDS.gemeenteCode}`,
  siteType: `http://lblod.data.gift/concepts/${IDS.siteType}`,
  location: `http://data.lblod.info/id/werkingsgebieden/${IDS.location}`,
  statusCode: `http://lblod.data.gift/concepts/${IDS.statusCode}`,
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

/** What the masters currently hold for the relationships outside the aggregate (currentObjects). */
export const masterObjects = {
  [`${URIS.org} ${NS.org}classification`]: [URIS.gemeenteCode],
  [`${URIS.org} ${NS.regorg}orgStatus`]: [URIS.statusCode],
  [`${URIS.orgB} ${NS.org}classification`]: [URIS.gemeenteCode],
};

export const sessions = {
  orgA: { session: 'http://mu.semte.ch/sessions/a1', account: URIS.account, actor: { uri: URIS.org, uuid: IDS.org, classification: URIS.gemeenteCode } },
  orgB: { session: 'http://mu.semte.ch/sessions/b1', account: URIS.account, actor: { uri: URIS.orgB, uuid: IDS.orgB, classification: URIS.gemeenteCode } },
  abb: { session: 'http://mu.semte.ch/sessions/abb1', account: URIS.accountAbb, actor: { uri: URIS.abb, uuid: IDS.abb, classification: null } },
};

/**
 * The kerngegevens page of Stad Aalst saved as one request. The documents carry only keys that
 * both OP's and app-rvs's model define, so the generated updates are the same under either.
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
    },
  },
  { op: 'delete', data: { type: 'contact-points', id: IDS.oldContact } },
];

export const body = (target = IDS.org, aggregate = 'organization-core-data', ops = operations) => ({
  data: {
    type: 'change-requests',
    attributes: { aggregate, operations: ops },
    relationships: { target: { data: { type: 'administrative-units', id: target } } },
  },
});
