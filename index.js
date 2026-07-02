// index.js — TV SAFE + Manual orders + Screenshot OCR orders
// Screen:  /   (or /screen)
// API:     /api/orders   (JSON)
// Webhook: /tg/<WEBHOOK_SECRET>

import express from "express";
import http from "http";
import crypto from "crypto";
import { Telegraf, Markup, session } from "telegraf";
import OpenAI from "openai";

// ==========================
// ENV
// ==========================
const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");
if (!PUBLIC_URL) throw new Error("PUBLIC_URL is not set");
if (!WEBHOOK_SECRET) throw new Error("WEBHOOK_SECRET is not set");

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

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
const BTN_NEW_SCREENSHOT = "📸 Новый заказ screenshot";

const BTN_SEND = "✅ Отправить на ТВ";
const BTN_CLEAR = "🧹 Очистить";
const BTN_EDIT = "✏️ Изменить №/время";
const BTN_REMOVE_MODE = "➖ Убрать позицию";
const BTN_BACK_CATS = "⬅️ Категории";

const BTN_OCR_READ = "✅ Читать скриншоты";
const BTN_OCR_CONFIRM = "✅ Подтвердить";
const BTN_OCR_DELETE = "❌ Удалить заказ";
const BTN_OCR_SEND_TV = "✅ Отправить на ТВ";
const BTN_OCR_ADD_ITEM = "➕ Добавить блюдо";
const BTN_OCR_BACK = "⬅️ Назад к заказу";
// ==========================
// MENU
// ==========================
const CATEGORIES = [
  { key: "soups", label: "🍲 Супы" },
  { key: "mains", label: "🍛 Основные блюда" },
  { key: "sides", label: "🍟 Дополнительные блюда" },
  { key: "grill", label: "🔥 Гриль" },
  { key: "gastronomy", label: "🔥 Гастрономия" },
  { key: "salads", label: "🥗 Салаты" },
];

const MENU_BY_CAT = {
  soups: ["Кур бульон S1", "Борщ S2", "Гороховый суп S3", "Грибной суп S5", "Окрошка S5", "Солянка S4"],

  gastronomy: ["Ребро варкоп", "Джерки"],

  mains: [
    "Пельмени M1",
    "Зраза M2",
    "Драники M3",
    "Карошка фри M4",
    "Картошка дольки M5",
    "Мини чебуреки M6",
    "Киевская - пюре M7",
    "Киевская - дольки M8",
    "Лепешка с рваной БИГ M9",
    "Лепешка с рваной СМОЛ M10",
    "Лепешка с картошкой БИГ M11",
    "Лепешка с картошкой СМОЛ M12",
    "Лепешка сыр БИГ M13",
    "Лепешка сыр СМОЛ M14",
    "Вареники M15",
    "Пельмени M16",
    "Бефстроганов M17",
    "Фаршированный перец M18",
    "Котлеты мясные M19",
    "Котлеты куриные M20",
    "Свиной рулет M21",
    "Куриный рулет M22",
    "Говяжий рулет M23",
    "Туш капуста M24",
  ],

  sides: [
    "Пелюстка",
    "Соленое сало",
    "Сметана",
    "Лаваш",
    "Кетчуп",
    "Острая морковь",
    "Бочковой огурец",
    "Халапеньо",
    "Корнишон",
    "Свежий огурец",
    "Майонез",
  ],

  grill: [
    "Рёбра BBQ G1",
    "Шашлык свиной G2",
    "Шашлык куриный G3",
    "Куриный 2.0 G6",
    "Кебаб свин-гов G4",
    "Кебаб курица G5",
    "Wings кур G7",
  ],

  salads: [
    "Столичный T1",
    "Деревенский T2",
    "Обжорка T3",
    "Цезарь T4",
    "Овощ Смет T6",
    "Овощ Майо T7",
    "Овощ Масло T8",
    "Баклажаны T5",
    "Сrab T9",
  ],
};
// ==========================
// ORDERS memory
// ==========================
// [{ id, orderNo, prepMinutes, createdAt, endsAt, expiresAt, cutlery, items:[{name,qty}] }]
// cutlery: true  => Cutlery required
// cutlery: false => Dont need cutlery
// cutlery: null  => not answered
let orders = [];

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

  const order = {
    id: crypto.randomUUID(),
    orderNo,
    prepMinutes,
    createdAt,
    endsAt,
    expiresAt,
    cutlery: null,
    items: [],
  };

  orders.unshift(order);
  pruneOrders();

  return order.id;
}

function updateKitchenOrderItems(orderId, items) {
  const idx = orders.findIndex((o) => o.id === orderId);
  if (idx === -1) return false;

  orders[idx].items = Array.isArray(items) ? items : [];
  pruneOrders();

  return true;
}

function updateKitchenOrderCutlery(orderId, cutlery) {
  const idx = orders.findIndex((o) => o.id === orderId);
  if (idx === -1) return false;

  orders[idx].cutlery = !!cutlery;
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

app.use(express.json({ limit: "5mb" }));

app.get("/api/orders", (_req, res) => {
  pruneOrders();

  res.setHeader("Cache-Control", "no-store");
  res.json(orders);
});
// ==========================
// SCREEN HTML
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

      --safe: 40px;
      --gap: 10px;

      --item-font: 14px;
      --item-line: 1.05;
      --item-pad-v: 4px;
      --item-pad-h: 8px;
      --item-gap: 6px;
      --item-radius: 12px;
    }

    *{ box-sizing:border-box; }

    html,body{
      width:100%;
      height:100%;
      margin:0;
    }

    body{
      background:var(--bg);
      color:var(--text);
      overflow:hidden;
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

    .cutlery{
      flex:0 0 auto;
      padding: 2px 16px 0;
      font-weight: 1000;
      font-size: 14px;
      letter-spacing: .2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .cutlery.green{ color: var(--green); }
    .cutlery.red{ color: var(--red); }

    .items{
      flex:1 1 auto;
      padding: 10px 12px 12px;
      overflow:hidden;
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
    return (n.length < 2) ? ("0" + n) : n;
  }

  function mmss(ms){
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60);
    var ss = s % 60;
    return String(m) + ":" + pad2(ss);
  }

  function remainColor(remMin){
    if (remMin <= 0) return "var(--ready)";
    if (remMin <= 10) return "var(--red)";
    if (remMin <= 25) return "var(--yellow)";
    return "var(--green)";
  }

  function cutleryHtml(o){
    if (!o || (o.cutlery !== true && o.cutlery !== false)) return "";

    if (o.cutlery === true){
      return '<div class="cutlery green">Cutlery required</div>';
    }

    return '<div class="cutlery red">Dont need cutlery</div>';
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

      for (var i = 0; i < items.length && shown < MAX_ITEMS; i++){
        var it = items[i] || {};
        var name = esc(it.name);
        var qty = Number(it.qty || 0);

        itemsHtml +=
          '<div class="item">' +
            '<div class="name">' + name + '</div>' +
            '<div class="qty">x' + qty + '</div>' +
          '</div>';

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
      '<div class="top">' +
        '<div class="orderNo">' + esc(o.orderNo || "—") + '</div>' +
        '<div class="remain" data-endsat="' + (o.endsAt || 0) + '">--:--</div>' +
      '</div>' +
      cutleryHtml(o) +
      '<div class="items">' + itemsHtml + '</div>';

    return card;
  }

  function render(list){
    wrap.innerHTML = "";

    for (var i = 0; i < TOTAL; i++){
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

    for (var i = 0; i < nodes.length; i++){
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

      var card = el;

      while (card && (!card.className || card.className.indexOf("card") === -1)) {
        card = card.parentNode;
      }

      if (card){
        if (remMs > 0 && remMs <= 5 * 60 * 1000){
          if (card.className.indexOf("blink") === -1) {
            card.className = "card blink";
          }
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
            cb(new Error("HTTP " + x.status));
          }
        }
      };

      x.send(null);
    }catch(e){
      cb(e);
    }
  }

  function signature(list){
    try{
      var slim = (list || []).slice(0, TOTAL).map(function(o){
        if (!o) return null;

        return {
          id: o.id,
          orderNo: o.orderNo,
          endsAt: o.endsAt,
          cutlery: o.cutlery,
          items: (o.items || []).slice(0, MAX_ITEMS).map(function(it){
            return [it.name, it.qty];
          }),
          itemsLen: (o.items || []).length
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

  setInterval(updateTimers, 1000);
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

bot.catch((err) => {
  console.error("BOT ERROR:", err);
});

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

      // common
      orderNo: "",
      prepMinutes: 25,
      cart: {},
      cat: null,
      orderId: null,
      cutlery: null,

      // screenshot mode
      screenshotPhotos: [],
      screenshotMode: false,
    };
  }

  return ctx.session.state;
}

function resetState(st) {
  if (st.orderId) deleteKitchenOrder(st.orderId);

  st.step = "idle";
  st.orderNo = "";
  st.prepMinutes = 25;
  st.cart = {};
  st.cat = null;
  st.orderId = null;
  st.cutlery = null;

  st.screenshotPhotos = [];
  st.screenshotMode = false;
}

function mainKeyboard() {
  return Markup.keyboard([
    [BTN_NEW],
    [BTN_NEW_SCREENSHOT],
  ])
    .resize()
    .oneTime(false);
}

function cartSummary(cart) {
  const entries = Object.entries(cart || {});

  if (!entries.length) return "— пусто —";

  return entries
    .map(([name, qty]) => "• " + name + "    x" + qty)
    .join("\n");
}

function cartToItems(cart) {
  return Object.entries(cart || {}).map(([name, qty]) => ({
    name,
    qty,
  }));
}

function categoriesKeyboard() {
  const rows = [];

  for (let i = 0; i < CATEGORIES.length; i += 2) {
    const a = CATEGORIES[i];
    const b = CATEGORIES[i + 1];

    const row = [Markup.button.callback(a.label, "cat:" + a.key)];

    if (b) row.push(Markup.button.callback(b.label, "cat:" + b.key));

    rows.push(row);
  }

  rows.push([
    Markup.button.callback(BTN_CLEAR, "clear"),
    Markup.button.callback(BTN_SEND, "send"),
  ]);

  rows.push([
    Markup.button.callback(BTN_EDIT, "edit"),
    Markup.button.callback(BTN_REMOVE_MODE, "remove_mode"),
  ]);

  return Markup.inlineKeyboard(rows);
}

function dishesKeyboard(catKey) {
  const dishes = MENU_BY_CAT[catKey] || [];
  const rows = [];

  for (let i = 0; i < dishes.length; i += 2) {
    const a = dishes[i];
    const b = dishes[i + 1];

    const row = [Markup.button.callback("➕ " + a, "add:" + a)];

    if (b) row.push(Markup.button.callback("➕ " + b, "add:" + b));

    rows.push(row);
  }

  rows.push([
    Markup.button.callback(BTN_BACK_CATS, "cats"),
    Markup.button.callback(BTN_CLEAR, "clear"),
  ]);

  rows.push([
    Markup.button.callback(BTN_SEND, "send"),
    Markup.button.callback(BTN_REMOVE_MODE, "remove_mode"),
  ]);

  rows.push([Markup.button.callback(BTN_EDIT, "edit")]);

  return Markup.inlineKeyboard(rows);
}

function cutleryKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Да", "cutlery:yes"),
      Markup.button.callback("❌ Нет", "cutlery:no"),
    ],
  ]);
}

async function askCutlery(ctx) {
  await ctx.reply("Нужны столовые приборы? (да/нет)", cutleryKeyboard());
}

function parseYesNo(txt) {
  const t = String(txt || "").trim().toLowerCase();

  const yes = ["да", "y", "yes", "1", "true", "угу", "нужны", "need", "ok", "✅"];
  const no = ["нет", "n", "no", "0", "false", "не", "не нужны", "dont", "don't", "❌"];

  if (yes.includes(t)) return true;
  if (no.includes(t)) return false;

  if (t.startsWith("да")) return true;
  if (t.startsWith("нет")) return false;
  if (t.startsWith("yes")) return true;
  if (t.startsWith("no")) return false;

  return null;
}
async function showCategories(ctx) {
  const st = getState(ctx);

  const text =
    "🧾 Создание заказа\n\n" +
    "Номер: " + (st.orderNo || "—") + "\n" +
    "Время: " + st.prepMinutes + " мин\n" +
    "Приборы: " +
    (st.cutlery === true ? "Да" : st.cutlery === false ? "Нет" : "—") +
    "\n\n" +
    "Корзина:\n" +
    cartSummary(st.cart) +
    "\n\nВыбери категорию:";

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
    "📂 " + catLabel + "\n\n" +
    "Номер: " + (st.orderNo || "—") + " | Время: " + st.prepMinutes + " мин\n" +
    "Приборы: " +
    (st.cutlery === true ? "Да" : st.cutlery === false ? "Нет" : "—") +
    "\n\n" +
    "Корзина:\n" +
    cartSummary(st.cart) +
    "\n\nНажимай блюда (➕):";

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
// ==========================
// MANUAL MODE CALLBACKS
// ==========================
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

  resetState(st);
  st.step = "entering_order";

  await ctx.reply(
    "Введите номер заказа заново:",
    mainKeyboard()
  );
});

bot.action("remove_mode", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  const keys = Object.keys(st.cart || {});

  if (!keys.length) {
    await ctx.reply("Корзина пустая.");
    return;
  }

  const rows = keys.map((name) => [
    Markup.button.callback(
      "➖ " + name + " (x" + st.cart[name] + ")",
      "rem:" + name
    ),
  ]);

  rows.push([
    Markup.button.callback(
      "⬅️ Назад",
      st.cat ? "back_to_dishes" : "cats"
    ),
  ]);

  await ctx.reply(
    "Выбери позицию для удаления:",
    Markup.inlineKeyboard(rows)
  );
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

  const nextQty = (st.cart[name] || 0) - 1;

  if (nextQty <= 0) delete st.cart[name];
  else st.cart[name] = nextQty;

  if (st.cat) await showDishes(ctx, st.cat);
  else await showCategories(ctx);
});
// ==========================
// SCREENSHOT OCR HELPERS
// ==========================
function allMenuNames() {
  return Object.values(MENU_BY_CAT).flat();
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findBestMenuName(rawName) {
  const raw = normalizeText(rawName);

  if (!raw) return null;

  const menu = allMenuNames();

  let bestName = null;
  let bestScore = 0;

  for (const menuName of menu) {
    const m = normalizeText(menuName);

    let score = 0;

    if (raw === m) {
      score = 100;
    } else if (raw.includes(m) || m.includes(raw)) {
      score = 85;
    } else {
      const rawParts = raw.split(" ").filter(Boolean);
      const menuParts = m.split(" ").filter(Boolean);

      let hits = 0;

      for (const p of menuParts) {
        if (rawParts.includes(p)) hits++;
      }

      score = hits * 25;
    }

    if (score > bestScore) {
      bestScore = score;
      bestName = menuName;
    }
  }

  return bestScore >= 40 ? bestName : null;
}

function safeJsonParse(text) {
  const cleaned = String(text || "")
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      orderNo: "",
      cutlery: null,
      items: [],
    };
  }
}

async function recognizeScreenshots(ctx, fileIds) {
  if (!openai) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const imageUrls = [];

  for (const fileId of fileIds) {
    const link = await ctx.telegram.getFileLink(fileId);
    imageUrls.push(link.href);
  }

  const menuText = allMenuNames().join("\n");

  const content = [
    {
      type: "text",
      text:
        "Ты читаешь скриншоты заказа из ресторана. " +
        "На скриншотах может быть один заказ, разбитый на 1, 2 или 3 изображения. " +

        "Нужно найти номер заказа, блюда, количество и ВСЕ дополнительные позиции. " +

        "Важно: если под основным блюдом есть блок, строка или подпись типа Add item, Add-on, Extra, Option, Topping, Modifier, Note item, " +
        "то все позиции под этим блоком тоже нужно добавить в items как отдельные блюда. " +

        "Например, если в заказе есть:\n" +
        "Борщ x1\n" +
        "Add item: Сметана x1\n" +
        "Add item: Лаваш x1\n" +
        "то нужно вернуть:\n" +
        '{"name":"Борщ S2","qty":1},{"name":"Сметана","qty":1},{"name":"Лаваш","qty":1}\n\n' +

        "Используй только позиции из списка меню ниже. " +
"Названия в заказе могут отличаться от названий в меню. " +
"Ты обязан сопоставлять похожие названия. " +

"Примеры сопоставления: " +
"'Салат из острой моркови' = 'Острая морковь'. " +
"'Шашлык из курицы' = 'Шашлык куриный G3'. " +
"'Салат деревенский' = 'Деревенский T2'. " +
"'Домашний кетчуп' = 'Кетчуп'. " +
"'Маринованный халапеньо' = 'Халапеньо'. " +

"Если название блюда очень похоже по смыслу, но отличается словами, выбери наиболее подходящую позицию из меню. " +
"Не пропускай блюдо только потому, что название отличается. " +

"Все позиции, находящиеся под надписью Add item, являются частью заказа и должны быть добавлены в итоговый список items. " +
"Add item не является комментарием или примечанием. " +
"Каждая позиция под Add item должна быть распознана как отдельное блюдо. " +

"Не игнорируй дополнительные блюда, соусы, сметану, лаваш, кетчуп, огурцы, морковь, халапеньо, сало и другие add item. " +
"Пример: если заказ содержит 'Шашлык из курицы' и под ним Add item -> 'Салат из острой моркови', то результат должен содержать две позиции: 'Шашлык куриный G3' и 'Острая морковь'. " +

        "Если на скриншоте есть информация о приборах/cutlery, верни cutlery true или false. " +
        "Если про приборы информации нет, верни cutlery null. " +

        "Верни строго JSON без markdown, без пояснений. " +
        "Формат JSON: " +
        '{"orderNo":"GF-123","cutlery":true,"items":[{"name":"Борщ S2","qty":1},{"name":"Сметана","qty":1}]} ' +

        "\n\nСПИСОК МЕНЮ:\n" +
        menuText,
    },
  ];

  for (const url of imageUrls) {
    content.push({
      type: "image_url",
      image_url: {
        url,
      },
    });
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content,
      },
    ],
    temperature: 0,
  });

  const answer = response.choices?.[0]?.message?.content || "{}";
  const parsed = safeJsonParse(answer);

  const cart = {};

  for (const item of parsed.items || []) {
    const matchedName = findBestMenuName(item.name);

    if (!matchedName) continue;

    const qty = Math.max(1, Math.floor(Number(item.qty || 1)));

    cart[matchedName] = (cart[matchedName] || 0) + qty;
  }

  let cutlery = null;

  if (parsed.cutlery === true) cutlery = true;
  if (parsed.cutlery === false) cutlery = false;

  return {
    orderNo: String(parsed.orderNo || "").trim(),
    cutlery,
    cart,
  };
}
function screenshotUploadKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(BTN_OCR_READ, "ocr_read")],
    [Markup.button.callback(BTN_OCR_DELETE, "ocr_cancel")],
  ]);
}

function screenshotEditText(st) {
  return (
    "📸 Заказ из screenshot\n\n" +
    "Номер: " + (st.orderNo || "—") + "\n" +
    "Время: " + (st.prepMinutes || 25) + " мин\n" +
    "Приборы: " +
    (st.cutlery === true ? "Да" : st.cutlery === false ? "Нет" : "—") +
    "\n\n" +
    "Блюда:\n" +
    cartSummary(st.cart) +
    "\n\nПроверь список. Можно исправить количество через ➖ / ➕."
  );
}

function screenshotEditKeyboard(st) {
  const rows = [];

  const entries = Object.entries(st.cart || {});

  for (const [name, qty] of entries) {
    rows.push([
      Markup.button.callback("➖", "ocr_minus:" + name),
      Markup.button.callback(name + " x" + qty, "noop"),
      Markup.button.callback("➕", "ocr_plus:" + name),
    ]);
  }

  rows.push([Markup.button.callback(BTN_OCR_ADD_ITEM, "ocr_add_item")]);

  rows.push([
    Markup.button.callback("🍴 Приборы: Да", "ocr_cutlery_yes"),
    Markup.button.callback("🚫 Приборы: Нет", "ocr_cutlery_no"),
  ]);

  rows.push([
    Markup.button.callback(BTN_OCR_CONFIRM, "ocr_confirm"),
    Markup.button.callback(BTN_OCR_DELETE, "ocr_cancel"),
  ]);

  return Markup.inlineKeyboard(rows);
}

function screenshotAddCategoryKeyboard() {
  const rows = [];

  for (let i = 0; i < CATEGORIES.length; i += 2) {
    const a = CATEGORIES[i];
    const b = CATEGORIES[i + 1];

    const row = [Markup.button.callback(a.label, "ocr_cat:" + a.key)];

    if (b) row.push(Markup.button.callback(b.label, "ocr_cat:" + b.key));

    rows.push(row);
  }

  rows.push([Markup.button.callback(BTN_OCR_BACK, "ocr_back")]);

  return Markup.inlineKeyboard(rows);
}

function screenshotAddDishesKeyboard(catKey) {
  const dishes = MENU_BY_CAT[catKey] || [];
  const rows = [];

  for (let i = 0; i < dishes.length; i += 2) {
    const a = dishes[i];
    const b = dishes[i + 1];

    const row = [Markup.button.callback("➕ " + a, "ocr_add:" + a)];

    if (b) row.push(Markup.button.callback("➕ " + b, "ocr_add:" + b));

    rows.push(row);
  }

  rows.push([
    Markup.button.callback("⬅️ Категории", "ocr_add_item"),
    Markup.button.callback(BTN_OCR_BACK, "ocr_back"),
  ]);

  return Markup.inlineKeyboard(rows);
}
// ==========================
// START / MAIN BUTTONS
// ==========================
bot.start(async (ctx) => {
  if (await deny(ctx)) return;

  const st = getState(ctx);
  resetState(st);

  await ctx.reply(
    "Готово. Выбери способ создания заказа.",
    mainKeyboard()
  );
});

bot.hears(BTN_NEW, async (ctx) => {
  if (await deny(ctx)) return;

  const st = getState(ctx);
  resetState(st);

  st.step = "entering_order";

  await ctx.reply(
    "Введите номер заказа, например GF-254:",
    mainKeyboard()
  );
});

bot.hears(BTN_NEW_SCREENSHOT, async (ctx) => {
  if (await deny(ctx)) return;

  const st = getState(ctx);
  resetState(st);

  st.step = "screenshot_waiting";
  st.screenshotMode = true;
  st.screenshotPhotos = [];

  await ctx.reply(
    "📸 Отправь 1–3 скриншота одного заказа.\n\n" +
      "Когда все скриншоты отправлены — нажми «✅ Читать скриншоты».",
    screenshotUploadKeyboard()
  );
});
// ==========================
// SCREENSHOT PHOTO INPUT
// ==========================
bot.on("photo", async (ctx) => {
  if (await deny(ctx)) return;

  const st = getState(ctx);

  if (st.step !== "screenshot_waiting") {
    await ctx.reply(
      "Фото получено, но сейчас не включен режим screenshot-заказа.\n\n" +
        "Нажми «📸 Новый заказ screenshot».",
      mainKeyboard()
    );
    return;
  }

  if (st.screenshotPhotos.length >= 3) {
    await ctx.reply(
      "Можно максимум 3 скриншота на один заказ.\n\n" +
        "Если все скриншоты уже отправлены — нажми «✅ Читать скриншоты».",
      screenshotUploadKeyboard()
    );
    return;
  }

  const photos = ctx.message.photo || [];
  const bestPhoto = photos[photos.length - 1];

  if (!bestPhoto || !bestPhoto.file_id) {
    await ctx.reply("Не удалось получить фото. Отправь скриншот еще раз.");
    return;
  }

  st.screenshotPhotos.push(bestPhoto.file_id);

  await ctx.reply(
    "✅ Скриншот добавлен: " +
      st.screenshotPhotos.length +
      "/3\n\n" +
      "Можешь отправить еще скриншот или нажать «✅ Читать скриншоты».",
    screenshotUploadKeyboard()
  );
});
// ==========================
// TEXT INPUT
// ==========================
bot.on("text", async (ctx) => {
  if (await deny(ctx)) return;

  const st = getState(ctx);
  const txt = (ctx.message.text || "").trim();

  if (txt === BTN_NEW || txt === BTN_NEW_SCREENSHOT) return;

  // ==========================
  // MANUAL MODE: order number
  // ==========================
  if (st.step === "entering_order") {
    if (st.orderId) deleteKitchenOrder(st.orderId);

    st.orderNo = txt;
    st.step = "entering_time";

    await ctx.reply(
      "Введите время приготовления, минуты 1–240.\nНапример: 20",
      mainKeyboard()
    );

    return;
  }

  // ==========================
  // MANUAL MODE: prep time
  // ==========================
  if (st.step === "entering_time") {
    const n = Number(txt);

    if (!Number.isFinite(n) || n < 1 || n > 240) {
      await ctx.reply("Введите число от 1 до 240.", mainKeyboard());
      return;
    }

    st.prepMinutes = Math.floor(n);

    if (!st.orderNo.trim()) {
      await ctx.reply(
        "❌ Нет номера заказа. Нажми «🧾 Новый заказ».",
        mainKeyboard()
      );

      st.step = "idle";
      return;
    }

    // Таймер стартует сразу, как в старой логике
    st.orderId = addKitchenOrder(st.orderNo.trim(), st.prepMinutes);

    st.step = "entering_cutlery";

    await ctx.reply(
      "⏱ Таймер уже идет на ТВ:\n" + PUBLIC_URL + "/screen",
      mainKeyboard()
    );

    await askCutlery(ctx);
    return;
  }

  // ==========================
  // MANUAL MODE: cutlery yes/no
  // ==========================
  if (st.step === "entering_cutlery") {
    if (!st.orderId) {
      await ctx.reply(
        "❌ Заказ на экране не найден. Создай заказ заново.",
        mainKeyboard()
      );

      st.step = "idle";
      return;
    }

    const val = parseYesNo(txt);

    if (val === null) {
      await ctx.reply("Ответь «да» или «нет».", mainKeyboard());
      await askCutlery(ctx);
      return;
    }

    st.cutlery = val;

    const ok = updateKitchenOrderCutlery(st.orderId, val);

    if (!ok) {
      await ctx.reply(
        "❌ Заказ на экране не найден. Создай заказ заново.",
        mainKeyboard()
      );

      st.step = "idle";
      return;
    }

    st.step = "selecting_items";

    await showCategories(ctx);
    return;
  }

  // ==========================
  // SCREENSHOT MODE: enter order number manually if OCR did not find it
  // ==========================
  if (st.step === "screenshot_entering_order_no") {
    st.orderNo = txt || "SCREENSHOT";
    st.step = "screenshot_editing";

    await ctx.reply(
      screenshotEditText(st),
      screenshotEditKeyboard(st)
    );

    return;
  }

  // ==========================
  // SCREENSHOT MODE: prep time after confirmation
  // ==========================
  if (st.step === "screenshot_entering_time") {
    const n = Number(txt);

    if (!Number.isFinite(n) || n < 1 || n > 240) {
      await ctx.reply("Введите число от 1 до 240.", mainKeyboard());
      return;
    }

    st.prepMinutes = Math.floor(n);

    if (!st.orderNo.trim()) {
      st.orderNo = "SCREENSHOT";
    }

    if (st.orderId) deleteKitchenOrder(st.orderId);

    // В screenshot-режиме таймер стартует после указания времени
    st.orderId = addKitchenOrder(st.orderNo.trim(), st.prepMinutes);

    if (st.cutlery === true || st.cutlery === false) {
      updateKitchenOrderCutlery(st.orderId, st.cutlery);
    }

    st.step = "screenshot_ready_to_send";

    await ctx.reply(
      "✅ Время установлено: " +
        st.prepMinutes +
        " мин.\n\nТеперь нажми «✅ Отправить на ТВ».",
      Markup.inlineKeyboard([
        [Markup.button.callback(BTN_OCR_SEND_TV, "ocr_send_tv")],
        [Markup.button.callback(BTN_OCR_DELETE, "ocr_cancel")],
      ])
    );

    return;
  }

  await ctx.reply(
    "Выбери способ создания заказа.",
    mainKeyboard()
  );
});
// ==========================
// MANUAL MODE CUTLERY CALLBACKS
// ==========================
bot.action("cutlery:yes", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);

  if (st.step !== "entering_cutlery") {
    await ctx.reply("Ок.", mainKeyboard());
    return;
  }

  if (!st.orderId) {
    await ctx.reply(
      "❌ Заказ на экране не найден. Создай заказ заново.",
      mainKeyboard()
    );

    st.step = "idle";
    return;
  }

  st.cutlery = true;

  const ok = updateKitchenOrderCutlery(st.orderId, true);

  if (!ok) {
    await ctx.reply(
      "❌ Заказ на экране не найден. Создай заказ заново.",
      mainKeyboard()
    );

    st.step = "idle";
    return;
  }

  st.step = "selecting_items";

  await showCategories(ctx);
});

bot.action("cutlery:no", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);

  if (st.step !== "entering_cutlery") {
    await ctx.reply("Ок.", mainKeyboard());
    return;
  }

  if (!st.orderId) {
    await ctx.reply(
      "❌ Заказ на экране не найден. Создай заказ заново.",
      mainKeyboard()
    );

    st.step = "idle";
    return;
  }

  st.cutlery = false;

  const ok = updateKitchenOrderCutlery(st.orderId, false);

  if (!ok) {
    await ctx.reply(
      "❌ Заказ на экране не найден. Создай заказ заново.",
      mainKeyboard()
    );

    st.step = "idle";
    return;
  }

  st.step = "selecting_items";

  await showCategories(ctx);
});

bot.action("send", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);

  if (st.step === "entering_cutlery") {
    await ctx.reply(
      "❌ Сначала ответь про приборы: да или нет.",
      mainKeyboard()
    );
    return;
  }

  const items = cartToItems(st.cart);

  if (!st.orderId) {
    await ctx.reply(
      "❌ Сначала введи номер и время.",
      mainKeyboard()
    );
    return;
  }

  if (!items.length) {
    await ctx.reply(
      "❌ Корзина пустая.",
      mainKeyboard()
    );
    return;
  }

  const ok = updateKitchenOrderItems(st.orderId, items);

  if (!ok) {
    await ctx.reply(
      "❌ Заказ на экране не найден. Создай заказ заново.",
      mainKeyboard()
    );
    return;
  }

  await ctx.reply(
  "✅ Блюда появились на ТВ.",
  mainKeyboard()
);

// очищаем состояние бота,
// но НЕ удаляем заказ с ТВ
st.step = "idle";
st.orderNo = "";
st.prepMinutes = 25;
st.cart = {};
st.cat = null;
st.orderId = null;
st.cutlery = null;
st.screenshotPhotos = [];
st.screenshotMode = false;
});
// ==========================
// SCREENSHOT MODE CALLBACKS
// ==========================
bot.action("noop", async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action("ocr_read", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);

  if (st.step !== "screenshot_waiting") {
    await ctx.reply(
      "Сначала нажми «📸 Новый заказ screenshot».",
      mainKeyboard()
    );
    return;
  }

  if (!st.screenshotPhotos.length) {
    await ctx.reply(
      "Сначала отправь хотя бы один скриншот.",
      screenshotUploadKeyboard()
    );
    return;
  }

  await ctx.reply("⏳ Читаю скриншоты...");

  try {
    const result = await recognizeScreenshots(ctx, st.screenshotPhotos);

    st.orderNo = result.orderNo || "";
    st.cutlery = result.cutlery;
    st.cart = result.cart || {};
    st.step = "screenshot_editing";

    if (!st.orderNo) {
      st.step = "screenshot_entering_order_no";

      await ctx.reply(
        "Бот прочитал скриншоты, но не нашел номер заказа.\n\nВведите номер заказа вручную:",
        mainKeyboard()
      );

      return;
    }

    await ctx.reply(
      screenshotEditText(st),
      screenshotEditKeyboard(st)
    );
  } catch (e) {
    console.error("OCR ERROR:", e);

    await ctx.reply(
      "❌ Не удалось прочитать скриншоты.\n\n" +
        "Проверь OPENAI_API_KEY и попробуй отправить скриншоты еще раз.",
      mainKeyboard()
    );

    resetState(st);
  }
});

bot.action(/ocr_plus:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  const name = ctx.match[1];

  st.cart[name] = (st.cart[name] || 0) + 1;

  await ctx.editMessageText(
    screenshotEditText(st),
    screenshotEditKeyboard(st)
  );
});

bot.action(/ocr_minus:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  const name = ctx.match[1];

  const nextQty = (st.cart[name] || 0) - 1;

  if (nextQty <= 0) {
    delete st.cart[name];
  } else {
    st.cart[name] = nextQty;
  }

  await ctx.editMessageText(
    screenshotEditText(st),
    screenshotEditKeyboard(st)
  );
});

bot.action("ocr_cutlery_yes", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  st.cutlery = true;

  await ctx.editMessageText(
    screenshotEditText(st),
    screenshotEditKeyboard(st)
  );
});

bot.action("ocr_cutlery_no", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  st.cutlery = false;

  await ctx.editMessageText(
    screenshotEditText(st),
    screenshotEditKeyboard(st)
  );
});
bot.action("ocr_add_item", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  await ctx.reply(
    "Выбери категорию, из которой нужно добавить блюдо:",
    screenshotAddCategoryKeyboard()
  );
});

bot.action(/ocr_cat:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const catKey = ctx.match[1];
  const catLabel = CATEGORIES.find((c) => c.key === catKey)?.label || catKey;

  await ctx.reply(
    "📂 " + catLabel + "\n\nВыбери блюдо для добавления:",
    screenshotAddDishesKeyboard(catKey)
  );
});

bot.action(/ocr_add:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);
  const name = ctx.match[1];

  st.cart[name] = (st.cart[name] || 0) + 1;

  await ctx.reply(
    screenshotEditText(st),
    screenshotEditKeyboard(st)
  );
});

bot.action("ocr_back", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);

  await ctx.reply(
    screenshotEditText(st),
    screenshotEditKeyboard(st)
  );
});
bot.action("ocr_confirm", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);

  const items = cartToItems(st.cart);

  if (!items.length) {
    await ctx.reply(
      "❌ В заказе нет блюд. Добавь блюдо или удали заказ.",
      screenshotEditKeyboard(st)
    );
    return;
  }

  if (!st.orderNo.trim()) {
    st.step = "screenshot_entering_order_no";

    await ctx.reply(
      "Введите номер заказа:",
      mainKeyboard()
    );

    return;
  }

  st.step = "screenshot_entering_time";

  await ctx.reply(
    "Введите время приготовления, минуты 1–240.\nНапример: 20",
    mainKeyboard()
  );
});

bot.action("ocr_cancel", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);

  resetState(st);

  await ctx.reply(
    "❌ Screenshot-заказ удален.",
    mainKeyboard()
  );
});

bot.action("ocr_send_tv", async (ctx) => {
  await ctx.answerCbQuery();
  if (await deny(ctx)) return;

  const st = getState(ctx);

  if (st.step !== "screenshot_ready_to_send") {
    await ctx.reply(
      "❌ Сначала подтверди заказ и введи время приготовления.",
      mainKeyboard()
    );
    return;
  }

  if (!st.orderId) {
    await ctx.reply(
      "❌ Заказ на ТВ не создан. Введи время заново.",
      mainKeyboard()
    );
    st.step = "screenshot_entering_time";
    return;
  }

  const items = cartToItems(st.cart);

  if (!items.length) {
    await ctx.reply(
      "❌ Корзина пустая.",
      mainKeyboard()
    );
    return;
  }

  const ok = updateKitchenOrderItems(st.orderId, items);

  if (!ok) {
    await ctx.reply(
      "❌ Заказ на экране не найден. Создай заказ заново.",
      mainKeyboard()
    );

    resetState(st);
    return;
  }

  await ctx.reply(
    "✅ Screenshot-заказ отправлен на ТВ.",
    mainKeyboard()
  );

  st.step = "idle";
  st.orderNo = "";
  st.prepMinutes = 25;
  st.cart = {};
  st.cat = null;
  st.orderId = null;
  st.cutlery = null;
  st.screenshotPhotos = [];
  st.screenshotMode = false;
});
// ==========================
// WEBHOOK
// ==========================
const WEBHOOK_PATH = `/tg/${WEBHOOK_SECRET}`;

app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    await bot.handleUpdate(req.body, res);

    if (!res.headersSent) {
      res.sendStatus(200);
    }
  } catch (e) {
    console.error("HANDLE UPDATE ERROR:", e);

    if (!res.headersSent) {
      res.sendStatus(200);
    }
  }
});
// ==========================
// START
// ==========================
const PORT = process.env.PORT || 3000;

http.createServer(app).listen(PORT, async () => {
  console.log("Listening on", PORT);

  const webhookUrl = `${PUBLIC_URL}${WEBHOOK_PATH}`;

  await bot.telegram.setWebhook(webhookUrl, {
    drop_pending_updates: true,
  });

  console.log("Webhook set to:", webhookUrl);
});
