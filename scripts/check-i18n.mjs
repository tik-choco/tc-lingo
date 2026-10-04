import { readdir } from 'node:fs/promises';
const dir = new URL('../src/i18n/', import.meta.url);
const locales = ['en', 'ja', 'zh-CN', 'zh-TW'];
const signature = text => [...text.matchAll(/\{[\w-]+\}/g)].map(match => match[0]).sort().join(',');
let count = 0;
for (const file of await readdir(dir)) {
  if (!file.endsWith('.ts') || ['index.ts', 'types.ts'].includes(file)) continue;
  const exports = await import(new URL(file, dir).href);
  for (const [name, bundle] of Object.entries(exports)) {
    if (!bundle?.en) continue;
    const keys = Object.keys(bundle.en).sort();
    for (const locale of locales) {
      if (JSON.stringify(Object.keys(bundle[locale] ?? {}).sort()) !== JSON.stringify(keys)) throw new Error(`${name}: mismatched ${locale} keys`);
      for (const key of keys) {
        const value = bundle[locale][key];
        if (typeof value !== 'string' || !value.trim() || signature(value) !== signature(bundle.en[key])) throw new Error(`${name}: invalid ${locale}.${key}`);
      }
    }
    count += keys.length;
  }
}
console.log(`i18n: ${count} keys complete in ${locales.join(', ')}`);
