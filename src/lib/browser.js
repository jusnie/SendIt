// One namespace for both browsers: Firefox has `browser`, Chrome has `chrome`; both return
// promises in MV3.
export const b = globalThis.browser ?? globalThis.chrome;

export const isFirefox = b.runtime.getURL('').startsWith('moz-extension:');
