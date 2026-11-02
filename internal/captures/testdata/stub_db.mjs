// In-memory stand-in for the Mongoose models src/eodCapture.ts and src/hourlyCapture.ts
// import from ./db.js. It implements only the calls those two files make, with MongoDB
// semantics for the filters they use ($in, $nin, $gte, equality on strings and Dates).
// Used by gen_parity.mjs; never touches a database.

let oid = 0;
const newId = () => (++oid).toString(16).padStart(24, "0");

const eq = (a, b) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter ?? {})) {
    const v = doc[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("$in" in cond && !cond.$in.some((x) => eq(v, x))) return false;
      if ("$nin" in cond && cond.$nin.some((x) => eq(v, x))) return false;
      if ("$gte" in cond && !(v !== undefined && v >= cond.$gte)) return false;
    } else if (!eq(v, cond)) return false;
  }
  return true;
}

const cloneDoc = (d) => {
  const out = {};
  for (const [k, v] of Object.entries(d)) out[k] = v instanceof Date ? new Date(v.getTime()) : v;
  return out;
};

function project(doc, proj) {
  if (!proj) return cloneDoc(doc);
  const out = {};
  if (proj._id !== 0) out._id = doc._id;
  for (const [k, on] of Object.entries(proj)) {
    if (k !== "_id" && on && k in doc) out[k] = doc[k] instanceof Date ? new Date(doc[k].getTime()) : doc[k];
  }
  return out;
}

const sortValue = (v) => (v instanceof Date ? v.getTime() : v);

class Model {
  constructor(name) {
    this.name = name;
    this.reset();
  }
  reset() {
    this.docs = [];
    this.writes = 0;
    this.failAfter = null; // throw on every write once `writes` reaches this count
    this.ops = [];
  }
  seed(docs) {
    for (const d of docs) this.docs.push({ _id: d._id ?? newId(), ...cloneDoc(d) });
  }
  async updateOne(filter, update, opts) {
    if (this.failAfter !== null && this.writes >= this.failAfter) {
      throw new Error("write failed");
    }
    this.writes++;
    const set = cloneDoc(update.$set);
    this.ops.push({ op: "updateOne", filter: cloneDoc(filter), set, upsert: !!opts?.upsert });
    const found = this.docs.find((d) => matches(d, filter));
    if (found) Object.assign(found, set);
    else this.docs.push({ _id: newId(), ...cloneDoc(filter), ...set });
    return { acknowledged: true };
  }
  find(filter, proj) {
    const rows = this.docs.filter((d) => matches(d, filter)).map((d) => project(d, proj));
    return { lean: async () => rows };
  }
  findOne() {
    const self = this;
    let sortSpec = null;
    let selectSpec = null;
    const q = {
      sort(s) {
        sortSpec = s;
        return q;
      },
      select(s) {
        selectSpec = s;
        return q;
      },
      async lean() {
        let rows = self.docs.slice();
        if (sortSpec) {
          const [[key, dir]] = Object.entries(sortSpec);
          rows.sort((a, b) => {
            const x = sortValue(a[key]);
            const y = sortValue(b[key]);
            return x < y ? -dir : x > y ? dir : 0;
          });
        }
        const top = rows[0];
        return top ? project(top, selectSpec) : null;
      },
    };
    return q;
  }
  async bulkWrite(ops) {
    for (const op of ops) {
      const { filter, replacement, upsert } = op.replaceOne;
      this.ops.push({ op: "replaceOne", filter: cloneDoc(filter), replacement: cloneDoc(replacement), upsert });
      const i = this.docs.findIndex((d) => matches(d, filter));
      if (i >= 0) this.docs[i] = { _id: this.docs[i]._id, ...cloneDoc(replacement) };
      else if (upsert) this.docs.push({ _id: newId(), ...cloneDoc(replacement) });
    }
    return { ok: 1 };
  }
  async deleteMany(filter) {
    const keep = [];
    const deleted = [];
    for (const d of this.docs) (matches(d, filter) ? deleted : keep).push(d);
    this.docs = keep;
    this.ops.push({ op: "deleteMany", deleted: deleted.map((d) => d.symbol) });
    return { deletedCount: deleted.length };
  }
  async countDocuments(filter) {
    return this.docs.filter((d) => matches(d, filter)).length;
  }
}

export const HourlyPrice = new Model("hourlyprices");
export const StockFuture = new Model("stock_futures/current");
export const StockFutureArchive = new Model("stock_futures/archive");
export const SpreadDaily = new Model("spread_daily");
export const SpreadSummary = new Model("spread_summary");

export const flags = { nseFno: true, archive: true };
export const isNseFnoDbEnabled = () => flags.nseFno;
export const isArchiveDbEnabled = () => flags.archive;

export function resetAll() {
  for (const m of [HourlyPrice, StockFuture, StockFutureArchive, SpreadDaily, SpreadSummary]) m.reset();
  flags.nseFno = true;
  flags.archive = true;
}
