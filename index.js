import express from "express";
import http from "http";
import { Server } from "socket.io";
import { Telegraf, Markup, session } from "telegraf";

// ==========================
// 0) НАСТРОЙКИ И ПРОВЕРКИ ENV
// ==========================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("ERROR: BOT_TOKEN is not set");
  process.exit(1);
}

// Ограничение доступа к боту (опционально, но очень рекомендую)
// Пример: MANAGER_IDS="12345678,98765432"
const MANAGER_IDS = (process.env.MANAGER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n));

// ==========================
// 1) МЕНЮ (36 БЛЮД)
// ==========================
const MENU_ITEMS = [
  // ЗАМЕНИ НА СВОИ 36 НАЗВАНИЙ (ровно как в меню)
  "Рёбра BBQ", "Курица гриль", "Шашлык куриный", "Борщ", "Солянка", "Пельмени",
  "Котлеты", "Пюре", "Рис", "Щи", "Харчо", "Минестроне",
  "Болоньезе", "Макароны по-флотски", "Овощное рагу", "Картошка тушёная",
  "Капуста тушёная", "Свекольник", "Мясо по-капитански", "Грибной суп",
  "Плов", "Гречка", "Сосиски", "Колбаски", "Салат", "Огурец свежий",
  "Тушёнка", "Гуляш", "Куриный суп", "Гороховый суп", "Жареный рис", "Лапша",
  "Соус BBQ", "Соус чесночный", "Соус острый", "Хлеб"
];

// ==========================
// 2) ХРАНЕНИЕ ЗАКАЗОВ (память)
// ==========================
/**
 * order = {
 *   id, orderNo, prepMinutes,
 *   createdAt, endsAt, expiresAt,
 *   items: [{name, qty}]
 * }
 */
let orders = [];

function uid() {
  return crypto.randomUUID();
}

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
// 3) WEB SERVER + SOCKET.IO
// ==========================
const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Главная (можно не использовать)
app.get("/", (_req, res) => {
  res.type("text/plain").send("OK. Open /screen on TV");
});

// Экран для телевизора
app.get("/screen", (_req, res) => {
  res.type("html").send(getScreenHtml());
});

// (Опционально) API: можно использовать потом, если надо
app.get("/api/orders", (_req, res) => {
  pruneAndLimit();
  res.json(orders);
});

io.on("connection", (socket) => {
  pruneAndLimit();
  socket.emit("orders:update", orders);
});

// Очистка заказов каждые 30 секунд + пуш обновления на экран (если что-то истекло)
setInterval(() => {
  const before = orders.length;
  pruneAndLimit();
  if (orders.length !== before) {
    io.emit("orders:update", orders);
  }
}, 30_000);

// ==========================
// 4) TELEGRAM BOT (Telegraf)
// ==========================
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// Проверка доступа
function isAllowed(ctx) {
  if (!MANAGER_IDS.length) return true; // если список пустой — доступ всем (не рекомендую)
  const id = ctx.from?.id;
  return id && MANAGER_IDS.includes(id);
}

function denyIfNotAllowed(ctx) {
  if (!isAllowed(ctx)) {
    ctx.reply("⛔️ Нет доступа.");
    return true;
  }
  return false;
}

// Сессия менеджера
function getState(ctx) {
  if (!ctx.session.state) {
    ctx.session.state = {
      step: "idle",          // idle | entering_order | entering_time | selecting_items | confirming
      orderNo: "",
      prepMinutes: 25,
      cart: {}               // { [name]: qty }
    };
  }
  return ctx.session.state;
}

function cartSummary(cart) {
  const entries = Object.entries(cart);
  if (!entries.length) return "— пусто —";
  return entries
    .map(([name, qty]) => `• ${name} ×${qty}`)
    .join("\n");
}

function makeMenuKeyboard(page = 0) {
  // 36 блюд — удобно показывать страницами по 12
  const pageSize = 12;
  const totalPages = Math.ceil(MENU_ITEMS.length / pageSize);
  const start = page * pageSize;
  const slice = MENU_ITEMS.slice(start, start + pageSize);

  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const a = slice[i];
    const b = slice[i + 1];
    const row = [
      Markup.button.callback(`➕ ${a}`, `add:${a}`)
    ];
    if (b) row.push(Markup.button.callback(`➕ ${b}`, `add:${b}`));
    rows.push(row);
  }

  rows.push([
    Markup.button.callback("➖ Убрать позицию", "remove_mode"),
    Markup.button.callback("🧹 Очистить", "clear")
  ]);

  rows.push([
    Markup.button.callback("✅ Готово (к отправке)", "done"),
    Markup.button.callback("✏️ Изменить №/время", "edit")
  ]);

  // Навигация
  const nav = [];
  if (totalPages > 1) {
    nav.push(Markup.button.callback("⬅️", `page:${Math.max(0, page - 1)}`));
    nav.push(Markup.button.callback(`Стр. ${page + 1}/${totalPages}`, "noop"));
    nav.push(Markup.button.callback("➡️", `page:${Math.min(totalPages - 1, page + 1)}`));
    rows.push(nav);
  }

  return Markup.inlineKeyboard(rows);
}

async function showComposer(ctx, page = 0) {
  const st = getState(ctx);
  const text =
`🧾 Создание заказа

Номер: ${st.orderNo || "—"}
Время: ${st.prepMinutes} мин

Корзина:
${cartSummary(st.cart)}

Нажимай блюда (➕), потом «✅ Готово».`;

  await ctx.reply(text, makeMenuKeyboard(page));
}

bot.start(async (ctx) => {
  if (denyIfNotAllowed(ctx)) return;

  const st = getState(ctx);
  st.step = "entering_order";
  st.cart = {};
  st.orderNo = "";
  st.prepMinutes = 25;

  await ctx.reply("Введите номер заказа (например: Grab 12345):");
});

bot.command("new", async (ctx) => {
  if (denyIfNotAllowed(ctx)) return;

  const st = getState(ctx);
  st.step = "entering_order";
  st.cart = {};
  st.orderNo = "";
  st.prepMinutes = 25;

  await ctx.reply("Ок. Введите номер заказа:");
});

bot.on("text", async (ctx) => {
  if (denyIfNotAllowed(ctx)) return;

  const st = getState(ctx);
  const txt = ctx.message.text.trim();

  if (st.step === "entering_order") {
    st.orderNo = txt;
    st.step = "entering_time";
    await ctx.reply("Введите время приготовления в минутах (например: 25):");
    return;
  }

  if (st.step === "entering_time") {
    const n = Number(txt);
    if (!Number.isFinite(n) || n < 1 || n > 240) {
      await ctx.reply("Введите число 1–240 (минут).");
      return;
    }
    st.prepMinutes = Math.floor(n);
    st.step = "selecting_items";
    await showComposer(ctx, 0);
    return;
  }

  // если просто прислали текст в другом состоянии — подсказка
  await ctx.reply('Команды: /new — новый заказ, /start — начать.');
});

// callbacks
bot.action("noop", async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action(/page:(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const page = Number(ctx.match[1]);
  if (denyIfNotAllowed(ctx)) return;
  await showComposer(ctx, page);
});

bot.action(/add:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (denyIfNotAllowed(ctx)) return;
  const st = getState(ctx);
  const name = ctx.match[1];
  st.cart[name] = (st.cart[name] || 0) + 1;
});

bot.action("clear", async (ctx) => {
  await ctx.answerCbQuery();
  if (denyIfNotAllowed(ctx)) return;
  const st = getState(ctx);
  st.cart = {};
  await ctx.reply("🧹 Корзина очищена.");
});

bot.action("remove_mode", async (ctx) => {
  await ctx.answerCbQuery();
  if (denyIfNotAllowed(ctx)) return;
  const st = getState(ctx);
  const keys = Object.keys(st.cart);
  if (!keys.length) {
    await ctx.reply("Корзина пустая — нечего убирать.");
    return;
  }

  const rows = keys.map((k) => [Markup.button.callback(`➖ ${k}`, `rem:${k}`)]);
  rows.push([Markup.button.callback("⬅️ Назад к меню", "back_to_menu")]);
  await ctx.reply("Выбери позицию, которую убрать (минус 1):", Markup.inlineKeyboard(rows));
});

bot.action(/rem:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (denyIfNotAllowed(ctx)) return;
  const st = getState(ctx);
  const name = ctx.match[1];
  const v = (st.cart[name] || 0) - 1;
  if (v <= 0) delete st.cart[name];
  else st.cart[name] = v;
  await ctx.reply(`Ок: ${name}`);
});

bot.action("back_to_menu", async (ctx) => {
  await ctx.answerCbQuery();
  if (denyIfNotAllowed(ctx)) return;
  await showComposer(ctx, 0);
});

bot.action("edit", async (ctx) => {
  await ctx.answerCbQuery();
  if (denyIfNotAllowed(ctx)) return;
  const st = getState(ctx);
  st.step = "entering_order";
  await ctx.reply("Введите номер заказа заново:");
});

bot.action("done", async (ctx) => {
  await ctx.answerCbQuery();
  if (denyIfNotAllowed(ctx)) return;

  const st = getState(ctx);
  const items = Object.entries(st.cart).map(([name, qty]) => ({ name, qty }));
  if (!st.orderNo.trim()) {
    await ctx.reply("❌ Нет номера заказа. Нажми /new");
    return;
  }
  if (!items.length) {
    await ctx.reply("❌ Корзина пустая. Добавь блюда.");
    return;
  }

  // Создаём заказ
  const createdAt = Date.now();
  const endsAt = createdAt + st.prepMinutes * 60_000;
  const expiresAt = endsAt + 5 * 60_000;

  const order = {
    id: uid(),
    orderNo: st.orderNo.trim(),
    prepMinutes: st.prepMinutes,
    createdAt,
    endsAt,
    expiresAt,
    items
  };

  orders.unshift(order);
  pruneAndLimit();
  io.emit("orders:update", orders);

  await ctx.reply(
    `✅ Отправлено на экран!\n\n` +
    `Номер: ${order.orderNo}\n` +
    `Время: ${order.prepMinutes} мин\n` +
    `Позиций: ${items.length}\n\n` +
    `Хочешь следующий? /new`
  );

  // Сброс
  st.step = "idle";
  st.cart = {};
  st.orderNo = "";
  st.prepMinutes = 25;
});

// ==========================
// 5) Запуск сервера и бота
// ==========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));

bot.launch().then(() => console.log("Bot launched (long polling)"));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// ==========================
// HTML экрана (TV)
// ==========================
function getScreenHtml() {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Kitchen Screen</title>
  <style>
    :root { --bg:#0b1220; --card:#111b31; --stroke:rgba(255,255,255,.10); --muted:rgba(255,255,255,.75); }
    html,body{margin:0;height:100%;background:var(--bg);color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial}
    .wrap{padding:14px}
    .top{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
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
    .qty{font-weight:900;opacity:.95}
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

    function tick(){
      document.getElementById("clock").textContent = new Date().toLocaleString();
      render();
    }

    function render(){
      const now = Date.now();
      const active = orders
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
            <div class="orderNo">\${escapeHtml(o.orderNo)}</div>
            <div class="timer">\${late ? "0:00" : fmt(remaining)}</div>
          </div>
          <div class="list">
            \${(o.items||[]).map(it=>\`
              <div class="item">
                <div class="name">\${escapeHtml(it.name)}</div>
                <div class="qty">×\${it.qty}</div>
              </div>
            \`).join("")}
          </div>
          \${late ? '<div class="done">Завершён (удалится через 5 минут)</div>' : ''}
        \`;
        grid.appendChild(card);
      });

      for(let i=active.length;i<10;i++){
        const empty = document.createElement("div");
        empty.className = "card empty";
        grid.appendChild(empty);
      }
    }

    function escapeHtml(s){
      return String(s).replace(/[&<>"']/g, c=>({
        "&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"
      }[c]));
    }

    socket.on("orders:update", (list)=>{
      orders = list || [];
      render();
    });

    setInterval(tick, 1000);
    tick();
  </script>
</body>
</html>`;
}

