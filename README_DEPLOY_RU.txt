SCREENCOOK — восстановленная старая логика + новые внешние заказы

Railway Start Command: node index.js
Root Directory: каталог, где лежат index.js и package.json этого проекта.

Проверка после Redeploy:
1) /health -> build должен быть: 2026-09-08-old-ui-courier-restored
2) /screen.html -> старый экран кухни, кнопка ไทย, карточки блюд и таймеры
3) /courier.html -> номера заказов и обратный таймер
4) /api/orders -> один и тот же список для обоих экранов

Старый Telegram workflow сохранён: ручной заказ + screenshot OCR + отправка на ТВ.
Новые заказы сайта/Mini App принимаются POST /api/external-order и попадают в тот же список.
