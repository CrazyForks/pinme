const nodeCrypto = require('crypto');
const { webcrypto } = nodeCrypto;

if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: webcrypto,
  });
}

if (typeof nodeCrypto.getRandomValues !== 'function') {
  nodeCrypto.getRandomValues = webcrypto.getRandomValues.bind(webcrypto);
}
