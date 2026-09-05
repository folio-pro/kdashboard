import { describe, expect, test } from 'bun:test';

import { relocateEsmShimCode } from './esm-shim';

const SHIM = `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`;

describe('relocateEsmShimCode', () => {
  test('moves the shim right after the last real top-level import', () => {
    const code = `import a from 'a';\nimport { b } from 'b';\nconst x = typeof __filename;\n/** example:\n * import { Ajv } from 'ajv';\n */\nfunction f() {}${SHIM}const y = 1;\n`;
    const out = relocateEsmShimCode(code);
    expect(out.indexOf('// -- CommonJS Shims --')).toBeGreaterThan(out.indexOf("import { b } from 'b';"));
    expect(out.indexOf('// -- CommonJS Shims --')).toBeLessThan(out.indexOf('const x = typeof __filename'));
    expect(out.match(/CommonJS Shims/g)?.length).toBe(1);
  });

  test('ignores import-like text inside strings and comments', () => {
    const code = `import a from 'a';\nconst s = "import x from 'y';";\n// import z from 'z';${SHIM}`;
    const out = relocateEsmShimCode(code);
    expect(out.startsWith("import a from 'a';\n// -- CommonJS Shims --")).toBe(true);
  });

  test('a bundle without static imports gets the shim at the top', () => {
    const out = relocateEsmShimCode(`const a = 1;${SHIM}const b = 2;\n`);
    expect(out.startsWith('\n// -- CommonJS Shims --')).toBe(true);
  });

  test('code without a shim is returned as is', () => {
    const code = "import a from 'a';\nconst b = 2;\n";
    expect(relocateEsmShimCode(code)).toBe(code);
  });
});
