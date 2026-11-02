// In-memory stand-in for the parts of src/db.ts the registry and the broker routes use,
// with the MongoDB semantics the TypeScript relied on (single documents with _id
// "current", $set + $inc on upsert, lean reads, isDbEnabled gating). Dates come from
// Date.now so the generator's fake clock stamps them.
const state = { enabled: false, dhan: null, active: null };

export const __db = {
  reset(enabled, seed = {}) {
    state.enabled = enabled;
    state.dhan = seed.dhan_session ? { _id: "current", ...seed.dhan_session } : null;
    if (state.dhan && typeof state.dhan.login_at === "number") state.dhan.login_at = new Date(state.dhan.login_at);
    if (state.dhan && typeof state.dhan.updated_at === "number") state.dhan.updated_at = new Date(state.dhan.updated_at);
    state.active = seed.active_broker ? { _id: "current", ...seed.active_broker } : null;
    if (state.active && typeof state.active.selected_at === "number") state.active.selected_at = new Date(state.active.selected_at);
  },
  dump() {
    const dhan = state.dhan
      ? { ...state.dhan, login_at: state.dhan.login_at?.getTime?.() ?? null, updated_at: state.dhan.updated_at?.getTime?.() ?? null }
      : null;
    const active = state.active
      ? { ...state.active, selected_at: state.active.selected_at?.getTime?.() ?? null }
      : null;
    return { dhan_session: dhan, active_broker: active };
  },
};

export function isDbEnabled() {
  return state.enabled;
}

export async function saveDhanSession(data) {
  if (!state.enabled) return;
  const now = new Date(Date.now());
  state.dhan = { ...(state.dhan ?? {}), ...data, _id: "current", login_at: now, updated_at: now };
}

export async function loadDhanSession() {
  if (!state.enabled) return null;
  return state.dhan ? { ...state.dhan } : null;
}

export async function clearDhanSession() {
  if (!state.enabled) return;
  state.dhan = null;
}

export async function saveActiveBroker(broker, selectedBy) {
  if (!state.enabled) return null;
  const doc = state.active ?? { _id: "current" };
  doc.broker = broker;
  doc.selected_by = selectedBy;
  doc.selected_at = new Date(Date.now());
  doc.generation = (typeof doc.generation === "number" ? doc.generation : 0) + 1;
  state.active = doc;
  const generation = doc.generation;
  return typeof generation === "number" && Number.isFinite(generation) ? { generation } : null;
}

export async function loadActiveBroker() {
  if (!state.enabled) return null;
  const doc = state.active;
  if (!doc?.broker) return null;
  const generation = typeof doc.generation === "number" && Number.isFinite(doc.generation) ? doc.generation : 1;
  return { broker: doc.broker, generation };
}
