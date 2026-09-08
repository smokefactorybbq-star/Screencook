# Kitchen / Rider screen service

Сохраняет существующий ручной Telegram workflow менеджера и добавляет автоматический приём заказов от `tgfoodbot`.

## Новый endpoint
`POST /api/external-order`

Header:
`X-Screen-Secret: <SCREEN_SERVICE_SECRET>`

Payload содержит `orderNo`, `prepMinutes`, `items`, `cutlery`.

`SCREEN_SERVICE_SECRET` должен совпадать с переменной в `tgfoodbot`.

Существующие страницы:
- `/screen` — кухня;
- `/courier` или `/rider` — экран выдачи/курьера.
