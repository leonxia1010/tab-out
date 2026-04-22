// Dashboard re-exports of shared domain-grouping primitives. Kept as a
// thin shim so existing imports (`./domain-aliases.js`) keep working
// after v2.7.0 moved the lookup tables + grouping helpers to
// `shared/src/domain-grouping.ts`.

export {
  DEFAULT_DOMAIN_ALIASES,
  domainIdFor,
  effectiveDomain,
} from '../../../shared/dist/domain-grouping.js';
