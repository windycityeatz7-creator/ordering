// Thin wrapper around the Supabase client: connection, data access helpers,
// and realtime subscription wiring. Exposes everything on window.WCE.db
(function () {
  const cfg = window.__WCE_CONFIG__ || {};
  const url = cfg.SUPABASE_URL;
  const key = cfg.SUPABASE_ANON_KEY;

  let client = null;
  if (url && key && window.supabase) {
    client = window.supabase.createClient(url, key);
  }

  async function fetchConfig() {
    if (!client) throw new Error("Supabase is not configured.");
    const { data, error } = await client
      .from("config")
      .select("*")
      .eq("id", 1)
      .single();
    if (error) throw error;
    return data;
  }

  async function saveConfig(patch) {
    if (!client) throw new Error("Supabase is not configured.");
    const { data, error } = await client
      .from("config")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", 1)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async function fetchOrders() {
    if (!client) throw new Error("Supabase is not configured.");
    const { data, error } = await client
      .from("orders")
      .select("*")
      .order("date", { ascending: false });
    if (error) throw error;
    return data;
  }

  async function insertOrders(rows) {
    if (!client) throw new Error("Supabase is not configured.");
    const { data, error } = await client.from("orders").insert(rows).select();
    if (error) throw error;
    return data;
  }

  async function updateOrderById(id, patch) {
    if (!client) throw new Error("Supabase is not configured.");
    const { data, error } = await client
      .from("orders")
      .update(patch)
      .eq("id", id)
      .select();
    if (error) throw error;
    return data;
  }

  async function updateOrdersByIds(ids, patch) {
    if (!client) throw new Error("Supabase is not configured.");
    const { data, error } = await client
      .from("orders")
      .update(patch)
      .in("id", ids)
      .select();
    if (error) throw error;
    return data;
  }

  function subscribeRealtime({ onOrdersChange, onConfigChange, onStatus }) {
    if (!client) {
      onStatus && onStatus("red");
      return { unsubscribe() {} };
    }

    const channel = client
      .channel("wce-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "orders" },
        (payload) => onOrdersChange && onOrdersChange(payload)
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "config" },
        (payload) => onConfigChange && onConfigChange(payload)
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          onStatus && onStatus("green");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          onStatus && onStatus("red");
        } else if (status === "CLOSED") {
          onStatus && onStatus("red");
        } else {
          onStatus && onStatus("yellow");
        }
      });

    return channel;
  }

  window.WCE = window.WCE || {};
  window.WCE.db = {
    isConfigured: !!client,
    fetchConfig,
    saveConfig,
    fetchOrders,
    insertOrders,
    updateOrderById,
    updateOrdersByIds,
    subscribeRealtime,
  };
})();
