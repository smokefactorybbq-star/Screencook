// index.js (ESM) — KITCHEN PRO (TV FIX + DEBUG)
// ТВ-экран: / (или /screen)
// API: /api/orders
// Webhook: /tg/<WEBHOOK_SECRET>

import express from "express";
import http from "http";
import crypto from "crypto";
import { Telegraf, Markup, session } from "telegraf";

// ==========================
// ENV
// ==========================
const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");
if (!PUBLIC_URL) throw new Error("PUBLIC_URL is not set");
if (!WEBHOOK_SECRET) throw new Error("WEBHOOK_SECRET is not set");

const MANAGER_IDS = (process.env.MANAGER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => Number.isFinite(n));

// ==========================
// BOT UI
// ==========================
const BTN_NEW = "🧾 Новый заказ";
const BTN_SEND = "✅ Отправить на ТВ";
const BTN_CLEAR = "🧹 Очистить";
const BTN_EDIT = "✏️ Изменить №/время";
const BTN_REMOVE_MODE = "➖ Убрать позицию";
const BTN_BACK_CATS = "⬅️ Категории";

// ==========================
// MENU by categories — замени под себя
// ==========================
const CATEGORIES = [
  { key: "soups", label: "🍲 Супы" },
  { key: "mains", label: "🍛 Основные блюда" },
  { key: "sides", label: "🍟 Дополнительные блюда" },
  { key: "grill", label: "🔥 Гриль" },
  { key: "salads", label: "🥗 Салаты" },
];

const MENU_BY_CAT = {
  soups: ["Борщ", "Солянка", "Щи", "Харчо", "Минестроне", "Грибной суп", "Куриный суп", "Гороховый суп"],
  mains: ["Пельмени", "Болоньезе", "Макароны по-флотски", "Овощное рагу", "Гуляш", "Плов", "Тушёнка"],
  sides: ["Пюре", "Рис", "Гречка", "Лапша", "Картошка тушёная", "Капуста тушёная", "Хлеб", "Соус BBQ", "Соус чесночный", "Соус острый"],
  grill: ["Рёбра BBQ", "Курица гриль", "Шашлык куриный", "Колбаски", "Сосиски"],
  salads: ["Салат", "Огурец свежий", "Кимчи", "Морковь по-корейски"],
};

// ==========================
// ORDERS memory (up to 10)
// ==========================
let orders = [];

function pruneOrders() {
  const now = Date.now();
  orders = orders.filter((o) => o.expiresAt > now);
  orders.sort((a, b) => b.createdAt - a.createdAt);
  orders = orders.slice(0, 10);
}

function addKitchenOrder({ orderNo, prepMinutes }) {
  const createdAt = Date.now();
  const endsAt = createdAt + prepMinutes * 60_000;
  const expiresAt = endsAt + 5 * 60_000;

  const o = {
    id: crypto.randomUUID(),
    orderNo,
    prepMinutes,
    createdAt,
    endsAt,
    expiresAt,
    items: [],
  };
  orders.unshift(o);
  pruneOrders();
  return o.id;
}

function updateKitchenOrderItems(orderId, items) {
  const idx = orders.findIndex((o) => o.id === orderId);
  if (idx === -1) return false;
  orders[idx].items = Array.isArray(items) ? items : [];
  pruneOrders();
  return true;
}

function deleteKitchenOrder(orderId) {
  if (!orderId) return;
  orders = orders.filter((o) => o.id !== orderId);
  pruneOrders();
}

// ==========================
// SERVER
// ==========================
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/orders", (_req, res) => {
  pruneOrders();
  res.setHeader("Cache-Control", "no-store");
  res.json(orders);
});

// (для диагностики на ТВ)
app.get("/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  pruneOrders();
  res.json({ ok: true, orders: orders.length, time: Date.now() });
});

function screenHtml() {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Kitchen PRO</title>
  <style>
    :root{
      --bg:#050813;
      --cell:#0f1730;
      --border:rgba(255,255,255,.10);
      --text:#ffffff;

      --green:#00ff66;
      --yellow:#ffd400;
      --red:#ff3b30;
      --ready:#aab2c2;

      --gap: 10px;
      --cols: 5;
      --rows: 4;

      --safe: 40px;
    }
    *{ box-sizing:border-box; }
    html, body { height:100%; width:100%; }
    body{
      margin:0;
      background:var(--bg);
      color:var(--text);
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
      overflow:hidden;
    }

    /* ✅ ВАЖНО: stage гарантированно имеет высоту/ширину на ТВ */
    .stage{
      position:fixed;
      left: var(--safe);
      right: var(--safe);
      top: var(--safe);
      bottom: var(--safe);
      overflow:hidden;
    }

    .grid{
      width: 100%;
      height: 100%;
      display:grid;
      grid-template-columns: repeat(var(--cols), 1fr);
      grid-template-rows: repeat(var(--rows), 1fr);
      gap: var(--gap);
    }

    .card{
      background:var(--cell);
      border:1px solid var(--border);
      border-radius:18px;
      overflow:hidden;
      display:flex;
      flex-direction:column;
      min-width:0;
      min-height:0;
      box-shadow:0 12px 30px rgba(0,0,0,.35);
      position:relative;
    }

    .top{
      flex: 0 0 auto;
      padding: .95em 1.1em .6em;
      border-bottom:1px solid rgba(255,255,255,.10);
      display:flex;
      align-items:flex-end;
      justify-content:space-between;
      gap: 1em;
      min-height:0;
    }
    .orderNo, .remain{
      font-weight:1000;
      letter-spacing:.3px;
      line-height:1;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      min-width:0;
    }
    .orderNo{ flex: 1 1 auto; text-align:left; }
    .remain{ flex: 0 0 auto; text-align:right; }

    .items{
      flex: 1 1 auto;
      padding: 1em 1.1em 1.1em;
      overflow:hidden;
      display:flex;
      flex-direction:column;
      gap: .45em;
      min-height:0;
    }

    .item{
      display:flex;
      align-items:center;
      gap: .6em;
      padding: .55em .75em;
      border:1px solid rgba(255,255,255,.09);
      border-radius: .9em;
      background:rgba(255,255,255,.03);
      min-width:0;
    }
    .name{
      flex: 1 1 auto;
      min-width:0;
      font-weight:950;
      line-height:1.12;
      white-space:normal;
      word-break:break-word;
      display:-webkit-box;
      -webkit-line-clamp:2;
      -webkit-box-orient:vertical;
      overflow:hidden;
    }
    .qty{
      flex:0 0 auto;
      white-space:nowrap;
      color:rgba(255,255,255,.75);
      font-weight:1000;
    }

    .placeholder{
      height:100%;
      display:flex;
      align-items:center;
      justify-content:center;
      color:rgba(255,255,255,.35);
      font-weight:950;
      text-align:center;
      padding: 1em;
      font-size: 28px;
    }

    /* ERROR overlay */
    .error{
      height:100%;
      display:flex;
      align-items:center;
      justify-content:center;
      color:#fff;
      font-weight:1000;
      text-align:center;
      padding: 1em;
      font-size: 22px;
      background: rgba(255,0,0,.12);
      border: 2px solid rgba(255,0,0,.35);
      border-radius: 18px;
      white-space: pre-wrap;
    }

    .blink{
      animation: blink 0.9s steps(2, end) infinite;
    }
    @keyframes blink{
      0%{ filter: brightness(1); }
      50%{ filter: brightness(1.6); }
      100%{ filter: brightness(1); }
    }

    /* Панель управления */
    .panel{
      position:fixed;
      right: 10px;
      bottom: 10px;
      display:flex;
      gap:8px;
      z-index:9999;
      opacity:.82;
      user-select:none;
    }
    .btn{
      font-size:14px;
      font-weight:900;
      padding:10px 12px;
      border-radius:12px;
      border:1px solid rgba(255,255,255,.15);
      background: rgba(15,23,48,.78);
      color:#fff;
      cursor:pointer;
    }

    .dbg{
      position:fixed;
      left: 10px;
      bottom: 10px;
      z-index:9999;
      font-size:12px;
      font-weight:900;
      color:rgba(255,255,255,.70);
      background: rgba(0,0,0,.25);
      border: 1px solid rgba(255,255,255,.12);
      padding: 8px 10px;
      border-radius: 12px;
      max-width: 55vw;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div class="stage">
    <div class="grid" id="grid"></div>
  </div>

  <div class="panel">
    <button class="btn" id="safeMinus">SAFE-</button>
    <button class="btn" id="safePlus">SAFE+</button>
    <button class="btn" id="soundBtn">SOUND</button>
    <button class="btn" id="reloadBtn">RELOAD</button>
  </div>
  <div class="dbg" id="dbg">BOOT…</div>

<script>
  const grid = document.getElementById('grid');
  const dbg = document.getElementById('dbg');

  const COLS = 5;
  const ROWS = 4;
  const MAX_ORDERS = 10;

  // settings persist
  const LS_SAFE = 'kitchen_safe';
  const LS_SOUND = 'kitchen_sound';

  let soundEnabled = (localStorage.getItem(LS_SOUND) ?? 'on') === 'on';

  function getSafe(){
    const v = Number(localStorage.getItem(LS_SAFE));
    return Number.isFinite(v) ? v : 40;
  }
  function setSafe(v){
    localStorage.setItem(LS_SAFE, String(v));
    document.documentElement.style.setProperty('--safe', v + 'px');
    dbg.textContent = dbg.textContent.replace(/SAFE:\\s*\\d+px/g, 'SAFE: ' + v + 'px');
  }
  function setSound(on){
    soundEnabled = !!on;
    localStorage.setItem(LS_SOUND, soundEnabled ? 'on' : 'off');
  }

  // apply stored
  setSafe(getSafe());
  setSound(soundEnabled);

  document.getElementById('safePlus').onclick = () => setSafe(Math.min(140, getSafe() + 5));
  document.getElementById('safeMinus').onclick = () => setSafe(Math.max(0, getSafe() - 5));
  document.getElementById('soundBtn').onclick = async () => {
    setSound(!soundEnabled);
    if (soundEnabled) { try { await beep(0.02, 880); } catch{} }
  };
  document.getElementById('reloadBtn').onclick = () => location.reload();

  function fmt2(n){ return String(n).padStart(2,'0'); }
  function mmss(ms){
    const s = Math.max(0, Math.floor(ms/1000));
    const m = Math.floor(s/60);
    const ss = s%60;
    return m + ":" + fmt2(ss);
  }
  function esc(s){ return String(s||'').replace(/</g,'&lt;'); }

  function remainColor(remMin){
    if (remMin <= 0) return 'var(--ready)';
    if (remMin <= 10) return 'var(--red)';
    if (remMin <= 25) return 'var(--yellow)';
    return 'var(--green)';
  }

  // WebAudio beep
  let audioCtx = null;
  async function beep(duration=0.08, freq=880){
    if (!soundEnabled) return;
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.value = 0.02;
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + duration);
  }

  function fitText(el, maxPx, minPx){
    if (!el) return;
    let size = maxPx;
    el.style.fontSize = size + 'px';
    while (size > minPx && (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight)){
      size -= 1;
      el.style.fontSize = size + 'px';
    }
  }
  function fitItems(container, maxPx, minPx){
    if (!container) return;
    let size = maxPx;
    container.style.fontSize = size + 'px';
    container.style.lineHeight = "1.10";
    while (size > minPx && container.scrollHeight > container.clientHeight){
      size -= 1;
      container.style.fontSize = size + 'px';
    }
  }

  function spanFor(itemsCount){
    if (itemsCount >= 12) return 3;
    if (itemsCount >= 6) return 2;
    return 1;
  }

  function placeCards(cards){
    const occ = Array.from({length: ROWS}, () => Array(COLS).fill(false));
    const placed = [];

    function canPlace(r, c, span){
      if (r + span > ROWS) return false;
      for (let rr = r; rr < r + span; rr++){
        if (occ[rr][c]) return false;
      }
      return true;
    }
    function doPlace(r, c, span, card){
      for (let rr = r; rr < r + span; rr++) occ[rr][c] = true;
      placed.push({ ...card, r, c, span });
    }

    for (const card of cards){
      for (let trySpan = card.span; trySpan >= 1; trySpan--){
        let done = false;
        for (let r=0; r<ROWS; r++){
          for (let c=0; c<COLS; c++){
            if (canPlace(r,c,trySpan)){
              doPlace(r,c,trySpan, card);
              done = true;
              break;
            }
          }
          if (done) break;
        }
        if (done) break;
      }
    }
    return placed;
  }

  const readyBeeped = new Set();

  function render(list){
    grid.innerHTML = "";

    if (!Array.isArray(list) || list.length === 0){
      const box = document.createElement('div');
      box.className = 'placeholder';
      box.textContent = 'Нет заказов';
      grid.appendChild(box);
      return;
    }

    const now = Date.now();
    const cards = list.slice(0, MAX_ORDERS).map(o => {
      const items = Array.isArray(o.items) ? o.items : [];
      return { o, span: spanFor(items.length) };
    });

    const placed = placeCards(cards);

    for (const p of placed){
      const o = p.o;
      const remMs = (o.endsAt || 0) - now;
      const remMin = remMs / 60000;
      const color = remainColor(remMin);
      const timerText = (remMs <= 0) ? 'READY' : mmss(remMs);

      const items = Array.isArray(o.items) ? o.items : [];

      let itemsHtml = '';
      if (items.length){
        itemsHtml = items.map(it => {
          const name = esc(it.name);
          const qty = Number(it.qty || 0);
          return \`<div class="item"><div class="name">\${name}</div><div class="qty">x\${qty}</div></div>\`;
        }).join('');
      } else {
        itemsHtml = '<div class="placeholder" style="font-size:18px">Выбор блюд…</div>';
      }

      const card = document.createElement('div');
      card.className = 'card';
      if (remMs > 0 && remMs <= 5*60*1000) card.classList.add('blink');

      card.style.gridColumn = (p.c + 1) + ' / span 1';
      card.style.gridRow = (p.r + 1) + ' / span ' + p.span;

      card.innerHTML = \`
        <div class="top">
          <div class="orderNo" data-fit="order">\${esc(o.orderNo || '—')}</div>
          <div class="remain" data-fit="remain" style="color:\${color}">\${timerText}</div>
        </div>
        <div class="items" data-fit="items">\${itemsHtml}</div>
      \`;

      grid.appendChild(card);

      if (remMs <= 0 && !readyBeeped.has(o.id)){
        readyBeeped.add(o.id);
        beep(0.07, 880);
        setTimeout(() => beep(0.07, 660), 120);
      }
    }

    requestAnimationFrame(() => {
      grid.querySelectorAll('[data-fit="order"]').forEach(el => fitText(el, 40, 11));
      grid.querySelectorAll('[data-fit="remain"]').forEach(el => fitText(el, 36, 11));
      grid.querySelectorAll('[data-fit="items"]').forEach(box => fitItems(box, 24, 8));
    });
  }

  function showError(msg){
    grid.innerHTML = "";
    const e = document.createElement('div');
    e.className = 'error';
    e.textContent = msg;
    grid.appendChild(e);
  }

  async function tick(){
    try{
      const r = await fetch('/api/orders', { cache:'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();

      dbg.textContent =
        'API: OK\\n' +
        'ORDERS: ' + (Array.isArray(j) ? j.length : '?') + '\\n' +
        'SAFE: ' + getSafe() + 'px\\n' +
        'SOUND: ' + (soundEnabled ? 'ON' : 'OFF');

      render(j);
    } catch (e){
      dbg.textContent =
        'API: ERROR\\n' +
        String(e && e.message ? e.message : e) + '\\n' +
        'SAFE: ' + getSafe() + 'px\\n' +
        'Tip: open /api/orders';
      showError('ОШИБКА ЗАГРУЗКИ /api/orders\\n\\n' + (e && e.message ? e.message : String(e)));
    }
  }

  tick();
  setInterval(tick, 1000);
  window.addEventListener('resize', () => tick());
</script>
</body>
</html>`;
}

app.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(screenHtml());
});
app.get("/screen", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(screenHtml());
});

// ==========================
// BOT
// ==========================
const bot = new Telegraf(BOT_TOKEN);
bot.catch((err) => console.error("BOT ERROR:", err));
bot.use(session());
bot.use((ctx, next) => {
  if (!ctx.session) ctx.session = {};
  return next();
});

function isAllowed(ctx) {
  if (!MANAGER_IDS.length) return true;
  const id = ctx.from?.id;
  return !!id && MANAGER_IDS.includes(id);
}
async function deny(ctx) {
  if (!isAllowed(ctx)) {
    await ctx.reply("⛔️ Нет доступа.");
    return true;
  }
  return false;
}

function getState(ctx) {
  if (!ctx.session.state) {
    ctx.session.state = {
      step: "idle",
      orderNo: "",
      prepMinutes: 25,
      cart: {},
      cat: null,
      orderId: null,
    };
  }
  return ctx.session.state;
}

function mainKeyboard() {
  return Markup.keyboard([[BTN_NEW]]).resize().oneTime(false);
}

function cartSummary(cart) {
  const entries = Object.entries(cart);
  if (!entries.length) return "— пусто —";
  return entries.map(([name, qty]) => `• ${name}    x${qty}`).join("\n");
}

function categoriesKeyboard() {
  const rows = [];
  for (let i = 0; i < CATEGORIES.length; i += 2) {
    const a = CATEGORIES[i];
    const b = CATEGORIES[i + 1];
    const row = [Markup.button.callback(a.label, `cat:${a.key}`)];
    if (b) row.push(Markup.button.callback(b.label, `cat:${b.key}`));
    rows.push(row);
  }
  rows.push([Markup.button.callback(BTN_CLEAR, "clear"), Markup.button.callback(BTN_SEND, "send")]);
  rows.push([Markup.button.callback(BTN_EDIT, "edit"), Markup.button.callback(BTN_REMOVE_MODE, "remove_mode")]);
  return Markup.inlineKeyboard(rows);
}

function dishesKeyboard(catKey) {
  const dishes = MENU_BY_CAT[catKey] || [];
  const rows = [];

  for (let i = 0; i < dishes.length; i += 2) {
    const a = dishes[i];
    const b = dishes[i + 1];
    const row = [Markup.button.callback(`➕ ${a}`, `add:${a}`)];
    if (b) row.push(Markup.button.callback(`➕ ${b}`, `add:${b}`));
    rows.push(row);
  }

  rows.push([Markup.button.callback(BTN_BACK_CATS, "cats"), Markup.button.callback(BTN_CLEAR, "clear")]);
  rows.push([Markup.button.callback(BTN_SEND, "send"), Markup.button.callback(BTN_REMOVE_MODE, "remove_mode")]);
  rows.push([Markup.button.callback(BTN_EDIT, "edit")]);

  return Markup.inlineKeyboard(rows);
}

async function showCategories(ctx) {
  const st = getState(ctx);
  const text =
`🧾 Создание заказа

Номер: ${st.orderNo || "—"}
Время: ${st.prepMinutes} мин

Корзина:
${cartSummary(st.cart)}

Выбери категорию:`;

  if (ctx.updateType === "callback_query") {
    try { await ctx.editMessageText(text, categoriesKeyboard()); }
    catch { await ctx.reply(text, categoriesKeyboard()); }
  } else {
    await ctx.reply(text, categoriesKeyboard());
  }
}

async function showDishes(ctx, catKey) {
  const st = getState(ctx);
  st.cat = catKey;
  const catLabel = CATEGORIES.find(c => c.key === catKey)?.label || catKey;

  const text =
`📂 ${catLabel}

Номер: ${st.orderNo || "—"} | Время: ${st.prepMinutes} мин

Корзина:
${cartSummary(st.cart)}

Нажимай блюда (➕):`;

  if (ctx.updateType === "callback_query") {
    try { await ctx.editMessageText(text, dishesKeyboard(catKey)); }
    catch { await ctx.reply(text, dishesKeyboard(catKey)); }
  } else {
    await ctx.reply(text, dishesKeyboard(catKey));
  }
}

bot.start(async (ctx) => {
  if (await deny(ctx)) return;
  const st = getState(ctx);
  st.step = "idle";
  await ctx.reply("Готово. Нажми «Новый заказ».", mainKeyboard());
});

bot.hears(BTN_NEW, async (ctx) => {
  if (await deny(ctx)) return;
  const st = getState(ctx);

  if (st.orderId) deleteKitchenOrder(st.orderId);

  st.step = "entering_order";
  st.orderNo = "";
  st.prepMinutes = 25;
  st.cart = {};
  st.cat = null;
  st.orderId = null;

  await ctx.reply("Введите номер заказа (например GF-254):", mainKeyboard());
});

bot.on("text", async (ctx) => {
  if (await deny(ctx)) return;
  const st = getState(ctx);
  const txt = (ctx.message.text || "").trim();
  if (txt === BTN_NEW) return;

  if (st.step === "entering_order") {
    if (st.orderId) deleteKitchenOrder(st.orderId);
    st.orderNo = txt;
    st.step = "entering_time";
    await ctx.reply("Введите время приготовления (минуты 1–240), например 20:", mainKeyboard());
    return;
  }

  if (st.step === "entering_time") {
    const n = Number(txt);
    if (!Number.isFinite(n) || n < 1 || n > 240) {
      await ctx.reply("Введите число 1–240.", mainKeyboard());
      return;
    }

    st.prepMinutes = Math.floor(n);

    if (!st.orderNo.trim()) {
      await ctx.reply("❌ Нет номера заказа. Нажми «Новый заказ».", mainKeyboard());
      st.step = "idle";
      return;
    }

    // ✅ таймер стартует сразу
    const id = addKitchenOrder({ orderNo: st.orderNo.trim(), prepMinutes: st.prepMinutes });
    st.orderId = id;

    st.step = "selecting_items";
    await ctx.reply(`⏱ Таймер уже идет на ТВ: ${PUBLIC_URL}/\nВыбери блюда и нажми «Отправить на ТВ».`, mainKeyboard());
    await showCategories(ctx);
    return;
  }

  await ctx.reply("Нажми «Новый заказ».", mainKeyboard());
});

// Callbacks
bot.action("cats", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;
  await showCategories(ctx);
});

bot.action(/cat:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;
  await showDishes(ctx, ctx.match[1]);
});

bot.action(/add:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;
  const st = getState(ctx);
  const name = ctx.match[1];
  st.cart[name] = (st.cart[name] || 0) + 1;
  if (st.cat) await showDishes(ctx, st.cat);
  else await showCategories(ctx);
});

bot.action("clear", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;
  const st = getState(ctx);
  st.cart = {};
  if (st.cat) await showDishes(ctx, st.cat);
  else await showCategories(ctx);
});

bot.action("edit", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  if (st.orderId) deleteKitchenOrder(st.orderId);

  st.step = "entering_order";
  st.orderNo = "";
  st.prepMinutes = 25;
  st.cart = {};
  st.cat = null;
  st.orderId = null;

  await ctx.reply("Введите номер заказа заново:", mainKeyboard());
});

bot.action("remove_mode", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;
  const st = getState(ctx);
  const keys = Object.keys(st.cart);
  if (!keys.length) return ctx.reply("Корзина пустая.", mainKeyboard());

  const rows = keys.map((k) => [Markup.button.callback(`➖ ${k} (x${st.cart[k]})`, `rem:${k}`)]);
  rows.push([Markup.button.callback("⬅️ Назад", st.cat ? "back_to_dishes" : "cats")]);
  await ctx.reply("Выбери позицию, чтобы уменьшить на 1:", Markup.inlineKeyboard(rows));
});

bot.action("back_to_dishes", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;
  const st = getState(ctx);
  if (st.cat) await showDishes(ctx, st.cat);
  else await showCategories(ctx);
});

bot.action(/rem:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;
  const st = getState(ctx);
  const name = ctx.match[1];
  const v = (st.cart[name] || 0) - 1;
  if (v <= 0) delete st.cart[name];
  else st.cart[name] = v;
  await ctx.reply(`Ок: ${name}`, mainKeyboard());
});

bot.action("send", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  const items = Object.entries(st.cart).map(([name, qty]) => ({ name, qty }));

  if (!st.orderId) return ctx.reply("❌ Сначала введи номер и время.", mainKeyboard());
  if (!items.length) return ctx.reply("❌ Корзина пустая.", mainKeyboard());

  const ok = updateKitchenOrderItems(st.orderId, items);
  if (!ok) return ctx.reply("❌ Заказ на экране не найден (сервер перезапускался). Создай заказ заново.", mainKeyboard());

  await ctx.reply(`✅ Блюда появились на ТВ: ${PUBLIC_URL}/`, mainKeyboard());

  st.step = "idle";
  st.orderNo = "";
  st.prepMinutes = 25;
  st.cart = {};
  st.cat = null;
  st.orderId = null;
});

// ==========================
// WEBHOOK
// ==========================
const WEBHOOK_PATH = `/tg/${WEBHOOK_SECRET}`;
app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    await bot.handleUpdate(req.body, res);
    if (!res.headersSent) res.sendStatus(200);
  } catch (e) {
    console.error("HANDLE UPDATE ERROR:", e);
    if (!res.headersSent) res.sendStatus(200);
  }
});

// ==========================
// START
// ==========================
const PORT = process.env.PORT || 3000;
http.createServer(app).listen(PORT, async () => {
  console.log("Listening on", PORT);
  const webhookUrl = `${PUBLIC_URL}${WEBHOOK_PATH}`;
  await bot.telegram.setWebhook(webhookUrl, { drop_pending_updates: true });
  console.log("Webhook set to:", webhookUrl);
});
