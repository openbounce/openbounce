// The default DataProvider: bundled, Set-backed lookups (O(1)) + did-you-mean. Pure — the JSON is
// inlined at build time (no runtime fetch/I/O). Regenerate the list with scripts/update-data.mjs.

import { suggestEmail } from '../core/typo';
import type { DataProvider } from '../types';
import disposableList from './generated/disposable.json';
import { FREE_PROVIDERS } from './free';
import { ROLE_LOCALPARTS } from './role';
import { COMMON_DOMAINS } from './typo-domains';

const disposable = new Set<string>(disposableList);
const free = new Set<string>(FREE_PROVIDERS);
const roles = new Set<string>(ROLE_LOCALPARTS);

export const defaultData: DataProvider = {
  isDisposable: (domain) => disposable.has(domain.toLowerCase()),
  isFreeProvider: (domain) => free.has(domain.toLowerCase()),
  isRoleAccount: (localPart) => roles.has(localPart.toLowerCase()),
  suggest: (email) => suggestEmail(email, COMMON_DOMAINS),
};
