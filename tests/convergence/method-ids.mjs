// Admission constraint for signed document/asset proof fixtures.
export function assertUniqueMethodIds(doc) {
    const methods = doc?.verificationMethod;
    if (!Array.isArray(methods)) return;
    const ids = methods.map(method => method.id?.startsWith('#') ? doc.id + method.id : method.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate normalized verification-method ID');
}
