// Module resolve hook for the golden generators. The Node reference imports its siblings
// as "./errors.js" although the files are .ts; this maps a relative ".js" specifier that
// does not exist onto the ".ts" file next to it, so src/brokers/dhan/*.ts is imported
// UNMODIFIED. Registered by generate.mjs; nothing here touches the sources.
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
