import { OSError, osFetch } from './openstack.js';
import { owned, projectQuery } from './projectScope.js';

const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

export async function listProjectNeutron(session, collection, request = osFetch) {
  if (!['networks', 'subnets'].includes(collection)) throw new TypeError('Unsupported Neutron collection');
  const resources = [];
  let marker = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const path = projectQuery(session, `/v2.0/${collection}`, {
      limit: String(PAGE_SIZE), ...(marker ? { marker } : {}),
    });
    const data = await request(session, 'network', path);
    const batch = data?.[collection];
    if (!Array.isArray(batch)) throw new OSError(502, 'Neutron returned an invalid resource list.', 'provider_failure');
    resources.push(...owned(batch, session));
    const hasNext = data?.[`${collection}_links`]?.some((link) => link.rel === 'next');
    if (!hasNext && batch.length < PAGE_SIZE) return resources;
    const last = batch.at(-1)?.id;
    if (!last || last === marker) throw new OSError(502, 'Neutron returned invalid pagination.', 'provider_failure');
    marker = last;
  }
  throw new OSError(502, 'Neutron resource list exceeded the safe pagination limit.', 'provider_failure');
}
