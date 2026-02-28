// index.js — TV SAFE (old WebView compatible)
// Screen:  /   (or /screen)
// API:     /api/orders   (JSON)
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
// MENU
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
// ORDERS memory
// ==========================
let orders = []; // [{ id, orderNo, prepMinutes, createdAt, endsAt, expiresAt, items:[{name,qty}] }]

function pruneOrders() {
  const now = Date.now();
  orders = orders.filter((o) => o.expiresAt > now);
  orders.sort((a, b) => b.createdAt - a.createdAt);
  orders = orders.slice(0, 10);
}

function addKitchenOrder(orderNo, prepMinutes) {
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

// ==========================
// SCREEN HTML (10 windows fixed, up to 15 items visible)
// - orderNo/time font unchanged (as you asked)
// - items font tuned to fit 15 rows
// - no auto-fit loops => no font jumping
// ==========================
function screenHtml() {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Screen</title>
  <style>
    :root{
      --bg:#050813;
      --cell:#0f1730;
      --border:rgba(255,255,255,.12);
      --text:#ffffff;

      --green:#00ff66;
      --yellow:#ffd400;
      --red:#ff3b30;
      --ready:#aab2c2;

      /* anti-overscan */
      --safe: 40px;

      --gap: 10px;

      /* Items style tuned for up to 15 rows */
      --item-font: 14px;
      --item-line: 1.05;
      --item-pad-v: 4px;
      --item-pad-h: 8px;
      --item-gap: 6px;
      --item-radius: 12px;
    }

    *{ box-sizing:border-box; }
    html,body{ width:100%; height:100%; margin:0; }
    body{
      background:var(--bg);
      color:var(--text);
      overflow:hidden; /* FIXED 10 windows, no page scrolling */
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
    }

    .stage{
      position:fixed;
      left:var(--safe);
      right:var(--safe);
      top:var(--safe);
      bottom:var(--safe);
      overflow:hidden;
    }

    /* 10 карточек: 5 в ряд, 2 ряда */
    .wrap{
      width:100%;
      height:100%;
      display:flex;
      flex-wrap:wrap;
      align-content:stretch;
      justify-content:space-between;
      gap: var(--gap);
    }

    .card{
      width: calc((100% - (var(--gap) * 4)) / 5);
      height: calc((100% - var(--gap)) / 2);
      background:var(--cell);
      border:1px solid var(--border);
      border-radius:18px;
      overflow:hidden;
      display:flex;
      flex-direction:column;
      min-width:0;
      min-height:0;
      box-shadow:0 12px 30px rgba(0,0,0,.35);
    }

    .top{
      flex:0 0 auto;
      padding: 14px 16px 10px;
      border-bottom:1px solid rgba(255,255,255,.10);
      display:flex;
      align-items:flex-end;
      justify-content:space-between;
      gap: 10px;
      min-height:0;
    }

    /* ОСТАВЛЯЕМ КАК ЕСТЬ (шрифт номера/времени) */
    .orderNo{
      flex:1 1 auto;
      min-width:0;
      font-weight:1000;
      line-height:1.05;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      font-size: clamp(16px, 1.25vw, 34px);
    }
    .remain{
      flex:0 0 auto;
      font-weight:1000;
      line-height:1;
      white-space:nowrap;
      font-size: clamp(16px, 1.15vw, 32px);

      font-variant-numeric: tabular-nums;
      letter-spacing: 0.5px;
    }

    .items{
      flex:1 1 auto;
      padding: 10px 12px 12px;
      overflow:hidden; /* фиксируем 10 окон, поэтому режем по 15 строк */
      min-height:0;
      display:flex;
      flex-direction:column;
      gap: var(--item-gap);
    }

    .item{
      display:flex;
      align-items:center;
      gap: 8px;
      padding: var(--item-pad-v) var(--item-pad-h);
      border:1px solid rgba(255,255,255,.10);
      border-radius: var(--item-radius);
      background: rgba(255,255,255,.03);
      min-width:0;
    }

    /* ОДНА СТРОКА, чтобы уместить 15 позиций */
    .name{
      flex:1 1 auto;
      min-width:0;
      font-weight:950;
      line-height: var(--item-line);
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      font-size: var(--item-font);
    }
    .qty{
      flex:0 0 auto;
      font-weight:1000;
      color: rgba(255,255,255,.75);
      white-space:nowrap;
      font-size: var(--item-font);
      line-height: var(--item-line);
      font-variant-numeric: tabular-nums;
    }

    .placeholder{
      flex:1 1 auto;
      display:flex;
      align-items:center;
      justify-content:center;
      color:rgba(255,255,255,.28);
      font-weight:1000;
      text-align:center;
      padding: 10px;
      font-size: 18px;
    }

    .more{
      margin-top:auto;
      padding: 6px 10px;
      border:1px dashed rgba(255,255,255,.18);
      border-radius: 12px;
      color: rgba(255,255,255,.65);
      font-weight: 900;
      font-size: 13px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      background: rgba(0,0,0,.18);
    }

    .blink{
      animation: blink 0.9s steps(2,end) infinite;
    }
    @keyframes blink{
      0%{ filter:brightness(1); }
      50%{ filter:brightness(1.6); }
      100%{ filter:brightness(1); }
    }

    .dbg{
      position:fixed;
      left:10px;
      bottom:10px;
      font-size:12px;
      font-weight:900;
      color:rgba(255,255,255,.65);
      background: rgba(0,0,0,.25);
      border:1px solid rgba(255,255,255,.12);
      padding:8px 10px;
      border-radius:12px;
      z-index:9999;
      white-space:pre-wrap;
      pointer-events:none;
    }
  </style>
</head>
<body>
  <div class="stage">
    <div class="wrap" id="wrap"></div>
  </div>
  <div class="dbg" id="dbg">BOOT</div>

<script>
(function(){
  var wrap = document.getElementById('wrap');
  var dbg = document.getElementById('dbg');

  var TOTAL = 10;
  var MAX_ITEMS = 15;

  var lastSig = "";
  var hasRenderedOnce = false;

  function esc(s){
    s = String(s || "");
    return s.replace(/</g,"&lt;");
  }
  function pad2(n){
    n = String(n);
    return (n.length<2) ? ("0"+n) : n;
  }
  function mmss(ms){
    var s = Math.max(0, Math.floor(ms/1000));
    var m = Math.floor(s/60);
    var ss = s % 60;
    return String(m) + ":" + pad2(ss);
  }
  function remainColor(remMin){
    if (remMin <= 0) return "var(--ready)";
    if (remMin <= 10) return "var(--red)";
    if (remMin <= 25) return "var(--yellow)";
    return "var(--green)";
  }

  function makeCard(o){
    var card = document.createElement("div");
    card.className = "card";

    if (!o){
      card.innerHTML = '<div class="placeholder">—</div>';
      return card;
    }

    var items = (o.items && o.items.length) ? o.items : null;

    var itemsHtml = "";
    if (items){
      var shown = 0;
      for (var i=0; i<items.length && shown < MAX_ITEMS; i++){
        var it = items[i] || {};
        var name = esc(it.name);
        var qty = Number(it.qty || 0);
        itemsHtml += '<div class="item"><div class="name">'+name+'</div><div class="qty">x'+qty+'</div></div>';
        shown++;
      }

      if (items.length > MAX_ITEMS){
        var rest = items.length - MAX_ITEMS;
        itemsHtml += '<div class="more">+ ещё ' + rest + ' поз.</div>';
      }
    } else {
      itemsHtml = '<div class="placeholder">Выбор блюд…</div>';
    }

    card.innerHTML =
      '<div class="top">'+
        '<div class="orderNo">'+esc(o.orderNo || "—")+'</div>'+
        '<div class="remain" data-endsat="'+(o.endsAt||0)+'">--:--</div>'+
      '</div>'+
      '<div class="items">'+itemsHtml+'</div>';

    return card;
  }

  function render(list){
    wrap.innerHTML = "";
    for (var i=0;i<TOTAL;i++){
      var o = (list && list[i]) ? list[i] : null;
      wrap.appendChild(makeCard(o));
    }
    hasRenderedOnce = true;
    updateTimers();
  }

  function updateTimers(){
    if (!hasRenderedOnce) return;

    var now = Date.now();
    var nodes = wrap.querySelectorAll(".remain");
    for (var i=0;i<nodes.length;i++){
      var el = nodes[i];
      var endsAt = Number(el.getAttribute("data-endsat") || 0);
      if (!endsAt){
        el.textContent = "--:--";
        el.style.color = "rgba(255,255,255,.35)";
        continue;
      }

      var remMs = endsAt - now;
      var remMin = remMs / 60000;
      var color = remainColor(remMin);

      el.textContent = (remMs <= 0) ? "READY" : mmss(remMs);
      el.style.color = color;

      // blink если меньше 5 минут
      var card = el;
      while (card && (!card.className || card.className.indexOf("card") === -1)) card = card.parentNode;
      if (card){
        if (remMs > 0 && remMs <= 5*60*1000){
          if (card.className.indexOf("blink") === -1) card.className = "card blink";
        } else {
          card.className = "card";
        }
      }
    }
  }

  function xhrJson(url, cb){
    try{
      var x = new XMLHttpRequest();
      x.open("GET", url, true);
      x.onreadystatechange = function(){
        if (x.readyState === 4){
          if (x.status >= 200 && x.status < 300){
            try{
              var data = JSON.parse(x.responseText);
              cb(null, data);
            }catch(e){
              cb(new Error("JSON parse error"));
            }
          } else {
            cb(new Error("HTTP "+x.status));
          }
        }
      };
      x.send(null);
    }catch(e){
      cb(e);
    }
  }

  // сигнатура чтобы не перерисовывать постоянно (шрифты тогда не "пляшут")
  function signature(list){
    try{
      var slim = (list||[]).slice(0, TOTAL).map(function(o){
        if (!o) return null;
        return {
          id: o.id,
          orderNo: o.orderNo,
          endsAt: o.endsAt,
          // ограничим для сигнатуры первыми 15, чтобы сравнение было лёгким
          items: (o.items||[]).slice(0, MAX_ITEMS).map(function(it){ return [it.name, it.qty]; }),
          itemsLen: (o.items||[]).length
        };
      });
      return JSON.stringify(slim);
    }catch(e){
      return String(Date.now());
    }
  }

  function poll(){
    xhrJson("/api/orders", function(err, data){
      if (err){
        dbg.textContent = "API ERROR\\n" + String(err.message || err);
        return;
      }

      var list = data || [];
      var sig = signature(list);

      if (sig !== lastSig){
        lastSig = sig;
        render(list);
      }

      dbg.textContent = "API OK\\nORDERS: " + (list && list.length ? list.length : 0);
    });
  }

  // 1) таймеры — каждую секунду (без перерисовки)
  setInterval(updateTimers, 1000);

  // 2) заказы — раз в 2500мс (перерисовка только если изменились)
  poll();
  setInterval(poll, 2500);
})();
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
  const id = ctx.from && ctx.from.id;
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

    // ✅ стартуем таймер сразу (пока выбирают блюда)
    st.orderId = addKitchenOrder(st.orderNo.trim(), st.prepMinutes);

    st.step = "selecting_items";
    await ctx.reply(`⏱ Таймер уже идет на ТВ: ${PUBLIC_URL}/screen`, mainKeyboard());
    await showCategories(ctx);
    return;
  }

  await ctx.reply("Нажми «Новый заказ».", mainKeyboard());
});

// callbacks
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
  await ctx.reply(\`Ок: \${name}\`, mainKeyboard());
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

  await ctx.reply(\`✅ Блюда появились на ТВ\`, mainKeyboard());

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
