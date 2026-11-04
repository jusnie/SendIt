// Writes dist/chrome, dist/chromium and dist/firefox from src/. No dependencies:
// `node scripts/build.mjs`. src/ itself is the Chrome build, so Chrome can also load src/
// unpacked while developing.
//
//   chrome    for the Chrome Web Store and Load unpacked (the store rejects update_url)
//   chromium  same code, packed as a .crx for browsers that allow off-store installs; updates
//             itself from CRX_UPDATE_URL
//   firefox   event page instead of a service worker; updates itself from FIREFOX_UPDATE_URL
//
// Environment (used by the release workflow):
//   VERSION             overrides the manifest version, e.g. 1.2.0
//   FIREFOX_UPDATE_URL  Firefox update manifest (updates.json)
//   CRX_UPDATE_URL      Chromium update manifest (updates.xml)
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const manifest = JSON.parse(await readFile(join(src, 'manifest.json'), 'utf8'));
const GECKO_ID = 'sendit-browser-extension@sendit';

const { VERSION, FIREFOX_UPDATE_URL, CRX_UPDATE_URL } = process.env;
if (VERSION) {
  // Both browsers want 1 to 4 dot-separated integers.
  if (!/^\d+(\.\d+){0,3}$/.test(VERSION)) throw new Error(`VERSION must look like 1.2.3, got "${VERSION}"`);
  manifest.version = VERSION;
}

const targets = {
  chrome: (m) => m,
  chromium: (m) => {
    if (CRX_UPDATE_URL) m.update_url = CRX_UPDATE_URL;
    return m;
  },
  firefox: (m) => {
    // Firefox runs MV3 backgrounds as event pages and has no offscreen API.
    m.background = { scripts: ['background.js'], type: 'module' };
    m.permissions = m.permissions.filter((p) => p !== 'offscreen');
    delete m.minimum_chrome_version;
    m.browser_specific_settings = {
      gecko: {
        id: GECKO_ID,
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
        ...(FIREFOX_UPDATE_URL && { update_url: FIREFOX_UPDATE_URL }),
      },
    };
    return m;
  },
};

for (const [name, transform] of Object.entries(targets)) {
  const out = join(root, 'dist', name);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(src, out, {
    recursive: true,
    filter: (p) => !(name === 'firefox' && p.includes('offscreen')),
  });
  const m = transform(structuredClone(manifest));
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
  console.log(`dist/${name} (v${m.version})`);
}
