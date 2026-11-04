// Packs a zip into a signed CRX3 and writes the matching update manifest. No dependencies.
//
//   node scripts/crx.mjs keygen <key.pem>                  new signing key; prints the extension ID
//   node scripts/crx.mjs id                                prints the extension ID for the key
//   node scripts/crx.mjs pack <in.zip> <out.crx>           sign the zip
//   node scripts/crx.mjs update-xml <out.xml> <version> <crx url>
//
// The key is read from CRX_PRIVATE_KEY (the PEM text) or CRX_PRIVATE_KEY_FILE. It decides the
// extension ID, so it must never change: a new key makes a different extension, and installed
// copies stop updating.
//
// CRX3 layout: "Cr24", version 3, header length, CrxFileHeader (protobuf), zip. The header
// holds the public key and an RSA-SHA256 signature over
// "CRX3 SignedData\0" + len(signed_header_data) + signed_header_data + zip.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [cmd, ...args] = process.argv.slice(2);

function loadKey() {
  const pem = process.env.CRX_PRIVATE_KEY
    || (process.env.CRX_PRIVATE_KEY_FILE && readFileSync(process.env.CRX_PRIVATE_KEY_FILE, 'utf8'));
  if (!pem) throw new Error('Set CRX_PRIVATE_KEY or CRX_PRIVATE_KEY_FILE');
  return createPrivateKey(pem);
}

function publicDer(key) {
  return createPublicKey(key).export({ type: 'spki', format: 'der' });
}

/** The first 16 bytes of SHA-256(public key); the ID spells them with the letters a–p. */
function crxId(pub) {
  return createHash('sha256').update(pub).digest().subarray(0, 16);
}

function extensionId(pub) {
  return [...crxId(pub).toString('hex')].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function varint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

/** A length-delimited protobuf field. */
function field(number, bytes) {
  return Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
}

function uint32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function pack(zip, key) {
  const pub = publicDer(key);
  const signedHeaderData = field(1, crxId(pub)); // SignedData { crx_id }
  const signature = sign('sha256', Buffer.concat([
    Buffer.from('CRX3 SignedData\x00', 'binary'),
    uint32le(signedHeaderData.length),
    signedHeaderData,
    zip,
  ]), key);
  const header = Buffer.concat([
    field(2, Buffer.concat([field(1, pub), field(2, signature)])), // sha256_with_rsa: AsymmetricKeyProof
    field(10000, signedHeaderData), // signed_header_data
  ]);
  return Buffer.concat([Buffer.from('Cr24'), uint32le(3), uint32le(header.length), header, zip]);
}

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

switch (cmd) {
  case 'keygen': {
    const [out] = args;
    if (!out) throw new Error('usage: keygen <key.pem>');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    console.log(extensionId(publicDer(privateKey)));
    break;
  }
  case 'id':
    console.log(extensionId(publicDer(loadKey())));
    break;
  case 'pack': {
    const [zipPath, out] = args;
    if (!zipPath || !out) throw new Error('usage: pack <in.zip> <out.crx>');
    const key = loadKey();
    writeFileSync(out, pack(readFileSync(zipPath), key));
    console.log(`${out} (${extensionId(publicDer(key))})`);
    break;
  }
  case 'update-xml': {
    const [out, version, url] = args;
    if (!out || !version || !url) throw new Error('usage: update-xml <out.xml> <version> <crx url>');
    const id = extensionId(publicDer(loadKey()));
    writeFileSync(out, `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${escapeXml(url)}' version='${escapeXml(version)}' />
  </app>
</gupdate>
`);
    console.log(`${out} (${id} ${version})`);
    break;
  }
  default:
    console.error('usage: node scripts/crx.mjs keygen|id|pack|update-xml …');
    process.exit(2);
}
