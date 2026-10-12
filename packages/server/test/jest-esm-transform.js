// Jest (CommonJS mode) cannot load ESM-only packages. sanitize-html >= 2.17.6 depends on
// htmlparser2 12 and its ESM-only dom* / entities dependencies; Node >= 22.12 loads them at
// runtime via require(esm), but Jest needs them transpiled to CommonJS. Uses the project's
// own TypeScript compiler, so no extra dependency is required.
const { createHash } = require('crypto');
const ts = require('typescript');

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(sourceText, {
      fileName: sourcePath,
      compilerOptions: {
        allowJs: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2021,
        esModuleInterop: true,
      },
    });
    return { code: outputText };
  },
  getCacheKey(sourceText, sourcePath) {
    return createHash('sha256')
      .update(ts.version)
      .update('\0')
      .update(sourcePath)
      .update('\0')
      .update(sourceText)
      .digest('hex');
  },
};
