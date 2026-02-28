// index.js (ESM)
// Один деплой: бот -> этот же сервер -> экран ТВ.
// Экран: /  (или /screen)
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
const PUBLIC_URL = process.env.PUBLIC_URL;       // например https://screencook-production.up.railway.app
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
// items могут быть пустыми сначала — таймер уже идёт, блюда добавятся позже.
let orders = []; // [{ id, orderNo, prepMinutes, createdAt, endsAt, expiresAt, items:[{name,qty}] }]

function pruneOrders() {
  const now = Date.now();
  orders = orders.filter((o) => o.expiresAt > now);
  // новые сверху
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
    items: [], // потом добавим
  };
  orders.unshift(o);
  pruneOrders();
  return o.id;
}

function updateKitchenOrderItems(orderId, items) {
  const idx = orders.findIndex((o) => o.id === orderId);
  if (idx === -1) return false;

  orders[idx].items = Array.isArray(items) ? items : [];
  // обновим сортировку/обрезку
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

function screenHtml() {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Kitchen Screen</title>
  <style>
    :root{
      --bg:#070b14;
      --cell:#11182b;
      --border:rgba(255,255,255,.10);
      --text:#ffffff;
      --muted:rgba(255,255,255,.55);
      --green:#00ff66;
      --yellow:#ffd400;
      --red:#ff3b30;
      --ready:#b0b7c6;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      background:var(--bg);
      color:var(--text);
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
      overflow:hidden;
    }

    header{
      height:64px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      padding:0 16px;
      border-bottom:1px solid var(--border);
      background:linear-gradient(180deg, rgba(7,11,20,.98), rgba(7,11,20,.85));
      position:relative;
      z-index:5;
    }
    .title{
      font-weight:950;
      letter-spacing:.2px;
      font-size:20px;
    }
    .meta{
      font-weight:800;
      font-size:13px;
      color:var(--muted);
      display:flex;
      gap:12px;
      align-items:center;
      white-space:nowrap;
    }
    .dot{
      width:8px;height:8px;border-radius:999px;
      background:var(--green);
      box-shadow:0 0 14px rgba(0,255,102,.35);
      display:inline-block;
    }

    main{
      height: calc(100vh - 64px);
      display:flex;
      justify-content:center;
      align-items:center;
      padding:10px;
    }

    /* Сетка 10 квадратов: 5х2 */
    .grid{
      display:grid;
      gap:10px;
      justify-content:center;
      align-content:center;
      /* колонки/ряды выставит JS через px, чтобы были квадраты */
    }

    .cell{
      width: var(--cellSize, 200px);
      height: var(--cellSize, 200px);
      background:var(--cell);
      border:1px solid var(--border);
      border-radius:16px;
      padding:10px;
      display:flex;
      flex-direction:column;
      overflow:hidden;
      box-shadow:0 12px 30px rgba(0,0,0,.35);
    }

    .top{
      flex: 0 0 46%;
      display:flex;
      flex-direction:column;
      justify-content:center;
      gap:6px;
      min-height:0;
    }

    .orderNo{
      font-weight:1000;
      line-height:1.02;
      text-align:center;
      letter-spacing:.4px;
      /* font-size подберём JS */
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }

    .remain{
      font-weight:1000;
      line-height:1.02;
      text-align:center;
      /* цвет/размер задаст JS */
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }

    .items{
      flex: 1 1 auto;
      margin-top:6px;
      border-top:1px solid rgba(255,255,255,.08);
      padding-top:8px;
      overflow:hidden;
      color:rgba(255,255,255,.92);
      font-weight:850;
      font-size:14px;
      line-height:1.15;
      display:flex;
      flex-direction:column;
      gap:6px;
    }

    .item{
      display:flex;
      justify-content:space-between;
      gap:8px;
      padding:6px 8px;
      border:1px solid rgba(255,255,255,.08);
      border-radius:12px;
      background:rgba(255,255,255,.03);
      min-width:0;
    }
    .item .name{
      min-width:0;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }
    .item .qty{
      flex:0 0 auto;
      color:rgba(255,255,255,.75);
      font-weight:950;
      white-space:nowrap;
    }

    .placeholder{
      flex:1 1 auto;
      display:flex;
      align-items:center;
      justify-content:center;
      color:rgba(255,255,255,.45);
      font-weight:900;
      font-size:14px;
      text-align:center;
      padding:8px;
    }

    .emptyCell{
      display:flex;
      align-items:center;
      justify-content:center;
      color:rgba(255,255,255,.25);
      font-weight:950;
      font-size:22px;
      letter-spacing:.3px;
    }
  </style>
</head>
<body>
  <header>
    <div class="title">Smoke Factory — Kitchen Screen</div>
    <div class="meta">
      <span class="dot" id="dot"></span>
      <span id="status">онлайн</span>
      <span id="updated">—</span>
    </div>
  </header>

  <main>
    <div class="grid" id="grid"></div>
  </main>

<script>
  const grid = document.getElementById('grid');
  const updated = document.getElementById('updated');
  const statusEl = document.getElementById('status');
  const dot = document.getElementById('dot');

  const COLS = 5;
  const ROWS = 2;
  const TOTAL = COLS * ROWS;

  function fmt2(n){ return String(n).padStart(2,'0'); }

  function mmss(ms){
    const s = Math.max(0, Math.floor(ms/1000));
    const m = Math.floor(s/60);
    const ss = s%60;
    return m + ":" + fmt2(ss);
  }

  function esc(s){ return String(s||'').replace(/</g,'&lt;'); }

  // Цвет "ОСТАЛОСЬ" по интервалам:
  // 40–25 зелёный, 25–10 жёлтый, 10–0 красный
  function remainColor(remMin){
    if (remMin <= 0) return 'var(--ready)';
    if (remMin <= 10) return 'var(--red)';
    if (remMin <= 25) return 'var(--yellow)';
    // 25..40 и выше -> зелёный (если вдруг >40 — тоже зелёный)
    return 'var(--green)';
  }

  // Сделать 10 одинаковых квадратов, чтобы точно помещались в экран
  function layoutSquares(){
    const headerH = 64;
    const gap = 10;
    const pad = 10 * 2; // main padding left+right approx
    const w = window.innerWidth - 20; // main padding
    const h = window.innerHeight - headerH - 20;

    const cellW = (w - gap * (COLS - 1)) / COLS;
    const cellH = (h - gap * (ROWS - 1)) / ROWS;

    const size = Math.floor(Math.min(cellW, cellH));

    grid.style.setProperty('--cellSize', size + 'px');
    grid.style.gridTemplateColumns = \`repeat(\${COLS}, \${size}px)\`;
    grid.style.gridAutoRows = size + 'px';
    grid.style.gap = gap + 'px';
  }

  // Автоподбор шрифта, чтобы текст влезал
  function fitText(el, maxPx, minPx){
    if (!el) return;
    let size = maxPx;
    el.style.fontSize = size + 'px';

    // Подгоняем пока не влезет по ширине
    while (size > minPx && (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight)){
      size -= 1;
      el.style.fontSize = size + 'px';
    }
  }

  function render(orders){
    grid.innerHTML = '';

    const now = Date.now();
    const list = Array.isArray(orders) ? orders.slice(0, 10) : [];

    for (let i = 0; i < TOTAL; i++){
      const o = list[i];

      const cell = document.createElement('div');
      cell.className = 'cell';

      if (!o){
        cell.innerHTML = '<div class="emptyCell">—</div>';
        grid.appendChild(cell);
        continue;
      }

      const remMs = (o.endsAt || 0) - now;
      const remText = (remMs <= 0) ? 'READY' : ('ОСТАЛОСЬ ' + mmss(remMs));
      const remMin = remMs / 60000;
      const color = remainColor(remMin);

      const items = Array.isArray(o.items) ? o.items : [];

      const itemsHtml = items.length
        ? '<div class="items">' + items.map(it => {
            const name = esc(it.name);
            const qty = Number(it.qty || 0);
            return \`<div class="item"><div class="name">\${name}</div><div class="qty">x\${qty}</div></div>\`;
          }).join('') + '</div>'
        : '<div class="placeholder">Выбор блюд…</div>';

      cell.innerHTML = \`
        <div class="top">
          <div class="orderNo" data-fit="order">\${esc(o.orderNo || '—')}</div>
          <div class="remain" data-fit="remain" style="color:\${color}">\${remText}</div>
        </div>
        \${itemsHtml}
      \`;

      grid.appendChild(cell);
    }

    // После рендера — подгон шрифтов
    const orderEls = grid.querySelectorAll('[data-fit="order"]');
    const remEls = grid.querySelectorAll('[data-fit="remain"]');

    orderEls.forEach(el => fitText(el, 46, 14));
    remEls.forEach(el => fitText(el, 34, 12));
  }

  async function tick(){
    try{
      const r = await fetch('/api/orders', { cache:'no-store' });
      const j = await r.json();
      render(j);

      const d = new Date();
      updated.textContent = "обновлено " + fmt2(d.getHours()) + ":" + fmt2(d.getMinutes()) + ":" + fmt2(d.getSeconds());

      statusEl.textContent = "онлайн";
      dot.style.background = "var(--green)";
      dot.style.boxShadow = "0 0 14px rgba(0,255,102,.35)";
    }catch(e){
      statusEl.textContent = "ошибка";
      dot.style.background = "var(--yellow)";
      dot.style.boxShadow = "0 0 14px rgba(255,212,0,.25)";
    }
  }

  layoutSquares();
  window.addEventListener('resize', () => {
    layoutSquares();
    tick();
  });

  tick();
  setInterval(tick, 1000); // таймер лучше каждую секунду
</script>
</body>
</html>`;
}

// Главная сразу экран
app.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(screenHtml());
});

// алиас
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
      step: "idle", // idle | entering_order | entering_time | selecting_items
      orderNo: "",
      prepMinutes: 25,
      cart: {},      // { name: qty }
      cat: null,
      orderId: null, // id заказа на экране (создаётся сразу после ввода времени)
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

  // если предыдущий незавершённый заказ уже создали на экране — удалим, чтобы не засорять
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
    // если был старый незавершённый — удалим
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

    // ✅ ВАЖНОЕ: СРАЗУ создаём заказ на экране, чтобы таймер пошёл немедленно
    if (!st.orderNo.trim()) {
      await ctx.reply("❌ Нет номера заказа. Нажми «Новый заказ».", mainKeyboard());
      st.step = "idle";
      return;
    }
    const id = addKitchenOrder({ orderNo: st.orderNo.trim(), prepMinutes: st.prepMinutes });
    st.orderId = id;

    st.step = "selecting_items";
    await ctx.reply(
      `⏱ Таймер запущен на экране: ${PUBLIC_URL}/\nТеперь выбери блюда и нажми «Отправить на ТВ».`,
      mainKeyboard()
    );
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

  // если уже создали заказ на экране — удалим, потому что номер/время меняем
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

  const rows = keys.map((k) => [
    Markup.button.callback(`➖ ${k} (x${st.cart[k]})`, `rem:${k}`)
  ]);
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

  if (!st.orderId) {
    return ctx.reply("❌ Сначала введи номер и время (таймер должен запуститься).", mainKeyboard());
  }
  if (!items.length) return ctx.reply("❌ Корзина пустая.", mainKeyboard());

  // ✅ Теперь просто ДОБАВЛЯЕМ блюда в уже созданный заказ (таймер не терял минуты)
  const ok = updateKitchenOrderItems(st.orderId, items);
  if (!ok) {
    return ctx.reply("❌ Заказ на экране не найден (возможно перезапуск сервера). Создай заказ заново.", mainKeyboard());
  }

  await ctx.reply(
    `✅ Блюда отправлены на ТВ\nЭкран: ${PUBLIC_URL}/`,
    mainKeyboard()
  );

  // reset
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

  console.log("Screen:", `${PUBLIC_URL}/`);
  console.log("API:", `${PUBLIC_URL}/api/orders`);
});
