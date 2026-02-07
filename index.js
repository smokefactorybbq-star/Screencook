// index.js — WORKING (Railway) ✅
// Express + Socket.IO + /screen + Telegram bot via WEBHOOK
//
// ENV (Railway Variables):
// BOT_TOKEN=...
// PUBLIC_URL=https://xxxxx.up.railway.app
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
// MENU (36 items) — replace with yours
// ==========================
const MENU_ITEMS = [
  "Рёбра BBQ", "Курица гриль", "Шашлык куриный", "Борщ", "Солянка", "Пельмени",
  "Котлеты", "Пюре", "Рис", "Щи", "Харчо", "Минестроне",
  "Болоньезе", "Макароны по-флотски", "Овощное рагу", "Картошка тушёная",
  "Капуста тушёная", "Свекольник", "Мясо по-капитански", "Грибной суп",
  "Плов", "Гречка", "Сосиски", "Колбаски", "Салат", "Огурец свежий",
  "Тушёнка", "Гуляш", "Куриный суп", "Гороховый суп", "Жареный рис", "Лапша",
  "Соус BBQ", "Соус чесночный", "Соус острый", "Хлеб"
];

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
// SERVER + SOCKET.IO
// ==========================
const app = express();
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/", (_req, res) => res.type("text/plain").send("OK. Open /screen on TV"));
app.get("/screen", (_req, res) => res.type("html").send(getScreenHtml()));
app.get("/api/orders", (_req, res) => {
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
// BOT (WEBHOOK)
// ==========================
const bot = new Telegraf(BOT_TOKEN);

// log any bot errors
bot.catch((err) => console.error("BOT ERROR:", err));

// session
bot.use(session());

// ensure ctx.session exists
bot.use((ctx, next) => {
  if (!ctx.session) ctx.session = {};
  return next();
});

// log updates processed by telegraf (so you SEE it in logs)
bot.use((ctx, next) => {
  console.log("BOT UPDATE:", ctx.updateType, "FROM:", ctx.from?.id, "TEXT:", ctx.message?.text);
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
      step: "idle", // entering_order | entering_time | selecting_items
      orderNo: "",
      prepMinutes: 25,
      cart: {},
      page: 0
    };
  }
  return ctx.session.state;
}

function cartSummary(cart) {
  const entries = Object.entries(cart);
  if (!entries.length) return "— пусто —";
  return entries.map(([name, qty]) => `• ${name} ×${qty}`).join("\n");
}

function makeMenuKeyboard(page = 0) {
  const pageSize = 12;
  const totalPages = Math.ceil(MENU_ITEMS.length / pageSize);
  const safePage = Math.max(0, Math.min(totalPages - 1, page));
  const slice = MENU_ITEMS.slice(safePage * pageSize, safePage * pageSize + pageSize);

  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const a = slice[i];
    const b = slice[i + 1];
    const row = [Markup.button.callback(`➕ ${a}`, `add:${a}`)];
    if (b) row.push(Markup.button.callback(`➕ ${b}`, `add:${b}`));
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

  if (totalPages > 1) {
    rows.push([
      Markup.button.callback("⬅️", `page:${safePage - 1}`),
      Markup.button.callback(`Стр. ${safePage + 1}/${totalPages}`, "noop"),
      Markup.button.callback("➡️", `page:${safePage + 1}`)
    ]);
  }

  return Markup.inlineKeyboard(rows);
}

async function showComposer(ctx, page = 0) {
  const st = getState(ctx);
  st.page = page;

  const text =
`🧾 Создание заказа

Номер: ${st.orderNo || "—"}
Время: ${st.prepMinutes} мин

Корзина:
${cartSummary(st.cart)}

Нажимай блюда (➕), затем «✅ Отправить на ТВ».`;

  if (ctx.updateType === "callback_query") {
    try {
      await ctx.editMessageText(text, makeMenuKeyboard(page));
    } catch {
      await ctx.reply(text, makeMenuKeyboard(page));
    }
  } else {
    await ctx.reply(text, makeMenuKeyboard(page));
  }
}

// Commands
bot.start(async (ctx) => {
  if (await deny(ctx)) return;
  const st = getState(ctx);
  st.step = "entering_order";
  st.orderNo = "";
  st.prepMinutes = 25;
  st.cart = {};
  st.page = 0;

  await ctx.reply("✅ Бот работает. Введите номер заказа (например: Grab 12345):");
});

bot.command("new", async (ctx) => {
  if (await deny(ctx)) return;
  const st = getState(ctx);
  st.step = "entering_order";
  st.orderNo = "";
  st.prepMinutes = 25;
  st.cart = {};
  st.page = 0;

  await ctx.reply("Ок. Введите номер заказа:");
});

bot.command("id", async (ctx) => {
  await ctx.reply(`Ваш user_id: ${ctx.from?.id}`);
});

// Text input steps
bot.on("text", async (ctx) => {
  if (await deny(ctx)) return;
  const st = getState(ctx);
  const txt = ctx.message.text.trim();

  if (txt.startsWith("/")) return; // commands handled elsewhere

  if (st.step === "entering_order") {
    st.orderNo = txt;
    st.step = "entering_time";
    await ctx.reply("Введите время приготовления (1–240 минут), например 25:");
    return;
  }

  if (st.step === "entering_time") {
    const n = Number(txt);
    if (!Number.isFinite(n) || n < 1 || n > 240) {
      await ctx.reply("Введите число 1–240.");
      return;
    }
    st.prepMinutes = Math.floor(n);
    st.step = "selecting_items";
    await showComposer(ctx, 0);
    return;
  }

  await ctx.reply("Нажми /new чтобы начать новый заказ.");
});

// Callbacks
bot.action("noop", async (ctx) => ctx.answerCbQuery());

bot.action(/page:(-?\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const page = Number(ctx.match[1]);
  const pageSize = 12;
  const totalPages = Math.ceil(MENU_ITEMS.length / pageSize);
  const safePage = Math.max(0, Math.min(totalPages - 1, page));

  await showComposer(ctx, safePage);
});

bot.action(/add:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  const name = ctx.match[1];
  st.cart[name] = (st.cart[name] || 0) + 1;

  await showComposer(ctx, st.page || 0);
});

bot.action("clear", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  st.cart = {};
  await showComposer(ctx, st.page || 0);
});

bot.action("remove_mode", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  const keys = Object.keys(st.cart);
  if (!keys.length) return ctx.reply("Корзина пустая.");

  const rows = keys.map((k) => [
    Markup.button.callback(`➖ ${k} (×${st.cart[k]})`, `rem:${k}`)
  ]);
  rows.push([Markup.button.callback("⬅️ Назад", "back_to_menu")]);

  await ctx.reply("Выбери позицию, чтобы уменьшить на 1:", Markup.inlineKeyboard(rows));
});

bot.action(/rem:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  const name = ctx.match[1];
  const v = (st.cart[name] || 0) - 1;
  if (v <= 0) delete st.cart[name];
  else st.cart[name] = v;

  await ctx.reply(`Ок: ${name}`);
});

bot.action("back_to_menu", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  await showComposer(ctx, st.page || 0);
});

bot.action("edit", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  st.step = "entering_order";
  await ctx.reply("Введите номер заказа заново:");
});

bot.action("send", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  const items = Object.entries(st.cart).map(([name, qty]) => ({ name, qty }));

  if (!st.orderNo.trim()) return ctx.reply("❌ Нет номера заказа. Нажми /start");
  if (!items.length) return ctx.reply("❌ Корзина пустая.");

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

  await ctx.reply(`✅ Отправлено на ТВ: ${st.orderNo} (${st.prepMinutes} мин)`);

  st.step = "idle";
  st.orderNo = "";
  st.prepMinutes = 25;
  st.cart = {};
  st.page = 0;
});

// ==========================
// WEBHOOK ROUTE (ONE handler chain!) ✅
// ==========================
const WEBHOOK_PATH = `/tg/${WEBHOOK_SECRET}`;

// single route: log + telegraf handler
app.post(
  WEBHOOK_PATH,
  (req, _res, next) => {
    console.log("WEBHOOK HIT ✅ keys:", Object.keys(req.body || {}));
    next();
  },
  bot.webhookCallback()
);

// start server and set webhook
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

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// ==========================
// SCREEN HTML
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
    .card{background:var(--card);border:1px solid var(--stroke);border-radius:16px;padding:12px;min-height:120px}
    .row{display:flex;justify-content:space-between;align-items:baseline}
    .orderNo{font-size:22px;font-weight:900}
    .timer{font-size:22px;font-weight:900}
    .list{margin-top:8px;display:grid;gap:6px;font-size:18px}
    .item{display:flex;justify-content:space-between}
    .name{font-weight:800}
    .qty{font-weight:900}
    .done{margin-top:10px;font-weight:900;opacity:.9}
    .empty{background:rgba(17,27,49,.35);border:1px dashed rgba(255,255,255,.12)}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="title">KITCHEN SCREEN</div>
      <div class="clock" id="clock"></div>
    </div>
    <div class="grid" id="grid"></div>
  </div>

  <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
  <script>
    const socket = io();
    let orders = [];

    function fmt(ms){
      const s = Math.max(0, Math.floor(ms/1000));
      const m = Math.floor(s/60);
      const ss = s%60;
      return m + ":" + String(ss).padStart(2,"0");
    }
    function esc(s){
      return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));
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

        const card = document.createElement("div");
        card.className = "card";
        card.innerHTML = \`
          <div class="row">
            <div class="orderNo">\${esc(o.orderNo)}</div>
            <div class="timer">\${late ? "0:00" : fmt(remaining)}</div>
          </div>
          <div class="list">
            \${(o.items||[]).map(it=>\`
              <div class="item">
                <div class="name">\${esc(it.name)}</div>
                <div class="qty">×\${it.qty}</div>
              </div>\`).join("")}
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

    socket.on("orders:update", list => { orders = list || []; render(); });

    setInterval(tick, 1000);
    tick();
  </script>
</body>
</html>`;
}
