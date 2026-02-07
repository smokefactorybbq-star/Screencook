// index.js — FULL WORKING (Railway) ✅
// Bot: button "Новый заказ", categories
// Screen: polling /api/orders, qty near dish name, BIG HH:MM:SS timer with color zones
//
// REQUIRED Railway Variables:
// BOT_TOKEN=...
// PUBLIC_URL=https://your-app.up.railway.app
// WEBHOOK_SECRET=long-random-string
// Optional: MANAGER_IDS=123,456

import express from "express";
import http from "http";
import { Server } from "socket.io";
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
// BOT UI CONSTANTS
// ==========================
const BTN_NEW = "🧾 Новый заказ";
const BTN_BACK_CATS = "⬅️ Категории";

// ==========================
// MENU by categories
// ==========================
const CATEGORIES = [
  { key: "soups", label: "🍲 Супы" },
  { key: "mains", label: "🍛 Основные блюда" },
  { key: "sides", label: "🍟 Дополнительные блюда" },
  { key: "grill", label: "🔥 Гриль" },
  { key: "salads", label: "🥗 Салаты" }
];

// Замени на свои блюда
const MENU_BY_CAT = {
  soups: ["Борщ", "Солянка", "Щи", "Харчо", "Минестроне", "Грибной суп", "Куриный суп", "Гороховый суп"],
  mains: ["Пельмени", "Болоньезе", "Макароны по-флотски", "Овощное рагу", "Гуляш", "Плов", "Тушёнка"],
  sides: ["Пюре", "Рис", "Гречка", "Лапша", "Картошка тушёная", "Капуста тушёная", "Хлеб", "Соус BBQ", "Соус чесночный", "Соус острый"],
  grill: ["Рёбра BBQ", "Курица гриль", "Шашлык куриный", "Колбаски", "Сосиски"],
  salads: ["Салат", "Огурец свежий"]
};

// ==========================
// ORDERS (memory)
// ==========================
let orders = [];

function pruneAndLimit() {
  const now = Date.now();
  orders = orders.filter((o) => o.expiresAt > now);
  orders.sort((a, b) => b.createdAt - a.createdAt);
  orders = orders.slice(0, 10);
}

function broadcast(io) {
  pruneAndLimit();
  io.emit("orders:update", orders);
}

// ==========================
// SERVER
// ==========================
const app = express();
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/", (_req, res) => res.type("text/plain").send("OK. Open /screen on TV"));

app.get("/screen", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.type("html").send(getScreenHtml());
});

app.get("/api/orders", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  pruneAndLimit();
  res.json(orders);
});

io.on("connection", (socket) => {
  pruneAndLimit();
  socket.emit("orders:update", orders);
});

setInterval(() => {
  const before = orders.length;
  pruneAndLimit();
  if (orders.length !== before) io.emit("orders:update", orders);
}, 30_000);

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

// Access control
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

// State
function getState(ctx) {
  if (!ctx.session.state) {
    ctx.session.state = {
      step: "idle",
      orderNo: "",
      prepMinutes: 25,
      cart: {},
      cat: null
    };
  }
  return ctx.session.state;
}

function mainReplyKeyboard() {
  return Markup.keyboard([[BTN_NEW]]).resize().oneTime(false);
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
  rows.push([
    Markup.button.callback("🧹 Очистить", "clear"),
    Markup.button.callback("✅ Отправить на ТВ", "send")
  ]);
  rows.push([
    Markup.button.callback("✏️ Изменить №/время", "edit"),
    Markup.button.callback("➖ Убрать позицию", "remove_mode")
  ]);
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

  rows.push([
    Markup.button.callback(BTN_BACK_CATS, "cats"),
    Markup.button.callback("🧹 Очистить", "clear")
  ]);
  rows.push([
    Markup.button.callback("✅ Отправить на ТВ", "send"),
    Markup.button.callback("➖ Убрать позицию", "remove_mode")
  ]);
  rows.push([Markup.button.callback("✏️ Изменить №/время", "edit")]);

  return Markup.inlineKeyboard(rows);
}

function cartSummaryForBot(cart) {
  const entries = Object.entries(cart);
  if (!entries.length) return "— пусто —";
  // name + 4 spaces + xN (qty near the name)
  return entries.map(([name, qty]) => `• ${name}    x${qty}`).join("\n");
}

async function showComposer(ctx) {
  const st = getState(ctx);
  const text =
`🧾 Создание заказа

Номер: ${st.orderNo || "—"}
Время: ${st.prepMinutes} мин

Корзина:
${cartSummaryForBot(st.cart)}

Выбери категорию или добавляй блюда.`;

  if (ctx.updateType === "callback_query") {
    try {
      await ctx.editMessageText(text, categoriesKeyboard());
    } catch {
      await ctx.reply(text, categoriesKeyboard());
    }
  } else {
    await ctx.reply(text, categoriesKeyboard());
  }
}

async function showDishes(ctx, catKey) {
  const st = getState(ctx);
  st.cat = catKey;
  const catLabel = CATEGORIES.find((c) => c.key === catKey)?.label || catKey;

  const text =
`📂 ${catLabel}

Номер: ${st.orderNo || "—"} | Время: ${st.prepMinutes} мин

Корзина:
${cartSummaryForBot(st.cart)}

Нажимай блюда (➕)`;

  if (ctx.updateType === "callback_query") {
    try {
      await ctx.editMessageText(text, dishesKeyboard(catKey));
    } catch {
      await ctx.reply(text, dishesKeyboard(catKey));
    }
  } else {
    await ctx.reply(text, dishesKeyboard(catKey));
  }
}

bot.command("id", async (ctx) => {
  await ctx.reply(`Ваш user_id: ${ctx.from?.id}`);
});

bot.start(async (ctx) => {
  if (await deny(ctx)) return;
  const st = getState(ctx);
  st.step = "idle";
  await ctx.reply("Готово. Нажми кнопку «Новый заказ».", mainReplyKeyboard());
});

bot.hears(BTN_NEW, async (ctx) => {
  if (await deny(ctx)) return;
  const st = getState(ctx);
  st.step = "entering_order";
  st.orderNo = "";
  st.prepMinutes = 25;
  st.cart = {};
  st.cat = null;
  await ctx.reply("Введите номер заказа (например: GF-254):", mainReplyKeyboard());
});

bot.on("text", async (ctx) => {
  if (await deny(ctx)) return;
  const st = getState(ctx);
  const txt = (ctx.message.text || "").trim();
  if (txt === BTN_NEW) return;

  if (st.step === "entering_order") {
    st.orderNo = txt;
    st.step = "entering_time";
    await ctx.reply("Введите время приготовления (1–240 минут), например 20:", mainReplyKeyboard());
    return;
  }

  if (st.step === "entering_time") {
    const n = Number(txt);
    if (!Number.isFinite(n) || n < 1 || n > 240) {
      await ctx.reply("Введите число 1–240.", mainReplyKeyboard());
      return;
    }
    st.prepMinutes = Math.floor(n);
    st.step = "selecting_items";
    await showComposer(ctx);
    return;
  }

  await ctx.reply("Нажми «Новый заказ».", mainReplyKeyboard());
});

bot.action("cats", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;
  await showComposer(ctx);
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
  else await showComposer(ctx);
});

bot.action("clear", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;
  const st = getState(ctx);
  st.cart = {};
  if (st.cat) await showDishes(ctx, st.cat);
  else await showComposer(ctx);
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
  await ctx.reply("Введите номер заказа заново:", mainReplyKeyboard());
});

bot.action("remove_mode", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  const keys = Object.keys(st.cart);
  if (!keys.length) return ctx.reply("Корзина пустая.", mainReplyKeyboard());

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
  else await showComposer(ctx);
});

bot.action(/rem:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;
  const st = getState(ctx);
  const name = ctx.match[1];
  const v = (st.cart[name] || 0) - 1;
  if (v <= 0) delete st.cart[name];
  else st.cart[name] = v;
  await ctx.reply(`Ок: ${name}`, mainReplyKeyboard());
});

bot.action("send", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  const items = Object.entries(st.cart).map(([name, qty]) => ({ name, qty }));

  if (!st.orderNo.trim()) return ctx.reply("❌ Нет номера заказа. Нажми «Новый заказ».", mainReplyKeyboard());
  if (!items.length) return ctx.reply("❌ Корзина пустая.", mainReplyKeyboard());

  const createdAt = Date.now();
  const endsAt = createdAt + st.prepMinutes * 60_000;
  const expiresAt = endsAt + 5 * 60_000;

  orders.unshift({
    id: crypto.randomUUID(),
    orderNo: st.orderNo.trim(),
    prepMinutes: st.prepMinutes,
    createdAt,
    endsAt,
    expiresAt,
    items
  });

  broadcast(io);

  await ctx.reply(
    `✅ Отправлено на ТВ: ${st.orderNo} (${st.prepMinutes} мин)\nОткрой: ${PUBLIC_URL}/screen`,
    mainReplyKeyboard()
  );

  st.step = "idle";
  st.orderNo = "";
  st.prepMinutes = 25;
  st.cart = {};
  st.cat = null;
});

// ==========================
// WEBHOOK ENDPOINT
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

// start server + set webhook
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log("Server listening on", PORT);
  const webhookUrl = `${PUBLIC_URL}${WEBHOOK_PATH}`;
  try {
    await bot.telegram.setWebhook(webhookUrl, { drop_pending_updates: true });
    console.log("Webhook set to:", webhookUrl);
  } catch (e) {
    console.error("WEBHOOK SET ERROR:", e);
  }
});

// ==========================
// SCREEN HTML (polling) — qty near name + BIG HH:MM:SS timer
// ==========================
function getScreenHtml() {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Kitchen Screen</title>
  <style>
    :root { --bg:#0b1220; --card:#111b31; --stroke:rgba(255,255,255,.10); }
    html,body{margin:0;height:100%;background:var(--bg);color:#fff;font-family:system-ui}
    .wrap{padding:14px}
    .top{display:flex;justify-content:space-between;align-items:baseline}
    .title{font-size:28px;font-weight:900}
    .clock{opacity:.8}
    .grid{margin-top:12px;display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
    .card{
      background:var(--card);
      border:1px solid var(--stroke);
      border-radius:16px;
      padding:12px;
      min-height:120px;
      display:flex;
      flex-direction:column;
      gap:10px;
    }
    .row{display:flex;justify-content:space-between;align-items:baseline}
    .orderNo{font-size:22px;font-weight:900}
    .meta{opacity:.85;font-weight:800}

    /* Items: qty RIGHT NEXT to name (not at far right) */
    .list{display:grid;gap:6px;font-size:18px}
    .item{display:flex;align-items:baseline;gap:10px}
    .name{font-weight:800}
    .qtyNear{font-weight:900;opacity:.95}

    /* BIG TIMER centered */
    .timerBigWrap{
      flex:1;
      display:flex;
      align-items:center;
      justify-content:center;
      padding-top:4px;
      padding-bottom:4px;
    }
    .timerBig{
      font-weight:1000;
      letter-spacing:2px;
      font-size:74px;   /* MUCH bigger */
      line-height:1;
      text-align:center;
      width:100%;
    }
    .tGreen{ color:#22c55e; }
    .tOrange{ color:#f59e0b; }
    .tRed{ color:#ef4444; }

    .done{margin-top:2px;font-weight:900;opacity:.9;text-align:center}
    .empty{background:rgba(17,27,49,.35);border:1px dashed rgba(255,255,255,.12)}
    .status{margin-top:8px;opacity:.7;font-size:14px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="title">KITCHEN SCREEN</div>
      <div class="clock" id="clock"></div>
    </div>
    <div class="status" id="status">loading…</div>
    <div class="grid" id="grid"></div>
  </div>

  <script>
    let orders = [];

    function pad2(n){ return String(n).padStart(2,"0"); }

    // Timer in HH:MM:SS
    function fmtHMS(ms){
      const s = Math.max(0, Math.floor(ms/1000));
      const hh = Math.floor(s/3600);
      const mm = Math.floor((s%3600)/60);
      const ss = s%60;
      return pad2(hh) + ":" + pad2(mm) + ":" + pad2(ss);
    }

    function esc(s){
      return String(s).replace(/[&<>"']/g, c=>({
        "&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"
      }[c]));
    }

    function timerClass(remainingMs){
      const mins = remainingMs / 60000;
      if (mins > 25) return "tGreen";   // 40–25
      if (mins > 5) return "tOrange";   // 25–5
      return "tRed";                    // 5–0
    }

    async function fetchOrders(){
      const status = document.getElementById("status");
      try{
        const r = await fetch("/api/orders", { cache: "no-store" });
        orders = await r.json();
        status.textContent = "orders: " + (orders?.length || 0) + " | updated: " + new Date().toLocaleTimeString();
      }catch(e){
        status.textContent = "fetch error: " + (e?.message || e);
      }
    }

    function render(){
      const now = Date.now();
      const active = (orders||[])
        .filter(o => o.expiresAt > now)
        .sort((a,b)=> b.createdAt - a.createdAt)
        .slice(0,10);

      const grid = document.getElementById("grid");
      grid.innerHTML = "";

      active.forEach(o=>{
        const remaining = o.endsAt - now;
        const late = remaining <= 0;

        const big = late ? "00:00:00" : fmtHMS(remaining);
        const cls = timerClass(Math.max(0, remaining));

        const itemsHtml = (o.items||[]).map(it=>{
          // qty near name: "Борщ    x1" visually
          return \`
            <div class="item">
              <div class="name">\${esc(it.name)}</div>
              <div class="qtyNear">x\${it.qty}</div>
            </div>\`;
        }).join("");

        const card = document.createElement("div");
        card.className = "card";
        card.innerHTML = \`
          <div class="row">
            <div class="orderNo">\${esc(o.orderNo)}</div>
            <div class="meta">\${esc(String(o.prepMinutes))} мин</div>
          </div>

          <div class="list">\${itemsHtml}</div>

          <div class="timerBigWrap">
            <div class="timerBig \${cls}">\${big}</div>
          </div>

          \${late ? '<div class="done">Завершён (удалится через 5 минут)</div>' : ''}
        \`;
        grid.appendChild(card);
      });

      for(let i=active.length;i<10;i++){
        const e = document.createElement("div");
        e.className = "card empty";
        grid.appendChild(e);
      }
    }

    function tick(){
      document.getElementById("clock").textContent = new Date().toLocaleString();
      render();
    }

    setInterval(fetchOrders, 2000);
    setInterval(tick, 1000);

    fetchOrders();
    tick();
  </script>
</body>
</html>`;
}
