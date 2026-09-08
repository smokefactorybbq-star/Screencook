# Screencook — восстановленная старая версия

Сохранено как раньше:
- ручной заказ через Telegram;
- `📸 Новый заказ screenshot`;
- 1–3 скриншота + OpenAI OCR;
- редактирование распознанных блюд;
- ввод номера заказа и времени;
- отправка на экран кухни;
- экран кухни `/screen` и `/screen.html`;
- переключение RU / ไทย;
- старые цвета категорий блюд;
- экран курьеров `/courier`, `/courier.html`, `/rider`.

## Railway Variables

Обязательно:
- `BOT_TOKEN` **или** `TELEGRAM_BOT_TOKEN` — токен именно бота Screencook.
- `OPENAI_API_KEY` — нужен для чтения скриншотов.

Желательно оставить как раньше:
- `PUBLIC_URL=https://screegrab-production.up.railway.app`
- `WEBHOOK_SECRET=...`
- `MANAGER_IDS=...`
- `GRAB_RECEIVER_URL=...`

Если `PUBLIC_URL` не задан, код автоматически использует `RAILWAY_PUBLIC_DOMAIN`.
Если `WEBHOOK_SECRET` не задан, код создаёт стабильный webhook-path из токена.

ВАЖНО: токен Screencook и токен основного пользовательского бота должны быть разными.
