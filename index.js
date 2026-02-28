// index.js (ESM)
// One deploy: bot creates orders -> this server stores in memory -> TV opens "/" (or "/screen").
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
const PUBLIC_URL = process.env.PUBLIC_URL;       // e.g. https://screencook-production.up.railway.app
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
let orders = []; // [{ id, orderNo, prepMinutes, createdAt, endsAt, expiresAt, items:[{name,qty}], totalQty }]

function pruneOrders() {
  const now = Date.now();
  orders = orders.filter((o) => o.expiresAt > now);
  orders.sort((a, b) => b.createdAt - a.createdAt);
  orders = orders.slice(0, 10);
}

function addKitchenOrder({ orderNo, prepMinutes, items }) {
  const createdAt = Date.now();
  const endsAt = createdAt + prepMinutes * 60_000;
  const expiresAt = endsAt + 5 * 60_000; // хранить ещё 5 минут после READY
  const totalQty = items.reduce((s, it) => s + (Number(it.qty) || 0), 0);

  orders.unshift({
    id: crypto.randomUUID(),
    orderNo,
    prepMinutes,
    createdAt,
    endsAt,
    expiresAt,
    items,
    totalQty,
  });

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
      --bg:#0b1220;
      --card:#121a2b;
      --text:#ffffff;
      --muted:#9aa7c7;
      --border:rgba(255,255,255,.10);
      --orange:#ff9900;   /* >10 мин */
      --green:#00ff66;    /* <=10 мин */
      --ready:#00ff00;    /* READY */
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      background:var(--bg);
      color:var(--text);
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
    }
    header{
      position:sticky; top:0;
      background:linear-gradient(180deg, rgba(11,18,32,.95), rgba(11,18,32,.75));
      backdrop-filter: blur(6px);
      border-bottom:1px solid var(--border);
      padding:14px 18px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      z-index:10;
    }
    .title{
      font-size:22px;
      font-weight:900;
      letter-spacing:.3px;
    }
    .meta{
      color:var(--muted);
      font-weight:700;
      font-size:14px;
      display:flex;
      gap:14px;
      align-items:center;
      white-space:nowrap;
    }
    .dot{
      width:8px;height:8px;border-radius:99px;background:var(--green);
      box-shadow:0 0 16px rgba(0,255,102,.4);
      display:inline-block;
    }

    main{ padding:16px; }

    .grid{
      display:grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap:14px;
    }
    @media (min-width: 1200px){
      .grid{ grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (min-width: 1700px){
      .grid{ grid-template-columns: repeat(4, minmax(0, 1fr)); }
    }

    .card{
      background:var(--card);
      border:1px solid var(--border);
      border-radius:18px;
      padding:14px 14px 12px;
      box-shadow:0 10px 30px rgba(0,0,0,.25);
      min-height:140px;
      display:flex;
      flex-direction:column;
      gap:10px;
    }
    .top{
      display:flex;
      align-items:flex-start;
      justify-content:space-between;
      gap:12px;
    }
    .orderNo{
      font-size:24px;
      font-weight:950;
      line-height:1.05;
    }
    .badges{
      display:flex;
      flex-direction:column;
      align-items:flex-end;
      gap:8px;
      min-width:160px;
    }
    .badge{
      width:100%;
      display:flex;
      justify-content:space-between;
      gap:10px;
      align-items:center;
      padding:8px 10px;
      border-radius:14px;
      border:1px solid var(--border);
      font-weight:900;
      letter-spacing:.2px;
    }
    .badge small{
      font-weight:800;
      color:rgba(255,255,255,.75);
    }
    .badge.orange{ border-color: rgba(255,153,0,.35); box-shadow:0 0 0 1px rgba(255,153,0,.10) inset; }
    .badge.green{ border-color: rgba(0,255,102,.35); box-shadow:0 0 0 1px rgba(0,255,102,.10) inset; }
    .badge.ready{ border-color: rgba(0,255,0,.45); box-shadow:0 0 0 1px rgba(0,255,0,.12) inset; }

    .timeValue{
      font-size:18px;
      font-weight:950;
    }

    .list{
      margin:0;
      padding:0;
      list-style:none;
      display:flex;
      flex-direction:column;
      gap:8px;
    }
    .li{
      display:flex;
      justify-content:space-between;
      gap:10px;
      border:1px solid var(--border);
      border-radius:12px;
      padding:8px 10px;
      background:rgba(255,255,255,.03);
      font-weight:800;
    }
    .li span{ color:var(--muted); font-weight:900; }

    .empty{
      margin-top:14px;
      border:1px dashed rgba(255,255,255,.18);
      border-radius:18px;
      padding:22px;
      color:var(--muted);
      font-weight:800;
      text-align:center;
    }
    .hint{
      margin-top:10px;
      color:rgba(255,255,255,.35);
      font-weight:700;
      text-align:center;
      font-size:12px;
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
    <div class="empty" id="empty" style="display:none">Заказов нет</div>
    <div class="hint">Источник: /api/orders • Обновление каждые 2 секунды</div>
  </main>

<script>
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');
  const updated = document.getElementById('updated');
  const statusEl = document.getElementById('status');
  const dot = document.getElementById('dot');

  function fmt2(n){ return String(n).padStart(2,'0'); }
  function mmss(ms){
    const s = Math.max(0, Math.floor(ms/1000));
    const m = Math.floor(s/60);
    const ss = s%60;
    return m + ":" + fmt2(ss);
  }
  function badgeClass(remainingMs){
    if (remainingMs <= 0) return 'ready';
    const min = remainingMs / 60000;
    return (min <= 10) ? 'green' : 'orange';
  }

  function esc(s){ return String(s||'').replace(/</g,'&lt;'); }

  function render(orders){
    grid.innerHTML = '';
    if (!orders || !orders.length){
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    const now = Date.now();

    for (const o of orders){
      const rem = (o.endsAt || 0) - now;
      const cls = badgeClass(rem);
      const timerText = (rem <= 0) ? "READY" : mmss(rem);

      const itemsHtml = (o.items || []).map(it => {
        const name = esc(it.name);
        const qty = Number(it.qty || 0);
        return \`<li class="li"><div>\${name}</div><div><span>x</span>\${qty}</div></li>\`;
      }).join('');

      const totalQty = Number(o.totalQty || 0);
      const prep = Number(o.prepMinutes || 0);

      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = \`
        <div class="top">
          <div>
            <div class="orderNo">\${esc(o.orderNo||'—')}</div>
          </div>
          <div class="badges">
            <div class="badge \${cls}">
              <small>Осталось</small>
              <div class="timeValue">\${timerText}</div>
            </div>
            <div class="badge">
              <small>Время</small>
              <div class="timeValue">\${prep} мин</div>
            </div>
            <div class="badge">
              <small>Кол-во</small>
              <div class="timeValue">\${totalQty}</div>
            </div>
          </div>
        </div>
        <ul class="list">\${itemsHtml}</ul>
      \`;
      grid.appendChild(card);
    }
  }

  async function tick(){
    try{
      const r = await fetch('/api/orders', { cache: 'no-store' });
      const j = await r.json();
      render(j);

      const d = new Date();
      updated.textContent = "обновлено " + fmt2(d.getHours()) + ":" + fmt2(d.getMinutes()) + ":" + fmt2(d.getSeconds());

      statusEl.textContent = "онлайн";
      dot.style.background = "var(--green)";
      dot.style.boxShadow = "0 0 16px rgba(0,255,102,.4)";
    }catch(e){
      statusEl.textContent = "ошибка";
      dot.style.background = "var(--orange)";
      dot.style.boxShadow = "0 0 16px rgba(255,153,0,.35)";
    }
  }

  tick();
  setInterval(tick, 2000);
</script>
</body>
</html>`;
}

// Главная сразу показывает экран (чтобы на ТВ открывать просто домен)
app.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(screenHtml());
});

// Алиас, если хочешь
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
      cart: {}, // { name: qty }
      cat: null,
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
  st.step = "entering_order";
  st.orderNo = "";
  st.prepMinutes = 25;
  st.cart = {};
  st.cat = null;
  await ctx.reply("Введите номер заказа (например GF-254):", mainKeyboard());
});

bot.on("text", async (ctx) => {
  if (await deny(ctx)) return;
  const st = getState(ctx);
  const txt = (ctx.message.text || "").trim();
  if (txt === BTN_NEW) return;

  if (st.step === "entering_order") {
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
    st.step = "selecting_items";
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
  st.step = "entering_order";
  st.orderNo = "";
  st.prepMinutes = 25;
  st.cart = {};
  st.cat = null;
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

  if (!st.orderNo.trim()) return ctx.reply("❌ Нет номера заказа.", mainKeyboard());
  if (!items.length) return ctx.reply("❌ Корзина пустая.", mainKeyboard());

  const orderNo = st.orderNo.trim();
  const prepMinutes = st.prepMinutes;

  addKitchenOrder({ orderNo, prepMinutes, items });

  await ctx.reply(
    `✅ Отправлено на ТВ\nЭкран: ${PUBLIC_URL}/\nAPI: ${PUBLIC_URL}/api/orders`,
    mainKeyboard()
  );

  // reset
  st.step = "idle";
  st.orderNo = "";
  st.prepMinutes = 25;
  st.cart = {};
  st.cat = null;
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
