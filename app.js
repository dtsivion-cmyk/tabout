// ============================================================
// TabOut — Supabase-backed app
// ============================================================

const SUPABASE_URL = "https://szziktcdrzidgwoemdmq.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6emlrdGNkcnppZGd3b2VtZG1xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzMTcyMjcsImV4cCI6MjA5NTg5MzIyN30.dR6RhDeO5B4hZwMsxtBrPZNuW3DMUsUgTbKJfRgRG78";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const TAX_RATE = 0.08875;
const AVATAR_COLORS = ["mint", "coral", "gold"];

// ---------- state ----------
const state = {
  screen: "landing",
  user: null,          // { id, email, name }
  authMode: "signin",
  roomCode: null,
  room: null,          // cached: { code, name, host_id, tip_pct, split_mode, members[], items[] }
  channel: null,       // realtime subscription
};

const $ = (sel) => document.querySelector(sel);
const body = document.body;
const toast = $("#toast");

// ---------- toast ----------
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

const money = (v) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v || 0);

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- routing ----------
async function goto(screen) {
  state.screen = screen;
  body.dataset.screen = screen;
  document.querySelectorAll(".app-screen").forEach((el) => {
    el.hidden = el.id !== `screen-${screen}` && screen !== "landing";
  });
  $("#signOutButton").hidden = !state.user;

  if (screen !== "room") teardownRoomChannel();

  if (screen === "auth") renderAuth();
  if (screen === "lobby") await renderLobby();
  if (screen === "room") await enterRoom();

  window.scrollTo({ top: 0, behavior: "instant" });
}

document.querySelectorAll("[data-goto]").forEach((el) => {
  el.addEventListener("click", () => {
    const target = el.dataset.goto;
    if (target === "auth" && state.user) { goto("lobby"); return; }
    if (target === "lobby" && !state.user) { goto("auth"); return; }
    goto(target);
  });
});

// ============================================================
// AUTH
// ============================================================
const authForm = $("#authForm");
const authToggle = $("#authToggle");

function renderAuth() {
  const isSignup = state.authMode === "signup";
  document.querySelectorAll("[data-auth-title]").forEach(el => el.textContent = isSignup ? "Sign up" : "Sign in");
  document.querySelectorAll("[data-auth-sub]").forEach(el => el.textContent = isSignup
    ? "Create an account so your rooms come back next time."
    : "Use your email to get back into your rooms.");
  document.querySelectorAll("[data-auth-submit]").forEach(el => el.textContent = isSignup ? "Create account" : "Sign in");
  document.querySelectorAll("[data-auth-toggle-text]").forEach(el => el.textContent = isSignup ? "Already have an account?" : "New here?");
  document.querySelectorAll("[data-auth-toggle-action]").forEach(el => el.textContent = isSignup ? "Sign in instead" : "Create an account");
  document.querySelectorAll("[data-signup-only]").forEach(el => el.hidden = !isSignup);
  $("#authPassword").autocomplete = isSignup ? "new-password" : "current-password";
}

authToggle.addEventListener("click", () => {
  state.authMode = state.authMode === "signup" ? "signin" : "signup";
  renderAuth();
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#authEmail").value.trim().toLowerCase();
  const password = $("#authPassword").value;
  const name = $("#authName").value.trim();
  const submitBtn = authForm.querySelector("[data-auth-submit]");
  submitBtn.disabled = true;

  try {
    if (state.authMode === "signup") {
      if (!name) { showToast("Pick a display name"); return; }
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: { data: { name } },
      });
      if (error) { showToast(error.message); return; }
      if (!data.session) {
        showToast("Check your email to confirm your account");
        return;
      }
      await loadCurrentUser();
      showToast(`Welcome, ${name}`);
      authForm.reset();
      goto("lobby");
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) { showToast(error.message); return; }
      await loadCurrentUser();
      showToast(`Welcome back, ${state.user?.name || ""}`);
      authForm.reset();
      goto("lobby");
    }
  } finally {
    submitBtn.disabled = false;
  }
});

$("#signOutButton").addEventListener("click", async () => {
  teardownRoomChannel();
  await sb.auth.signOut();
  state.user = null;
  state.roomCode = null;
  state.room = null;
  showToast("Signed out");
  goto("landing");
});

async function loadCurrentUser() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { state.user = null; return; }
  // wait briefly for the profile trigger to fire on first sign-up
  for (let i = 0; i < 5; i++) {
    const { data: profile } = await sb.from("profiles").select("id, email, name").eq("id", user.id).maybeSingle();
    if (profile) { state.user = profile; return; }
    await new Promise(r => setTimeout(r, 250));
  }
  // fallback: try to insert it ourselves
  const fallbackName = user.user_metadata?.name || user.email.split("@")[0];
  await sb.from("profiles").upsert({ id: user.id, email: user.email, name: fallbackName });
  state.user = { id: user.id, email: user.email, name: fallbackName };
}

// ============================================================
// LOBBY
// ============================================================
async function renderLobby() {
  if (!state.user) { goto("auth"); return; }
  $("#lobbyGreeting").textContent = state.user.name;

  // fetch rooms this user belongs to (with member counts and item counts via joins)
  const { data: myMemberships, error } = await sb
    .from("room_members")
    .select("room_code, rooms ( code, name, host_id, created_at )")
    .eq("user_id", state.user.id);

  if (error) { console.error(error); }

  const rooms = (myMemberships || [])
    .map(m => m.rooms)
    .filter(Boolean)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // for each room, fetch member + item counts
  const counts = await Promise.all(rooms.map(async r => {
    const [{ count: mc }, { count: ic }] = await Promise.all([
      sb.from("room_members").select("*", { count: "exact", head: true }).eq("room_code", r.code),
      sb.from("items").select("*", { count: "exact", head: true }).eq("room_code", r.code),
    ]);
    return { mc: mc || 0, ic: ic || 0 };
  }));

  const list = $("#recentRoomsList");
  $("#recentRooms").hidden = rooms.length === 0;
  list.innerHTML = rooms.map((r, i) => `
    <button type="button" class="recent-room" data-room="${r.code}">
      <div>
        <strong>${escapeHtml(r.name)}</strong>
        <span>${counts[i].mc} ${counts[i].mc === 1 ? "member" : "members"} · ${counts[i].ic} items</span>
      </div>
      <b>${r.code}</b>
    </button>
  `).join("");
  list.querySelectorAll(".recent-room").forEach(el => {
    el.addEventListener("click", () => {
      state.roomCode = el.dataset.room;
      goto("room");
    });
  });
}

$("#createRoomForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#newRoomName").value.trim();
  if (!name) return;

  const code = await generateRoomCode();
  const { error: roomError } = await sb.from("rooms").insert({
    code,
    name,
    host_id: state.user.id,
    tip_pct: 20,
    split_mode: "claim",
  });
  if (roomError) { showToast(roomError.message); return; }

  const { error: memberError } = await sb.from("room_members").insert({
    room_code: code,
    user_id: state.user.id,
    custom_share: 100,
  });
  if (memberError) { showToast(memberError.message); return; }

  state.roomCode = code;
  $("#newRoomName").value = "";
  showToast(`Room ${code} opened`);
  goto("room");
});

$("#joinRoomForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("#joinRoomCode").value.trim();
  if (!/^\d{4}$/.test(code)) { showToast("Room code is 4 digits"); return; }

  // Force a fresh auth check — avoids RLS failures from a stale session.
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { showToast("Please sign in again"); goto("auth"); return; }

  const { data: room } = await sb.from("rooms").select("code").eq("code", code).maybeSingle();
  if (!room) { showToast("No room with that code"); return; }

  // Check if already a member; if so just open the room.
  const { data: existing } = await sb.from("room_members")
    .select("user_id")
    .eq("room_code", code)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!existing) {
    const { error } = await sb.from("room_members").insert({
      room_code: code,
      user_id: user.id,
      custom_share: 0,
    });
    if (error) { showToast(error.message); return; }
  }

  state.roomCode = code;
  $("#joinRoomCode").value = "";
  goto("room");
});

async function generateRoomCode() {
  for (let i = 0; i < 50; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const { data } = await sb.from("rooms").select("code").eq("code", code).maybeSingle();
    if (!data) return code;
  }
  return String(Date.now()).slice(-4);
}

// ============================================================
// ROOM
// ============================================================
async function enterRoom() {
  if (!state.user || !state.roomCode) { goto("lobby"); return; }
  await fetchRoom();
  if (!state.room) { goto("lobby"); return; }
  subscribeToRoom();
  renderRoom();
}

async function fetchRoom() {
  const code = state.roomCode;
  const [{ data: room, error: rErr }, { data: members }, { data: items }, { data: claims }] = await Promise.all([
    sb.from("rooms").select("*").eq("code", code).maybeSingle(),
    sb.from("room_members").select("user_id, custom_share, joined_at, profiles ( id, email, name )").eq("room_code", code),
    sb.from("items").select("id, name, price, added_by, created_at").eq("room_code", code).order("created_at"),
    sb.from("claims").select("item_id, user_id"),
  ]);

  if (rErr || !room) { state.room = null; return; }

  const memberList = (members || [])
    .map(m => ({
      id: m.profiles?.id || m.user_id,
      email: m.profiles?.email || "",
      name: m.profiles?.name || "Member",
      custom_share: m.custom_share,
      joined_at: m.joined_at,
    }))
    .sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at));

  const claimsByItem = {};
  (claims || []).forEach(c => {
    (claimsByItem[c.item_id] ||= []).push(c.user_id);
  });

  state.room = {
    code: room.code,
    name: room.name,
    host_id: room.host_id,
    tip_pct: room.tip_pct,
    split_mode: room.split_mode,
    members: memberList,
    items: (items || []).map(i => ({
      ...i,
      claimers: claimsByItem[i.id] || [],
    })),
  };
}

function subscribeToRoom() {
  teardownRoomChannel();
  const code = state.roomCode;
  state.channel = sb.channel(`room:${code}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `code=eq.${code}` }, refreshRoom)
    .on("postgres_changes", { event: "*", schema: "public", table: "room_members", filter: `room_code=eq.${code}` }, refreshRoom)
    .on("postgres_changes", { event: "*", schema: "public", table: "items", filter: `room_code=eq.${code}` }, refreshRoom)
    .on("postgres_changes", { event: "*", schema: "public", table: "claims" }, refreshRoom)
    .subscribe();
}

function teardownRoomChannel() {
  if (state.channel) {
    sb.removeChannel(state.channel);
    state.channel = null;
  }
}

let refreshTimer = null;
async function refreshRoom() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (state.screen !== "room") return;
    await fetchRoom();
    if (!state.room) { goto("lobby"); return; }
    renderRoom();
  }, 120);
}

// ---------- render helpers ----------
function isHost() {
  return state.room && state.user && state.room.host_id === state.user.id;
}
function memberById(id) {
  return state.room?.members.find(m => m.id === id);
}
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < (str || "").length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}
function avatarFor(member) {
  const idx = member ? Math.abs(hashCode(member.id)) % AVATAR_COLORS.length : 0;
  return { color: AVATAR_COLORS[idx], initial: (member?.name || "?").charAt(0).toUpperCase() };
}

function renderRoom() {
  const room = state.room;
  if (!room) return;

  $("#roomCode").textContent = room.code;
  $("#roomNameLabel").textContent = room.name;

  const host = memberById(room.host_id);
  const hostAvatar = avatarFor(host);
  $("#hostAvatar").textContent = hostAvatar.initial;
  $("#hostAvatar").className = `host-avatar ${hostAvatar.color}`;
  $("#hostName").textContent = host?.name || "—";
  $("#roomStatus").textContent = `${room.members.length} ${room.members.length === 1 ? "guest" : "guests"} synced`;

  $("#guestList").innerHTML = room.members.map(m => {
    const a = avatarFor(m);
    const me = m.id === state.user.id ? " (you)" : "";
    const hostBadge = m.id === room.host_id ? " ★" : "";
    return `<span class="guest is-active"><span class="${a.color}">${a.initial}</span>${escapeHtml(m.name)}${me}${hostBadge}</span>`;
  }).join("");

  document.querySelectorAll("[data-split]").forEach(btn => {
    btn.classList.toggle("is-active", btn.dataset.split === room.split_mode);
  });

  const hostOnly = isHost();
  const tip = $("#tipRange");
  tip.value = room.tip_pct;
  tip.disabled = !hostOnly;
  tip.closest(".tip-control").classList.toggle("is-locked", !hostOnly);
  $("#tipLabel").textContent = `${room.tip_pct}%`;

  $("#roleCard").innerHTML = `
    <div>
      <span class="label">${hostOnly ? "Host controls" : "Guest controls"}</span>
      <h3>${hostOnly ? "You're hosting this table" : `${host?.name || "The host"} is paying tonight`}</h3>
      <p>${hostOnly
        ? "Edit any item, set the tip, and the room rolls up to your total."
        : `Add what you ordered, claim items, or split evenly. Pay ${host?.name || "the host"} when you're done.`}</p>
    </div>
    <strong>${describeSplitMode(room.split_mode)}</strong>
  `;

  renderItems();
  renderCustomSplit();
  renderTotals();
}

function describeSplitMode(mode) {
  return mode === "even" ? "Splitting the bill evenly across everyone."
    : mode === "custom" ? "Each person pays their custom percentage."
    : "Each person pays for the items they claimed.";
}

function renderItems() {
  const room = state.room;
  const container = $("#receiptItems");
  if (!room.items.length) {
    container.innerHTML = `<p class="empty-state">No items yet. Add the first one above.</p>`;
    return;
  }

  container.innerHTML = room.items.map(item => {
    const claimers = item.claimers.map(id => memberById(id)).filter(Boolean);
    const claimerHtml = claimers.length
      ? claimers.map(m => {
          const a = avatarFor(m);
          return `<i class="${a.color}" title="${escapeHtml(m.name)}">${a.initial}</i>`;
        }).join("")
      : `<span class="empty-claim">Unclaimed</span>`;

    const isMine = item.claimers.includes(state.user.id);
    const addedBy = memberById(item.added_by)?.name || "someone";
    const canDelete = isHost() || item.added_by === state.user.id;

    return `
      <div class="receipt-item ${isMine ? "is-claimed" : ""}" data-item="${item.id}">
        <button class="item-toggle" type="button" data-action="claim" aria-pressed="${isMine}">
          <span>
            ${escapeHtml(item.name)}
            <small class="item-meta">${item.claimers.length} claimed · added by ${escapeHtml(addedBy)}</small>
          </span>
          <b>${money(item.price)}</b>
          <span class="claimers">${claimerHtml}</span>
        </button>
        ${canDelete ? `<button class="item-discard" type="button" data-action="discard" aria-label="Discard ${escapeHtml(item.name)}">×</button>` : ""}
      </div>
    `;
  }).join("");
}

function renderCustomSplit() {
  const room = state.room;
  const wrap = $("#customSplit");
  wrap.hidden = room.split_mode !== "custom";
  if (wrap.hidden) return;
  const rows = $("#customSplitRows");
  const canEdit = isHost();
  rows.innerHTML = room.members.map(m => {
    const a = avatarFor(m);
    return `
      <label class="custom-split-row">
        <span class="${a.color} avatar-dot">${a.initial}</span>
        <span class="custom-split-name">${escapeHtml(m.name)}</span>
        <input type="number" min="0" max="100" step="1" value="${m.custom_share}" data-share-user="${m.id}" ${canEdit ? "" : "disabled"} />
        <span>%</span>
      </label>
    `;
  }).join("");
  const total = room.members.reduce((s, m) => s + Number(m.custom_share || 0), 0);
  const el = $("#customSplitTotal");
  el.textContent = `${total}%`;
  el.classList.toggle("is-off", total !== 100);
}

function renderTotals() {
  const room = state.room;
  const subtotal = room.items.reduce((s, i) => s + Number(i.price), 0);
  const tax = subtotal * TAX_RATE;
  const tip = subtotal * (room.tip_pct / 100);
  const total = subtotal + tax + tip;

  $("#subtotalValue").textContent = money(subtotal);
  $("#taxValue").textContent = money(tax);
  $("#tipValue").textContent = money(tip);
  $("#totalValue").textContent = money(total);

  const shares = computeShares(subtotal, tax, tip);
  $("#sharesBreakdown").innerHTML = room.members.map(m => {
    const a = avatarFor(m);
    const v = shares[m.id] || 0;
    const me = m.id === state.user.id ? " (you)" : "";
    return `
      <div class="share-row ${m.id === state.user.id ? "is-you" : ""}">
        <span class="${a.color} avatar-dot">${a.initial}</span>
        <span>${escapeHtml(m.name)}${me}</span>
        <b>${money(v)}</b>
      </div>
    `;
  }).join("");

  const mine = shares[state.user.id] || 0;
  $("#yourShare").textContent = money(mine);
  $("#summaryLabel").textContent = isHost() ? "Your share (host)" : "Your share";
  const host = memberById(room.host_id);
  $("#payButton").textContent = isHost() ? "Mark settled" : `Pay ${host?.name || "host"}`;
}

function computeShares(subtotal, tax, tip) {
  const room = state.room;
  const shares = Object.fromEntries(room.members.map(m => [m.id, 0]));
  const extras = tax + tip;

  if (room.split_mode === "even") {
    const per = (subtotal + extras) / Math.max(room.members.length, 1);
    room.members.forEach(m => { shares[m.id] = per; });
    return shares;
  }
  if (room.split_mode === "custom") {
    const totalAll = subtotal + extras;
    const sum = room.members.reduce((a, m) => a + Number(m.custom_share || 0), 0) || 100;
    room.members.forEach(m => { shares[m.id] = totalAll * (Number(m.custom_share || 0) / sum); });
    return shares;
  }
  // claim mode
  room.items.forEach(item => {
    if (!item.claimers.length) return;
    const each = Number(item.price) / item.claimers.length;
    item.claimers.forEach(uid => { if (shares[uid] != null) shares[uid] += each; });
  });
  const claimedSubtotal = Object.values(shares).reduce((a, b) => a + b, 0);
  if (claimedSubtotal > 0) {
    room.members.forEach(m => {
      shares[m.id] += extras * (shares[m.id] / claimedSubtotal);
    });
  }
  return shares;
}

// ---------- room interactions ----------
$("#mealForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const room = state.room;
  if (!room) return;
  const name = $("#mealName").value.trim();
  const price = Number($("#mealPrice").value);
  if (!name || !(price > 0)) { showToast("Add a name and price"); return; }

  const { data: item, error } = await sb.from("items").insert({
    room_code: room.code,
    name,
    price,
    added_by: state.user.id,
  }).select().single();
  if (error) { showToast(error.message); return; }

  await sb.from("claims").insert({ item_id: item.id, user_id: state.user.id });
  $("#mealForm").reset();
  showToast(`Added ${name}`);
  // realtime will refresh; also refresh now for instant feedback
  refreshRoom();
});

$("#receiptItems").addEventListener("click", async (e) => {
  const room = state.room;
  if (!room) return;
  const itemEl = e.target.closest(".receipt-item");
  if (!itemEl) return;
  const itemId = itemEl.dataset.item;
  const item = room.items.find(i => i.id === itemId);
  if (!item) return;

  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "discard") {
    if (!(isHost() || item.added_by === state.user.id)) return;
    const { error } = await sb.from("items").delete().eq("id", itemId);
    if (error) { showToast(error.message); return; }
    showToast(`Discarded ${item.name}`);
    refreshRoom();
    return;
  }
  if (action === "claim") {
    const claimed = item.claimers.includes(state.user.id);
    const { error } = claimed
      ? await sb.from("claims").delete().eq("item_id", itemId).eq("user_id", state.user.id)
      : await sb.from("claims").insert({ item_id: itemId, user_id: state.user.id });
    if (error) { showToast(error.message); return; }
    refreshRoom();
  }
});

$("#tipRange").addEventListener("input", () => {
  const room = state.room;
  if (!room || !isHost()) return;
  const v = Number($("#tipRange").value);
  $("#tipLabel").textContent = `${v}%`;
  room.tip_pct = v;
  renderTotals();
  saveTip(v);
});

let tipSaveTimer = null;
function saveTip(v) {
  clearTimeout(tipSaveTimer);
  tipSaveTimer = setTimeout(async () => {
    await sb.from("rooms").update({ tip_pct: v }).eq("code", state.roomCode);
  }, 300);
}

document.querySelectorAll("[data-split]").forEach(btn => {
  btn.addEventListener("click", async () => {
    const room = state.room;
    if (!room) return;
    const mode = btn.dataset.split;
    if (!isHost()) { showToast("Only the host can change the split mode"); return; }
    const { error } = await sb.from("rooms").update({ split_mode: mode }).eq("code", room.code);
    if (error) { showToast(error.message); return; }
    refreshRoom();
  });
});

$("#customSplit").addEventListener("input", async (e) => {
  const room = state.room;
  if (!room || !isHost()) return;
  const userId = e.target.dataset.shareUser;
  if (!userId) return;
  const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
  const m = room.members.find(x => x.id === userId);
  if (m) { m.custom_share = v; renderTotals(); }
  clearTimeout(e.target._t);
  e.target._t = setTimeout(async () => {
    await sb.from("room_members").update({ custom_share: v }).eq("room_code", room.code).eq("user_id", userId);
  }, 300);
});

$("#copyRoom").addEventListener("click", async () => {
  if (!state.room) return;
  const invite = `Join my TabOut room — code ${state.room.code}`;
  try { await navigator.clipboard.writeText(invite); showToast("Invite copied"); }
  catch { showToast(invite); }
});

$("#payButton").addEventListener("click", () => {
  if (!state.room) return;
  const host = memberById(state.room.host_id);
  showToast(isHost() ? "Dinner marked settled" : `Payment to ${host?.name || "host"} ready`);
});

// ============================================================
// boot
// ============================================================
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    await loadCurrentUser();
  }
  sb.auth.onAuthStateChange((event, sess) => {
    if (event === "SIGNED_OUT") {
      state.user = null;
      state.roomCode = null;
      state.room = null;
      goto("landing");
    }
  });
  goto(state.user ? "lobby" : "landing");
}

boot().catch(err => {
  console.error(err);
  showToast("Couldn't start the app — check the console");
});
