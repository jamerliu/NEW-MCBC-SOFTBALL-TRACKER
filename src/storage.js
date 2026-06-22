import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  const msg = `Supabase config missing at build time.\nURL seen: ${supabaseUrl || "(nothing)"}\nKey present: ${!!supabaseKey}`;
  // eslint-disable-next-line no-console
  console.error(msg);
  alert(msg);
}

const supabase = createClient(supabaseUrl || "https://missing-url.supabase.co", supabaseKey || "missing-key");

function reportError(action, error) {
  const msg = `Storage ${action} failed:\n${error?.message || error}\n\nConfigured URL: ${supabaseUrl || "(nothing)"}\nKey present: ${!!supabaseKey}`;
  // eslint-disable-next-line no-console
  console.error(msg, error);
  alert(msg);
}

/* This mirrors the window.storage.get/set/delete/list contract the app
   already expects from Claude artifacts, backed by a single Postgres table
   (see README.md for the table's SQL). Nothing in App.jsx needs to change. */
window.storage = {
  async get(key) {
    const { data, error } = await supabase.from("app_kv").select("value").eq("key", key).maybeSingle();
    if (error) { reportError("get", error); throw error; }
    if (!data) return null;
    return { key, value: data.value, shared: true };
  },

  async set(key, value) {
    const { error } = await supabase
      .from("app_kv")
      .upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) { reportError("set", error); throw error; }
    return { key, value, shared: true };
  },

  async delete(key) {
    const { error } = await supabase.from("app_kv").delete().eq("key", key);
    if (error) { reportError("delete", error); throw error; }
    return { key, deleted: true, shared: true };
  },

  async list(prefix = "") {
    const { data, error } = await supabase.from("app_kv").select("key").like("key", `${prefix}%`);
    if (error) { reportError("list", error); throw error; }
    return { keys: (data || []).map((r) => r.key), prefix, shared: true };
  },
};
