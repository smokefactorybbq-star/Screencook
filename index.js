// index.js — TV SAFE + Manual orders + Screenshot OCR orders
// Screen:  /   (or /screen)
// API:     /api/orders   (JSON)
// Webhook: /tg/<WEBHOOK_SECRET>

import express from "express";
import http from "http";
import https from "https";
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

// Внешний адрес вашей чековой программы через ngrok.
// Указывайте только базовый адрес, например:
// https://xxxx.ngrok-free.app
const GRAB_RECEIVER_URL = String(
  process.env.GRAB_RECEIVER_URL ||
    https://741e-171-6-240-180.ngrok-free.app"
).trim();

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
    "Бефстроганов M17",
    "Фаршированный перец M18",
    "Котлеты мясные M19",
    "Котлеты куриные M20",
    "Голубцы Тям M25",
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

app.delete("/api/orders/:id", (req, res) => {
  const orderId = String(req.params.id || "").trim();

  if (!orderId) {
    return res.status(400).json({ ok: false, error: "ORDER_ID_REQUIRED" });
  }

  const before = orders.length;
  deleteKitchenOrder(orderId);
  const deleted = orders.length < before;

  res.setHeader("Cache-Control", "no-store");
  return res.status(deleted ? 200 : 404).json({
    ok: deleted,
    id: orderId,
  });
});
// ==========================
// SCREEN HTML
// ==========================
function screenHtml() {
  const categoryByDish = {};

  for (const [category, dishes] of Object.entries(MENU_BY_CAT)) {
    for (const dish of dishes) {
      categoryByDish[dish] = category;
    }
  }

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Kitchen Screen</title>
  <style>
    :root{
      --bg:#050813;
      --card:#0f1730;
      --border:rgba(255,255,255,.15);
      --text:#fff;
      --muted:rgba(255,255,255,.62);
      --green:#00e676;
      --yellow:#ffd400;
      --red:#ff453a;
      --purple:#c77dff;
      --blue:#4da3ff;
      --gold:#ffd54a;
      --ready:#aab2c2;
      --page-pad:12px;
      --gap:8px;
      --control-width:170px;
    }

    *{box-sizing:border-box}

    html,body{
      width:100%;
      min-height:100%;
      margin:0;
    }

    body{
      background:var(--bg);
      color:var(--text);
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
      overflow-x:hidden;
    }

    .warning-banner{
      width:100%;
      min-height:48px;
      display:flex;
      align-items:center;
      justify-content:center;
      margin-bottom:8px;
      padding:8px 86px 8px 16px;
      border:2px solid rgba(255,213,74,.72);
      border-radius:12px;
      background:linear-gradient(180deg,rgba(87,43,19,.97),rgba(49,24,13,.97));
      color:var(--gold);
      font-size:clamp(16px,1.45vw,27px);
      line-height:1.12;
      font-weight:1000;
      text-align:center;
      text-transform:uppercase;
      letter-spacing:.25px;
      text-shadow:0 2px 8px rgba(0,0,0,.75);
      box-shadow:
        0 0 0 1px rgba(255,213,74,.16) inset,
        0 7px 22px rgba(0,0,0,.28);
    }

    .language-button{
      position:fixed;
      top:10px;
      right:12px;
      z-index:1000;
      min-width:58px;
      height:40px;
      padding:0 12px;
      border:1px solid rgba(255,255,255,.22);
      border-radius:12px;
      background:rgba(15,23,48,.96);
      color:#fff;
      font-size:16px;
      font-weight:900;
      cursor:pointer;
      box-shadow:0 8px 24px rgba(0,0,0,.3);
    }

    .language-button:active{transform:scale(.97)}

    .stage{
      width:100%;
      min-height:100vh;
      padding:12px var(--page-pad) var(--page-pad);
    }

    .orders{
      width:100%;
      display:flex;
      flex-direction:column;
      gap:var(--gap);
    }

    .order-card{
      width:100%;
      min-height:calc((100vh - 84px - (var(--gap) * 9)) / 10);
      display:grid;
      grid-template-columns:minmax(110px,170px) minmax(0,1fr) var(--control-width);
      align-items:stretch;
      background:var(--card);
      border:1px solid var(--border);
      border-radius:12px;
      overflow:hidden;
      box-shadow:0 7px 20px rgba(0,0,0,.25);
    }

    .order-card.blink{animation:blink .9s steps(2,end) infinite}

    @keyframes blink{
      0%{filter:brightness(1)}
      50%{filter:brightness(1.55)}
      100%{filter:brightness(1)}
    }

    .order-number{
      display:flex;
      align-items:center;
      padding:8px 12px;
      border-right:1px solid rgba(255,255,255,.1);
      font-size:clamp(16px,1.45vw,28px);
      line-height:1;
      font-weight:1000;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }

    .order-content{
      min-width:0;
      display:flex;
      flex-direction:column;
      justify-content:center;
      gap:5px;
      padding:7px 12px;
    }

    .dish-lines{
      display:flex;
      flex-direction:column;
      gap:4px;
      min-width:0;
    }

    .dish-line{
      min-width:0;
      font-size:clamp(14px,1.15vw,22px);
      line-height:1.2;
      font-weight:900;
      overflow-wrap:anywhere;
    }

    .dish-item{
      display:inline;
      font-weight:1000;
      text-shadow:0 1px 5px rgba(0,0,0,.55);
    }

    .dish-item.cat-soups{color:#ffffff}
    .dish-item.cat-mains{color:var(--yellow)}
    .dish-item.cat-sides{color:var(--purple)}
    .dish-item.cat-grill{color:var(--red)}
    .dish-item.cat-salads{color:var(--green)}
    .dish-item.cat-gastronomy{color:var(--blue)}
    .dish-item.cat-unknown{color:#ffffff}

    .dish-separator{
      display:inline-block;
      margin:0 7px;
      color:rgba(255,255,255,.38);
      font-weight:700;
    }

    .qty{
      color:inherit;
      opacity:.88;
      white-space:nowrap;
    }

    .empty-items{
      color:var(--muted);
      font-size:14px;
      font-weight:800;
    }

    .cutlery{
      font-size:12px;
      line-height:1.1;
      font-weight:1000;
    }

    .cutlery.yes{color:var(--green)}
    .cutlery.no{color:var(--red)}

    .order-controls{
      position:relative;
      min-width:0;
      display:flex;
      align-items:center;
      justify-content:center;
      padding:7px 42px 7px 10px;
      border-left:1px solid rgba(255,255,255,.1);
    }

    .timer{
      font-size:clamp(19px,1.75vw,34px);
      line-height:1;
      font-weight:1000;
      font-variant-numeric:tabular-nums;
      white-space:nowrap;
      letter-spacing:.4px;
    }

    .delete-button{
      position:absolute;
      top:5px;
      right:6px;
      width:30px;
      height:30px;
      display:grid;
      place-items:center;
      padding:0;
      border:0;
      border-radius:8px;
      background:transparent;
      color:rgba(255,255,255,.72);
      font-size:25px;
      line-height:1;
      font-weight:500;
      cursor:pointer;
    }

    .delete-button:hover{
      background:rgba(255,69,58,.18);
      color:#fff;
    }

    .delete-button:disabled{opacity:.35;cursor:default}

    .status{
      position:fixed;
      left:10px;
      bottom:8px;
      z-index:1000;
      padding:4px 7px;
      border-radius:8px;
      background:rgba(0,0,0,.28);
      color:rgba(255,255,255,.42);
      font-size:10px;
      font-weight:800;
      pointer-events:none;
    }

    @media (max-width:900px){
      :root{--control-width:130px}
      .order-card{grid-template-columns:110px minmax(0,1fr) var(--control-width)}
      .order-number{padding:7px 9px}
      .order-content{padding:7px 9px}
      .dish-separator{margin:0 4px}
    }
  </style>
</head>
<body>
  <button class="language-button" id="language-button" type="button" aria-label="Switch language">ไทย</button>

  <main class="stage">
    <div class="warning-banner">
      ВНИМАТЕЛЬНО ПРОВЕРЬ ЗАКАЗ! ДВА РАЗА ПРОВЕРЬ КОМПЛЕКТАЦИЮ!
    </div>
    <section class="orders" id="orders"></section>
  </main>

  <div class="status" id="status">BOOT</div>

<script>
(function(){
  "use strict";

  var ordersNode = document.getElementById("orders");
  var languageButton = document.getElementById("language-button");
  var statusNode = document.getElementById("status");
  var currentLanguage = localStorage.getItem("kitchen-language") === "th" ? "th" : "ru";
  var currentOrders = [];
  var lastSignature = "";
  var CATEGORY_BY_DISH = ${JSON.stringify(categoryByDish)};

  var CATEGORY_BY_DISH_NORMALIZED = {};
  Object.keys(CATEGORY_BY_DISH).forEach(function(name){
    CATEGORY_BY_DISH_NORMALIZED[normalizeDishKey(name)] = CATEGORY_BY_DISH[name];
  });

  var UI = {
    ru: {
      ready: "ГОТОВО",
      noItems: "Блюда пока не добавлены",
      cutleryYes: "Приборы нужны",
      cutleryNo: "Приборы не нужны",
      deleteOrder: "Удалить заказ",
      apiOk: "Связь есть",
      apiError: "Ошибка связи",
      orders: "Заказов"
    },
    th: {
      ready: "พร้อม",
      noItems: "ยังไม่ได้เพิ่มรายการอาหาร",
      cutleryYes: "ต้องการช้อนส้อม",
      cutleryNo: "ไม่ต้องการช้อนส้อม",
      deleteOrder: "ลบออเดอร์",
      apiOk: "เชื่อมต่อแล้ว",
      apiError: "การเชื่อมต่อผิดพลาด",
      orders: "ออเดอร์"
    }
  };

  var DISH_TH = {
    "Кур бульон S1":"ซุปไก่ S1",
    "Борщ S2":"บอร์ช S2",
    "Гороховый суп S3":"ซุปถั่วลันเตา S3",
    "Грибной суп S5":"ซุปเห็ด S5",
    "Окрошка S5":"โอโครชกา S5",
    "Солянка S4":"ซุปโซลยังกา S4",
    "Ребро варкоп":"ซี่โครงรมควันต้ม",
    "Джерки":"เนื้อเจอร์กี",
    "Пельмени M1":"เกี๊ยวรัสเซีย M1",
    "Зраза M2":"ซราซี M2",
    "Драники M3":"แพนเค้กมันฝรั่ง M3",
    "Карошка фри M4":"เฟรนช์ฟรายส์ M4",
    "Картошка фри M4":"เฟรนช์ฟรายส์ M4",
    "Картошка дольки M5":"มันฝรั่งเวดจ์ M5",
    "Мини чебуреки M6":"เชบูเรกีชิ้นเล็ก M6",
    "Киевская - пюре M7":"ไก่เคียฟกับมันบด M7",
    "Киевская - дольки M8":"ไก่เคียฟกับมันฝรั่งเวดจ์ M8",
    "Лепешка с рваной БИГ M9":"แผ่นแป้งเนื้อฉีก ใหญ่ M9",
    "Лепешка с рваной СМОЛ M10":"แผ่นแป้งเนื้อฉีก เล็ก M10",
    "Лепешка с картошкой БИГ M11":"แผ่นแป้งไส้มันฝรั่ง ใหญ่ M11",
    "Лепешка с картошкой СМОЛ M12":"แผ่นแป้งไส้มันฝรั่ง เล็ก M12",
    "Лепешка сыр БИГ M13":"แผ่นแป้งชีส ใหญ่ M13",
    "Лепешка сыр СМОЛ M14":"แผ่นแป้งชีส เล็ก M14",
    "Вареники M15":"วาเรนีกี M15",
    "Бефстроганов M17":"บีฟสโตรกานอฟ M17",
    "Фаршированный перец M18":"พริกหวานยัดไส้ M18",
    "Котлеты мясные M19":"เนื้อบดทอด M19",
    "Котлеты куриные M20":"ไก่บดทอด M20",
    "Голубцы Тям M25":"กะหล่ำปลียัดไส้ M25",
    "Туш капуста M24":"กะหล่ำปลีตุ๋น M24",
    "Пелюстка":"กะหล่ำปลีดองบีตรูต",
    "Соленое сало":"มันหมูเค็ม",
    "Сметана":"ซาวร์ครีม",
    "Лаваш":"ลาวาช",
    "Кетчуп":"ซอสมะเขือเทศ",
    "Острая морковь":"แครอทรสเผ็ด",
    "Бочковой огурец":"แตงกวาดองถัง",
    "Халапеньо":"ฮาลาปิโน",
    "Корнишон":"แตงกวาดองลูกเล็ก",
    "Свежий огурец":"แตงกวาสด",
    "Майонез":"มายองเนส",
    "Рёбра BBQ G1":"ซี่โครง BBQ G1",
    "Ребра BBQ G1":"ซี่โครง BBQ G1",
    "Шашлык свиной G2":"ชาชลิกหมู G2",
    "Шашлык куриный G3":"ชาชลิกไก่ G3",
    "Куриный 2.0 G6":"ไก่ 2.0 G6",
    "Кебаб свин-гов G4":"เคบับหมู-เนื้อ G4",
    "Кебаб курица G5":"เคบับไก่ G5",
    "Wings кур G7":"ปีกไก่ G7",
    "Столичный T1":"สลัดสโตลิชนี T1",
    "Деревенский T2":"สลัดชนบท T2",
    "Обжорка T3":"สลัดออบชอร์กา T3",
    "Цезарь T4":"ซีซาร์สลัด T4",
    "Овощ Смет T6":"สลัดผักซาวร์ครีม T6",
    "Овощ Майо T7":"สลัดผักมายองเนส T7",
    "Овощ Масло T8":"สลัดผักน้ำมัน T8",
    "Баклажаны T5":"มะเขือยาวทอด T5",
    "Сrab T9":"สลัดปู T9"
  };

  function esc(value){
    return String(value == null ? "" : value)
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;")
      .replace(/'/g,"&#039;");
  }

  function translateDish(name){
    var source = String(name || "").trim();
    if (currentLanguage !== "th") return source;
    return DISH_TH[source] || source;
  }

  function pad2(value){
    var text = String(value);
    return text.length < 2 ? "0" + text : text;
  }

  function formatTimer(ms){
    var seconds = Math.max(0, Math.floor(ms / 1000));
    var minutes = Math.floor(seconds / 60);
    return String(minutes) + ":" + pad2(seconds % 60);
  }

  function timerColor(remainingMinutes){
    if (remainingMinutes <= 0) return "var(--ready)";
    if (remainingMinutes <= 10) return "var(--red)";
    if (remainingMinutes <= 25) return "var(--yellow)";
    return "var(--green)";
  }

  function cutleryHtml(order){
    if (!order || (order.cutlery !== true && order.cutlery !== false)) return "";

    if (order.cutlery === true){
      return '<div class="cutlery yes">' + esc(UI[currentLanguage].cutleryYes) + '</div>';
    }

    return '<div class="cutlery no">' + esc(UI[currentLanguage].cutleryNo) + '</div>';
  }

  function normalizeDishKey(value){
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/\\s+/g, " ");
  }

  function dishCategory(name){
    var source = String(name || "").trim();
    var normalized = normalizeDishKey(source);

    if (CATEGORY_BY_DISH_NORMALIZED[normalized]){
      return CATEGORY_BY_DISH_NORMALIZED[normalized];
    }

    if (/\\bS\\d+\\b/i.test(source)) return "soups";
    if (/\\bM\\d+\\b/i.test(source)) return "mains";
    if (/\\bG\\d+\\b/i.test(source)) return "grill";
    if (/\\bT\\d+\\b/i.test(source)) return "salads";

    return "unknown";
  }

  function itemText(item){
    var source = String(item && item.name || "").trim();
    var qty = Math.max(1, Number(item && item.qty || 1));
    var category = dishCategory(source);

    return '<span class="dish-item cat-' + esc(category) + '">' +
      esc(translateDish(source)) +
      ' <span class="qty">x' + qty + '</span></span>';
  }

  function dishLinesHtml(items){
    if (!Array.isArray(items) || !items.length){
      return '<div class="empty-items">' + esc(UI[currentLanguage].noItems) + '</div>';
    }

    var html = '<div class="dish-lines">';

    for (var start = 0; start < items.length; start += 10){
      var group = items.slice(start, start + 10);
      html += '<div class="dish-line">';

      for (var i = 0; i < group.length; i++){
        if (i > 0) html += '<span class="dish-separator">/</span>';
        html += itemText(group[i]);
      }

      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  function makeCard(order){
    var card = document.createElement("article");
    card.className = "order-card";
    card.setAttribute("data-order-id", String(order.id || ""));

    card.innerHTML =
      '<div class="order-number">' + esc(order.orderNo || "—") + '</div>' +
      '<div class="order-content">' +
        dishLinesHtml(order.items || []) +
        cutleryHtml(order) +
      '</div>' +
      '<div class="order-controls">' +
        '<div class="timer" data-ends-at="' + Number(order.endsAt || 0) + '">--:--</div>' +
        '<button class="delete-button" type="button" data-delete-id="' + esc(order.id || "") + '" aria-label="' + esc(UI[currentLanguage].deleteOrder) + '">×</button>' +
      '</div>';

    return card;
  }

  function render(){
    ordersNode.innerHTML = "";

    for (var i = 0; i < currentOrders.length; i++){
      if (currentOrders[i]) ordersNode.appendChild(makeCard(currentOrders[i]));
    }

    document.documentElement.lang = currentLanguage === "th" ? "th" : "ru";
    languageButton.textContent = currentLanguage === "ru" ? "ไทย" : "RU";
    updateTimers();
  }

  function updateTimers(){
    var now = Date.now();
    var timers = ordersNode.querySelectorAll(".timer");

    for (var i = 0; i < timers.length; i++){
      var timer = timers[i];
      var endsAt = Number(timer.getAttribute("data-ends-at") || 0);
      var remainingMs = endsAt - now;
      var remainingMinutes = remainingMs / 60000;

      timer.textContent = remainingMs <= 0 ? UI[currentLanguage].ready : formatTimer(remainingMs);
      timer.style.color = timerColor(remainingMinutes);

      var card = timer.closest ? timer.closest(".order-card") : timer.parentNode.parentNode;
      if (!card) continue;

      if (remainingMs > 0 && remainingMs <= 5 * 60 * 1000){
        card.classList.add("blink");
      } else {
        card.classList.remove("blink");
      }
    }
  }

  function requestJson(method, url, callback){
    try{
      var xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.setRequestHeader("Accept", "application/json");

      xhr.onreadystatechange = function(){
        if (xhr.readyState !== 4) return;

        var data = null;
        try{ data = xhr.responseText ? JSON.parse(xhr.responseText) : null; }catch(_e){}

        if (xhr.status >= 200 && xhr.status < 300){
          callback(null, data);
        } else {
          callback(new Error("HTTP " + xhr.status), data);
        }
      };

      xhr.onerror = function(){ callback(new Error("NETWORK_ERROR")); };
      xhr.send(null);
    }catch(error){
      callback(error);
    }
  }

  function signature(list){
    try{
      return JSON.stringify((list || []).map(function(order){
        return {
          id:order.id,
          orderNo:order.orderNo,
          endsAt:order.endsAt,
          cutlery:order.cutlery,
          items:(order.items || []).map(function(item){return [item.name,item.qty];})
        };
      }));
    }catch(_error){
      return String(Date.now());
    }
  }

  function poll(){
    requestJson("GET", "/api/orders", function(error, data){
      if (error){
        statusNode.textContent = UI[currentLanguage].apiError;
        return;
      }

      var list = Array.isArray(data) ? data : [];
      var nextSignature = signature(list);

      if (nextSignature !== lastSignature){
        lastSignature = nextSignature;
        currentOrders = list;
        render();
      }

      statusNode.textContent = UI[currentLanguage].apiOk + " · " + UI[currentLanguage].orders + ": " + list.length;
    });
  }

  function removeOrder(orderId, button){
    if (!orderId || !button) return;

    button.disabled = true;

    requestJson("DELETE", "/api/orders/" + encodeURIComponent(orderId), function(error){
      if (error){
        button.disabled = false;
        statusNode.textContent = UI[currentLanguage].apiError;
        return;
      }

      currentOrders = currentOrders.filter(function(order){
        return String(order.id) !== String(orderId);
      });
      lastSignature = signature(currentOrders);
      render();
    });
  }

  languageButton.addEventListener("click", function(){
    currentLanguage = currentLanguage === "ru" ? "th" : "ru";
    localStorage.setItem("kitchen-language", currentLanguage);
    render();
    statusNode.textContent = UI[currentLanguage].apiOk + " · " + UI[currentLanguage].orders + ": " + currentOrders.length;
  });

  ordersNode.addEventListener("click", function(event){
    var button = event.target.closest ? event.target.closest("[data-delete-id]") : null;
    if (!button) return;
    removeOrder(button.getAttribute("data-delete-id"), button);
  });

  render();
  updateTimers();
  poll();
  setInterval(updateTimers, 1000);
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
// COURIER SCREEN HTML
// ==========================
function courierScreenHtml() {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Courier Screen</title>
<style>
:root{
  --bg:#0b1220;
  --card:#121a2b;
  --text:#ffffff;
  --muted:#9aa7c7;
  --green:#00e676;
  --yellow:#ffd400;
  --red:#ff453a;
  --ready:#00ff66;
  --ticker-bg:#020617;
  --ticker-text:#ffffff;
  --page-pad:18px;
  --gap:10px;
}
*{box-sizing:border-box}
html,body{width:100%;min-height:100%;margin:0}
body{
  background:var(--bg);
  color:var(--text);
  font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
  padding-bottom:132px;
  overflow-x:hidden;
}
.wrap{
  width:100%;
  max-width:1500px;
  margin:0 auto;
  padding:var(--page-pad);
}
header{
  display:flex;
  gap:16px;
  align-items:center;
  justify-content:space-between;
  margin-bottom:14px;
}
h1{
  margin:0;
  font-size:clamp(24px,2.2vw,38px);
  line-height:1;
}
.header-sub{
  color:var(--muted);
  font-size:13px;
  margin-top:7px;
}
.status{
  padding:8px 12px;
  border-radius:12px;
  background:rgba(255,255,255,.08);
  color:var(--muted);
  font-size:13px;
  font-weight:800;
}
.orders{
  width:100%;
  display:flex;
  flex-direction:column;
  gap:var(--gap);
}
.order-row{
  width:100%;
  min-height:76px;
  display:grid;
  grid-template-columns:minmax(150px,1fr) minmax(160px,260px);
  align-items:center;
  background:var(--card);
  border:1px solid rgba(255,255,255,.14);
  border-radius:16px;
  overflow:hidden;
  box-shadow:0 8px 22px rgba(0,0,0,.24);
}
.order-info{
  min-width:0;
  padding:13px 18px;
}
.order-number{
  font-size:clamp(26px,3vw,48px);
  line-height:1;
  font-weight:1000;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
.order-caption{
  color:var(--muted);
  font-size:13px;
  font-weight:800;
  margin-top:7px;
}
.time-box{
  min-height:76px;
  height:100%;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:10px 18px;
  border-left:1px solid rgba(255,255,255,.12);
}
.time{
  font-size:clamp(29px,3.4vw,56px);
  line-height:1;
  font-weight:1000;
  white-space:nowrap;
  font-variant-numeric:tabular-nums;
  letter-spacing:.5px;
}
.order-row.ready{
  border-color:rgba(0,255,102,.85);
  animation:readyPulse 1s infinite;
}
@keyframes readyPulse{
  0%{box-shadow:0 0 0 rgba(0,255,102,0)}
  50%{box-shadow:0 0 30px rgba(0,255,102,.55)}
  100%{box-shadow:0 0 0 rgba(0,255,102,0)}
}
.empty{
  min-height:120px;
  display:flex;
  align-items:center;
  justify-content:center;
  color:var(--muted);
  font-size:clamp(20px,2vw,30px);
  font-weight:900;
  text-align:center;
}
.ticker{
  position:fixed;
  left:0;
  right:0;
  bottom:0;
  height:120px;
  background:var(--ticker-bg);
  border-top:2px solid rgba(255,255,255,.12);
  overflow:hidden;
  display:flex;
  align-items:center;
  z-index:9999;
}
.ticker-track{
  display:flex;
  width:max-content;
  white-space:nowrap;
  animation:tickerMove 34s linear infinite;
  will-change:transform;
}
.ticker-text{
  display:inline-block;
  padding-right:100px;
  color:var(--ticker-text);
  font-size:clamp(34px,4vw,58px);
  line-height:1;
  font-weight:900;
}
@keyframes tickerMove{
  from{transform:translateX(0)}
  to{transform:translateX(-50%)}
}
@media (max-width:700px){
  body{padding-bottom:105px}
  .wrap{padding:10px}
  header{margin-bottom:10px}
  .order-row{grid-template-columns:minmax(0,1fr) 135px;min-height:68px}
  .time-box{min-height:68px;padding:8px}
  .order-info{padding:10px 12px}
  .ticker{height:95px}
  .ticker-text{font-size:30px;padding-right:65px}
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Orders</h1>
      <div class="header-sub" id="updated">—</div>
    </div>
    <div class="status" id="status">Connecting…</div>
  </header>

  <main class="orders" id="orders"></main>
</div>

<div class="ticker">
  <div class="ticker-track">
    <span class="ticker-text">เรียนไรเดอร์ทุกท่าน! ขณะนี้เรากำลังเตรียมออเดอร์ของท่านอยู่ กรุณาตรวจสอบเวลาการเตรียมอาหารบนหน้าจอ เมื่อออเดอร์พร้อมแล้ว พนักงานจะนำออเดอร์มอบให้ท่านทันที ขอบคุณที่ช่วยให้การจัดส่งรวดเร็วและมีคุณภาพ!</span>
    <span class="ticker-text">เรียนไรเดอร์ทุกท่าน! ขณะนี้เรากำลังเตรียมออเดอร์ของท่านอยู่ กรุณาตรวจสอบเวลาการเตรียมอาหารบนหน้าจอ เมื่อออเดอร์พร้อมแล้ว พนักงานจะนำออเดอร์มอบให้ท่านทันที ขอบคุณที่ช่วยให้การจัดส่งรวดเร็วและมีคุณภาพ!</span>
  </div>
</div>

<script>
(function(){
  "use strict";

  var API_URL = "/api/orders";
  var POLL_MS = 2500;
  var TICK_MS = 1000;

  var ordersNode = document.getElementById("orders");
  var updatedNode = document.getElementById("updated");
  var statusNode = document.getElementById("status");

  var currentOrders = [];
  var lastSignature = "";

  function esc(value){
    return String(value == null ? "" : value)
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;")
      .replace(/'/g,"&#039;");
  }

  function pad2(value){
    var text = String(value);
    return text.length < 2 ? "0" + text : text;
  }

  function formatTime(ms){
    var totalSeconds = Math.max(0, Math.floor(ms / 1000));
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return String(minutes) + ":" + pad2(seconds);
  }

  function timerColor(remainingMinutes){
    if (remainingMinutes <= 0) return "var(--ready)";
    if (remainingMinutes <= 10) return "var(--red)";
    if (remainingMinutes <= 25) return "var(--yellow)";
    return "var(--green)";
  }

  function makeRow(order){
    var row = document.createElement("article");
    row.className = "order-row";
    row.setAttribute("data-order-id", String(order.id || ""));

    row.innerHTML =
      '<div class="order-info">' +
        '<div class="order-number">Order ' + esc(order.orderNo || "—") + '</div>' +
        '<div class="order-caption">' + Number(order.prepMinutes || 0) + ' min</div>' +
      '</div>' +
      '<div class="time-box">' +
        '<div class="time" data-ends-at="' + Number(order.endsAt || 0) + '">--:--</div>' +
      '</div>';

    return row;
  }

  function render(){
    ordersNode.innerHTML = "";

    if (!currentOrders.length){
      ordersNode.innerHTML = '<div class="empty">No active orders</div>';
      return;
    }

    for (var i = 0; i < currentOrders.length; i++){
      if (currentOrders[i]) ordersNode.appendChild(makeRow(currentOrders[i]));
    }

    updateTimers();
  }

  function updateTimers(){
    var now = Date.now();
    var timers = ordersNode.querySelectorAll(".time");

    for (var i = 0; i < timers.length; i++){
      var timer = timers[i];
      var endsAt = Number(timer.getAttribute("data-ends-at") || 0);
      var remainingMs = endsAt - now;
      var remainingMinutes = remainingMs / 60000;
      var row = timer.closest ? timer.closest(".order-row") : timer.parentNode.parentNode;

      timer.textContent = remainingMs <= 0 ? "READY" : formatTime(remainingMs);
      timer.style.color = timerColor(remainingMinutes);

      if (row){
        if (remainingMs <= 0 && remainingMs > -5 * 60 * 1000){
          row.classList.add("ready");
        } else {
          row.classList.remove("ready");
        }
      }
    }
  }

  function signature(list){
    try{
      return JSON.stringify((list || []).map(function(order){
        return [
          order.id,
          order.orderNo,
          order.prepMinutes,
          order.endsAt,
          order.expiresAt
        ];
      }));
    }catch(_error){
      return String(Date.now());
    }
  }

  function requestOrders(callback){
    try{
      var xhr = new XMLHttpRequest();
      xhr.open("GET", API_URL, true);
      xhr.setRequestHeader("Accept", "application/json");

      xhr.onreadystatechange = function(){
        if (xhr.readyState !== 4) return;

        if (xhr.status >= 200 && xhr.status < 300){
          try{
            callback(null, JSON.parse(xhr.responseText || "[]"));
          }catch(error){
            callback(error);
          }
        } else {
          callback(new Error("HTTP " + xhr.status));
        }
      };

      xhr.onerror = function(){
        callback(new Error("NETWORK_ERROR"));
      };

      xhr.send(null);
    }catch(error){
      callback(error);
    }
  }

  function poll(){
    requestOrders(function(error, data){
      if (error){
        statusNode.textContent = "Offline / API error";
        return;
      }

      var now = Date.now();
      var list = Array.isArray(data) ? data : [];

      // Сервер уже удаляет заказ через 5 минут после READY.
      // Дополнительная фильтрация защищает экран от задержки обновления.
      list = list.filter(function(order){
        var expiresAt = Number(order.expiresAt || (Number(order.endsAt || 0) + 5 * 60 * 1000));
        return !expiresAt || expiresAt > now;
      });

      var nextSignature = signature(list);

      if (nextSignature !== lastSignature){
        lastSignature = nextSignature;
        currentOrders = list;
        render();
      }

      updatedNode.textContent = "Updated: " + new Date().toLocaleString();
      statusNode.textContent = "Online · Orders: " + list.length;
      updateTimers();
    });
  }

  render();
  poll();
  setInterval(updateTimers, TICK_MS);
  setInterval(poll, POLL_MS);
})();
</script>
</body>
</html>`;
}

app.get("/courier", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(courierScreenHtml());
});

app.get("/rider", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(courierScreenHtml());
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

// ==========================
// HIDDEN GRAB LABEL REQUEST
// ==========================
// Бот отправляет в чековую программу номер заказа GF-* или SM-*.
// Интерфейс бота и экранов не меняется.
function grabEndpoint() {
  const base = String(GRAB_RECEIVER_URL || "").trim();

  if (!base) return "";

  const withoutSlash = base.replace(/\/+$/, "");

  if (
    withoutSlash.endsWith("/grab") ||
    withoutSlash.endsWith("/grab-label")
  ) {
    return withoutSlash;
  }

  return withoutSlash + "/grab";
}

function postJson(url, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let target;

    try {
      target = new URL(url);
    } catch (error) {
      reject(new Error("Invalid GRAB_RECEIVER_URL: " + error.message));
      return;
    }

    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const transport = target.protocol === "https:" ? https : http;

    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": body.length,
          "User-Agent": "SmokeFactory-GrabBot/1.0",
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => chunks.push(chunk));

        response.on("end", () => {
          const responseText = Buffer.concat(chunks).toString("utf8");
          let data = null;

          try {
            data = responseText ? JSON.parse(responseText) : null;
          } catch (_error) {
            data = null;
          }

          if (
            response.statusCode >= 200 &&
            response.statusCode < 300
          ) {
            resolve(data || { ok: true });
            return;
          }

          reject(
            new Error(
              "Grab receiver HTTP " +
                response.statusCode +
                ": " +
                responseText
            )
          );
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Grab receiver timeout"));
    });

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

async function sendGrabOrderNumber(orderNo) {
  const number = String(orderNo || "").trim().toUpperCase();

  // В чековую программу отправляются номера GF-* и SM-*.
  if (!/^(?:GF|SM)-[0-9]+$/.test(number)) {
    return {
      ok: true,
      skipped: true,
      reason: "UNSUPPORTED_LABEL_NUMBER",
    };
  }

  const endpoint = grabEndpoint();

  if (!endpoint) {
    console.error(
      "GRAB RECEIVER ERROR: GRAB_RECEIVER_URL is not set"
    );

    return {
      ok: false,
      skipped: true,
      reason: "GRAB_RECEIVER_URL_NOT_SET",
    };
  }

  const result = await postJson(endpoint, {
    order_number: number,
  });

  console.log("Grab label queued:", number, result);
  return result;
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

function collectItemSourceText(item) {
  const parts = [];

  function add(value) {
    if (value == null) return;

    if (Array.isArray(value)) {
      for (const entry of value) add(entry);
      return;
    }

    if (typeof value === "object") {
      for (const entry of Object.values(value)) add(entry);
      return;
    }

    const text = String(value).trim();
    if (text) parts.push(text);
  }

  add(item?.sourceText);
  add(item?.optionText);
  add(item?.modifierText);
  add(item?.details);
  add(item?.options);
  add(item?.modifiers);

  return parts.join(" ");
}

// Возвращает:
//   строку     — точное блюдо из меню;
//   null       — блюдо распознано, но вариант определить нельзя;
//   undefined  — это не специальный случай, можно использовать обычный поиск.
function resolveSpecialMenuName(itemOrName) {
  const item =
    itemOrName && typeof itemOrName === "object"
      ? itemOrName
      : { name: itemOrName };

  const modelName = String(item.name || "").trim();
  const sourceText = collectItemSourceText(item);
  const hasSourceText = !!sourceText.trim();

  const source = normalizeText(sourceText);
  const combined = normalizeText(sourceText + " " + modelName);
  const reliableText = hasSourceText ? source : combined;

  // Котлета по-киевски — это НЕ обычная куриная котлета M20.
  const isKiev = /киев|киеск|kiev|kyiv/.test(reliableText);

  if (isKiev) {
    const hasWedges = /дольк|wedg|potato wedge|картофел[^ ]* доль/.test(reliableText);
    const hasPuree = /пюре|mashed|mash potato|potato mash/.test(reliableText);

    if (hasWedges) return "Киевская - дольки M8";
    if (hasPuree) return "Киевская - пюре M7";

    // Если гарнир не читается, не угадываем и не превращаем Киевскую
    // в обычную позицию "Котлеты куриные M20".
    const normalizedModelName = normalizeText(modelName);

    if (/\bm8\b/.test(normalizedModelName)) {
      return "Киевская - дольки M8";
    }

    if (/\bm7\b/.test(normalizedModelName)) {
      return "Киевская - пюре M7";
    }

    return null;
  }

  // Овощной салат имеет три разные позиции. Заправку нельзя угадывать.
  const isVegetableSalad =
    /овощ[^ ]* салат|салат[^ ]* овощ|vegetable salad|fresh vegetable/.test(
      reliableText
    ) ||
    (!hasSourceText && /овощ (смет|майо|масло)|\bt[678]\b/.test(combined));

  if (isVegetableSalad) {
    if (/майон|майо|mayonnaise|\bmayo\b/.test(reliableText)) {
      return "Овощ Майо T7";
    }

    if (/сметан|sour cream/.test(reliableText)) {
      return "Овощ Смет T6";
    }

    if (/масл|olive oil|vegetable oil|dressing oil|\boil\b/.test(reliableText)) {
      return "Овощ Масло T8";
    }

    // Для старого формата ответа, где sourceText ещё отсутствует,
    // разрешаем определить вариант по точному имени, которое вернул ИИ.
    if (!hasSourceText) {
      if (/овощ майо|\bt7\b/.test(combined)) return "Овощ Майо T7";
      if (/овощ смет|\bt6\b/.test(combined)) return "Овощ Смет T6";
      if (/овощ масло|\bt8\b/.test(combined)) return "Овощ Масло T8";
    }

    // Если заправка действительно не читается, лучше не подставлять сметану.
    return null;
  }

  return undefined;
}

function findBestMenuName(itemOrName) {
  const item =
    itemOrName && typeof itemOrName === "object"
      ? itemOrName
      : { name: itemOrName };

  const specialName = resolveSpecialMenuName(item);

  if (specialName !== undefined) {
    return specialName;
  }

  const raw = normalizeText(item.name);

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

"КРИТИЧЕСКИЕ ПРАВИЛА ДЛЯ ПОХОЖИХ БЛЮД: " +
"1. 'Котлета по-киевски', 'Киевская котлета', 'Chicken Kiev' или 'Chicken Kyiv' НИКОГДА не являются позицией 'Котлеты куриные M20'. " +
"Если у Киевской указан гарнир пюре/mashed potato — верни 'Киевская - пюре M7'. " +
"Если указаны картофельные дольки/wedges — верни 'Киевская - дольки M8'. " +
"2. Овощной салат нельзя автоматически считать салатом со сметаной. Обязательно прочитай заправку или выбранную опцию. " +
"Сметана/sour cream = 'Овощ Смет T6'. Майонез/mayonnaise/mayo = 'Овощ Майо T7'. Масло/oil = 'Овощ Масло T8'. " +
"Если заправка находится под строкой Option, Modifier, Choice или Add item непосредственно внутри овощного салата, это выбор варианта салата, а не отдельная позиция 'Сметана' или 'Майонез'. " +
"Не выдумывай сметану, если на изображении указано масло или майонез. " +

"Для каждого блюда обязательно верни sourceText — исходное название, как оно написано на скриншоте, и optionText — текст выбранной опции/гарнира/заправки. " +
"Если опции нет, optionText должен быть пустой строкой. " +

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
        '{"orderNo":"GF-123","cutlery":true,"items":[{"name":"Киевская - пюре M7","sourceText":"Котлета по-киевски","optionText":"Картофельное пюре","qty":1},{"name":"Овощ Масло T8","sourceText":"Овощной салат","optionText":"Заправка: масло","qty":1}]} ' +

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
    const qty = Math.max(1, Math.floor(Number(item.qty || 1)));
    const matchedName = findBestMenuName(item);

    if (!matchedName) {
      const unresolvedText = normalizeText(
        collectItemSourceText(item) + " " + String(item?.name || "")
      );

      let warningName = null;

      if (/киев|киеск|kiev|kyiv/.test(unresolvedText)) {
        warningName = "⚠️ Киевская — ВЫБРАТЬ ГАРНИР";
      } else if (
        /овощ[^ ]* салат|салат[^ ]* овощ|vegetable salad|fresh vegetable/.test(
          unresolvedText
        )
      ) {
        warningName = "⚠️ Овощной салат — ВЫБРАТЬ ЗАПРАВКУ";
      }

      if (warningName) {
        cart[warningName] = (cart[warningName] || 0) + qty;
      }

      continue;
    }

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

  try {
    await sendGrabOrderNumber(st.orderNo);
  } catch (error) {
    // Ошибка этикетки не должна ломать отправку заказа на ТВ.
    console.error(
      "GRAB LABEL SEND ERROR:",
      st.orderNo,
      error
    );
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

  try {
    await sendGrabOrderNumber(st.orderNo);
  } catch (error) {
    // Ошибка этикетки не должна ломать отправку заказа на ТВ.
    console.error(
      "GRAB LABEL SEND ERROR:",
      st.orderNo,
      error
    );
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
