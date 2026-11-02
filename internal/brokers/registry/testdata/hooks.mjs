// Module resolve hook for gen_registry.mjs. The Node sources import their siblings as
// "./x.js" although the files are .ts: a relative ".js" specifier that does not exist is
// mapped onto the ".ts" file next to it, so src/ is imported UNMODIFIED. Three runtime
// dependencies that would pull in MongoDB or the Box execution stack are replaced by
// stubs in this directory (resolved by URL, nothing in src/ is touched):
//   src/db.ts                         -> stub_db.mjs (in-memory Mongo semantics)
//   src/brokers/zerodha/liveAdapter.ts -> stub_box.mjs (never called: no live adapters)
//   src/box/dhanBrokerAdapter.ts      -> stub_box.mjs
const STUBS = [
  ["/src/db.ts", "./stub_db.mjs"],
  ["/src/brokers/zerodha/liveAdapter.ts", "./stub_box.mjs"],
  ["/src/box/dhanBrokerAdapter.ts", "./stub_box.mjs"],
];

function stubFor(url) {
  for (const [suffix, stub] of STUBS) {
    if (url.endsWith(suffix)) return new URL(stub, import.meta.url).href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  let result;
  try {
    result = await nextResolve(specifier, context);
  } catch (err) {
    if (err && err.code === "ERR_MODULE_NOT_FOUND" && /^\.{1,2}\//.test(specifier) && specifier.endsWith(".js")) {
      result = await nextResolve(specifier.slice(0, -3) + ".ts", context);
    } else {
      throw err;
    }
  }
  const stub = stubFor(result.url);
  return stub ? { url: stub, shortCircuit: true } : result;
}
