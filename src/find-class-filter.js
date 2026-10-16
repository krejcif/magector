/**
 * Does a normalized search result qualify as a hit for magento_find_class?
 * Module READMEs are indexed as markdown sections; a README under a module
 * whose name contains the class name must never be returned as a class.
 */
export function isClassCandidate(r, classLower) {
  if (r.type === 'markdown' || r.magentoType === 'readme') return false;
  return Boolean(
    r.className?.toLowerCase().includes(classLower) ||
    r.path?.toLowerCase().includes(classLower.replace(/\\/g, '/'))
  );
}
