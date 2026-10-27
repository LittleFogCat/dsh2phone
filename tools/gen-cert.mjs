// Generate a self-signed TLS cert for local test endpoints (pure JS, no system crypto)
import forge from "node-forge";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "deploy", "tls");
mkdirSync(outDir, { recursive: true });

const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = "01" + Date.now().toString(16);
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date(Date.now() + 30 * 24 * 3600 * 1000);
const attrs = [{ name: "commonName", value: "127.0.0.1" }];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.setExtensions([
  { name: "subjectAltName", altNames: [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
  ]},
  { name: "basicConstraints", cA: false },
]);
cert.sign(keys.privateKey, forge.md.sha256.create());

const pemKey = forge.pki.privateKeyToPem(keys.privateKey);
const pemCert = forge.pki.certificateToPem(cert);
writeFileSync(join(outDir, "key.pem"), pemKey);
writeFileSync(join(outDir, "cert.pem"), pemCert);
console.log("written:", join(outDir, "key.pem"), "and cert.pem");
