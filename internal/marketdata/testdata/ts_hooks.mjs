// Module resolve hook for gen_routes.mjs. The Node reference imports its siblings as
// "./x.js" although the files are .ts; this maps a relative ".js" specifier that does not
// exist onto the ".ts" file next to it, so src/*.ts is imported UNMODIFIED. Registered by
// gen_routes.mjs; nothing here touches the sources. (Same hook as
// internal/brokers/dhan/testdata/ts_hooks.mjs, kept here so this package's testdata is
// self-contained.)
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (
      err &&
      err.code === "ERR_MODULE_NOT_FOUND" &&
      /^\.{1,2}\//.test(specifier) &&
      specifier.endsWith(".js")
    ) {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
    throw err;
  }
}
