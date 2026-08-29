import "../src/lib/crypto-random-uuid";

const uuid = globalThis.crypto.randomUUID();
document.body.dataset.secureContext = String(globalThis.isSecureContext);
document.body.dataset.randomUuidType = typeof globalThis.crypto.randomUUID;
document.body.dataset.uuid = uuid;
document.body.textContent = uuid;
