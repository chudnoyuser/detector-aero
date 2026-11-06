# Детектор АЭРО — уведомления о воздушной опасности

Наблюдатель за публичной картой [detector-aero.ru](https://detector-aero.ru): следит за воздушной
обстановкой в районе Батайска (Ростов-на-Дону, Азов, Аксай, Новочеркасск и окрестности в радиусе
50 км) и присылает уведомления, когда появляется угроза и когда объявляют отбой.

## Как это работает

```
detector-aero.ru
   └─ /api/pub/v1/challenge  →  решаем PoW (доказательство работы)
   └─ /api/pub/v1/session    →  получаем сессию (cookie)
   └─ /api/pub/v1/state      →  снимок всех событий карты (обновление каждые 45 с)
        │
        ├─ фильтр по зонам и расстоянию до Батайска
        ├─ новое событие «danger» → уведомление
        └─ событие пропало/«clear» → уведомление об отбое
              │
              ├─ ntfy.sh  → push на телефон (iPhone и Android)
              ├─ Windows  → всплывающее уведомление
              └─ Telegram → (по умолчанию выключен, см. ниже)
```

Состояние (какие события уже объявлены) хранится в `state.json`, поэтому перезапуск
не приводит к повторным уведомлениям. Логи — в `logs\watch-ГГГГ-ММ-ДД.log`.

## Где это может работать круглосуточно

| Вариант | Цена | Задержка | Инструкция |
|---|---|---|---|
| GitHub Actions | 0 ₽ | 5–15 мин | [GITHUB-SETUP.md](GITHUB-SETUP.md) |
| VPS / Raspberry Pi / Linux | 150–300 ₽/мес | 45 сек | [deploy/README-deploy.md](deploy/README-deploy.md) |
| Android (Termux) | 0 ₽ | 45 сек | [deploy/README-deploy.md](deploy/README-deploy.md) |
| Этот компьютер (Windows) | 0 ₽ | 45 сек | пока включён |

## Быстрый старт

```powershell
cd "C:\Users\саша\Documents\deepseek-harness\default-workspace\detector-aero"

node watch.mjs --status     # что сейчас в небе над районом
node watch.mjs --digest      # часовая сводка: опасность/спокойно + события за час
node watch.mjs --test       # тестовое уведомление во все каналы
node watch.mjs              # работать постоянно (опрос каждые 45 с)
node watch.mjs --once       # один опрос, без уведомлений (для проверки)
```

Установка в автозапуск (запускается при входе в Windows, без окна консоли):

```powershell
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -StartNow
```

Удалить из автозапуска и остановить:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -Uninstall
```

## Настройка

Всё в `config.json`.

| Параметр | Смысл |
|---|---|
| `area.center` | Точка отсчёта (Батайск), координаты |
| `area.radiusKm` | Радиус, в котором события считаются «рядом» |
| `area.zones` | Список зон сайта, события которых берём целиком |
| `threats` | Какие типы угроз интересны: `uav`, `fpv`, `missile`, `pvo`, `aviation`, `mvsh`, `threat`, `unknown` |
| `minSeverity` | Минимальная важность события (1–10) |
| `pollSeconds` | Период опроса, секунды (не меньше 20) |
| `channels.ntfy` | Push на телефон через ntfy.sh |
| `channels.telegram` | Телеграм-бот (в этой сети недоступен, см. ниже) |
| `channels.windowsToast` | Всплывающие уведомления Windows |

## Push на телефон (ntfy)

1. Установите приложение **ntfy** (Google Play / App Store) или откройте <https://ntfy.sh>.
2. Подпишитесь на топик: `dtr-aero-bt-8c4f2e91a7`
3. Проверка: `node watch.mjs --test` — на телефон придёт тестовое сообщение.

Топик — это и есть пароль: кто знает имя, тот может читать и писать. Имя длинное и случайное;
если оно утекло — поменяйте топик и переподпишитесь.

В GitHub Actions топик не хранится в файле, а передаётся через секрет `NTFY_TOPIC`
(см. `GITHUB-SETUP.md`). Вручную можно задать его переменной окружения:

```powershell
$env:NTFY_TOPIC="ваш-топик"; node watch.mjs
```

Свой сервер: укажите `channels.ntfy.server` (например `https://ntfy.mydomain.ru`).

## Telegram

В этой сети `api.telegram.org` блокируется на уровне провайдера: TCP-соединение устанавливается,
но TLS-сессия и даже plain HTTP обрываются (RST) — проверено на всех известных IP Telegram,
портах 80/443 и с разными SNI. Через VPN/прокси канал заработает:

1. В @BotFather создать бота, получить токен.
2. Написать боту `/start`, затем узнать `chat_id`:
   `https://api.telegram.org/bot<ТОКЕН>/getUpdates`
3. В `config.json`:

```json
"telegram": { "enabled": true, "botToken": "123456:AA...", "chatId": "123456789" }
```

## Windows-уведомления

`windows-toast.ps1` сначала пытается показать настоящий toast, а если Windows его не разрешает
(приложение не зарегистрировано) — показывает системный «шарик» в трее. Регистрацию выполняет
`install-autostart.ps1`.

## Что важно понимать

- Данные сайта — из открытых источников, они могут опаздывать и ошибаться.
- Уведомление не заменяет сирену и официальные сообщения МЧС.
- Скрипт не отправляет никаких данных на сайт, кроме обычных запросов карты.
