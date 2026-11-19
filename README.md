# AI Media Studio Telegram Bot

Полноценный Telegram-бот на NestJS для генерации, редактирования и анимации изображений и видео.

## Что умеет

- текст → изображение;
- фото + текст → редактирование изображения;
- текст → видео;
- фото → анимация/видео;
- длинные ролики до 180 секунд через разбиение на сцены и склейку FFmpeg;
- AI Director: понимает обычный человеческий запрос, сам определяет тип результата, длительность, формат и сцены;
- FREE / PREMIUM / CINEMA режимы;
- бесплатный локальный режим без платных API;
- платные premium-модели через OpenAI и Runway;
- Telegram Stars → внутренние credits;
- PostgreSQL + Prisma;
- Redis + BullMQ очередь;
- история генераций;
- возврат credits при ошибке;
- роли FREE / PREMIUM / ADMIN;
- ADMIN полностью обходит внутренние лимиты и списания;
- администратор может сам назначать Premium-пользователей;
- Premium можно сделать sponsored: пользователь не тратит credits, но ограничен дневным лимитом.

> Важно: ADMIN «безлимит» означает отсутствие ограничений самого бота. Если ADMIN запускает платную модель OpenAI/Runway, поставщик API всё равно списывает реальные деньги с аккаунта владельца.

---

## Режимы

### FREE

Никаких платных AI API.

- text → image: локальный ComfyUI + SDXL/Flux workflow, либо бесплатный хостед-фолбэк [pollinations.ai](https://pollinations.ai) (без регистрации и ключей), если `COMFYUI_URL` не задан;
- photo → edit: локальный ComfyUI img2img workflow (требует ComfyUI, у pollinations нет фолбэка для редактирования);
- photo → video: бесплатная FFmpeg-анимация даже без AI video model;
- text → video: keyframe создаётся через ComfyUI или pollinations.ai, затем анимируется FFmpeg;
- если подключить локальный video workflow (например Wan), бот использует его вместо FFmpeg fallback.

Это бесплатно по API, но локальная ComfyUI-генерация требует твоих CPU/GPU ресурсов. Фолбэк через pollinations.ai работает совсем без установки чего-либо, но добавляет небольшой водяной знак на изображения (пока не задан `POLLINATIONS_TOKEN`) и отправляет промпт на сторонний сервис. Отключается через `DISABLE_POLLINATIONS_FALLBACK=true`.

### PREMIUM

- OpenAI image model, либо автоматический фолбэк на альтернативных провайдеров изображений (в этом порядке, по наличию ключа): OpenAI → [fal.ai](https://fal.ai/) (FLUX) → [Fusion Brain / Kandinsky](https://fusionbrain.ai/) (Сбер) → [YandexART](https://yandex.cloud/) (Yandex Cloud AI Studio).
  - Редактирование фото (photo + текст) по-прежнему требует именно `OPENAI_API_KEY` — у альтернатив нет img2img в этой интеграции.
- Runway video, либо фолбэк на [fal.ai + Kling](https://fal.ai/models/fal-ai/kling-video/v2.6/pro/image-to-video) (image-to-video) — тот же `FAL_KEY`, что и для картинок, либо свой деплой [Wan2.2](https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B-Diffusers) на Modal (`MODAL_WAN_VIDEO_URL`).
  - `FUSIONBRAIN_API_KEY`+`FUSIONBRAIN_SECRET_KEY` — оплата в рублях, без VPN, но на момент интеграции сервис fusionbrain.ai был недоступен (проверить перед использованием);
  - `YANDEX_API_KEY`+`YANDEX_FOLDER_ID` — оплата в рублях через Yandex Cloud, без VPN, только картинки;
  - `FAL_KEY` — оплата зарубежной картой/криптой, без VPN не требуется, но платёжный метод не российский; зато лучшее качество и картинок (FLUX), и image-to-video (Kling), обе через единый ключ и очередь задач.
  - `MODAL_ZIMAGE_URL` / `MODAL_QWEN_IMAGE_URL` — свой собственный деплой [Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) и [Qwen-Image](https://huggingface.co/Qwen/Qwen-Image) на [Modal](https://modal.com/). ⚠️ На практике для запуска GPU-функций Modal требует привязать карту, даже если пользоваться только бесплатными $30/месяц — без карты вызов падает с ошибкой `Please add a payment method to use L4 GPU functions.`. См. `modal-inference/` ниже.
  - `HF_SPACE_ZIMAGE_URL` — Z-Image-Turbo на бесплатном [Hugging Face Space с ZeroGPU](https://huggingface.co/docs/hub/spaces-zerogpu). Единственный из всех вариантов, где карта не нужна вообще — даже для GPU. Обратная сторона: всего 5 минут GPU в сутки на бесплатном аккаунте, так что это бонусный движок на пару генераций в день, а не основной. См. `hf-space-zimage/`.

### Свой хостинг открытых моделей (Modal)

В папке [`modal-inference/`](modal-inference/) лежат два самодостаточных Python-приложения для [Modal](https://modal.com/) — сервиса serverless GPU с оплатой по факту использования (и бесплатным лимитом $30/мес без карты):

```powershell
pip install modal
modal setup
modal deploy modal-inference/z_image_app.py
modal deploy modal-inference/qwen_image_app.py
modal deploy modal-inference/wan_video_app.py
```

После каждого деплоя Modal печатает HTTPS-адрес вида `https://<workspace>--ai-media-bot-z-image-zimagemodel-generate.modal.run` — эти адреса нужно положить в `.env` как `MODAL_ZIMAGE_URL` / `MODAL_QWEN_IMAGE_URL` / `MODAL_WAN_VIDEO_URL`.

Важно: это **не проверено вживую** (нет доступа к Modal-аккаунту) — контракты запроса/ответа написаны по официальной документации `diffusers` (`ZImagePipeline`, `QwenImagePipeline`, `WanImageToVideoPipeline`), но реальный первый запуск может потребовать мелких правок (версии зависимостей, память GPU). Z-Image-Turbo рассчитан на GPU уровня L4 (24ГБ), Qwen-Image — на L40S (48ГБ), Wan2.2 video — на A100 80ГБ (это MoE-модель из двух трансформеров по 14B, самая тяжёлая из трёх); при нехватке памяти увеличьте `gpu=` в соответствующем файле. Видео заметно медленнее и съедает бесплатный лимит Modal быстрее, чем картинки.
- AI Director;
- длинное видео собирается из нескольких клипов;
- для стабильности персонажа/товара создаётся единый reference frame.

### CINEMA

То же, но бот выбирает более качественную image-модель и повышенную внутреннюю цену для обычных платящих пользователей. ADMIN всё равно ничего не списывает внутри бота.

---

## Роли

### ADMIN

Задаётся в `.env`:

```env
ADMIN_TELEGRAM_IDS=123456789,987654321
```

Все эти Telegram ID автоматически получают ADMIN и:

- не имеют дневных лимитов;
- не тратят credits;
- могут использовать FREE/PREMIUM/CINEMA;
- могут назначать Premium другим пользователям;
- могут начислять credits.

### PREMIUM

Назначается из Telegram:

```text
/admin premium 123456789 30 20
```

Где:

- `123456789` — Telegram ID пользователя;
- `30` — количество дней;
- `20` — максимум premium-генераций в сутки.

Если в `.env`:

```env
PREMIUM_SPONSORED=true
```

назначенный тобой Premium не тратит credits, но остаётся ограничен дневным лимитом. Это удобно для друзей, команды, VIP-клиентов и тестеров.

Вернуть FREE:

```text
/admin free 123456789
```

Начислить credits:

```text
/admin credits 123456789 5000
```

Посмотреть пользователя:

```text
/admin user 123456789
```

Пользователь должен хотя бы один раз нажать `/start`, чтобы появиться в базе.

---

# Быстрый запуск через Docker

## 1. Создай бота

В Telegram открой `@BotFather` → `/newbot` → получи token.

## 2. Узнай свой Telegram ID

Запусти бота после первой настройки или воспользуйся любым способом узнать numeric Telegram ID. В самом боте `/start` также показывает ID.

## 3. Настрой env

Windows PowerShell:

```powershell
Copy-Item .env.example .env
notepad .env
```

Минимум:

```env
TELEGRAM_BOT_TOKEN=123456:ABCDEF...
ADMIN_TELEGRAM_IDS=ТВОЙ_TELEGRAM_ID
```

Для Premium:

```env
OPENAI_API_KEY=...
RUNWAYML_API_SECRET=...
```

## 4. Запусти

```powershell
docker compose up -d --build
```

Логи:

```powershell
docker compose logs -f app
```

Остановка:

```powershell
docker compose down
```

Данные PostgreSQL/Redis сохраняются в Docker volumes, а результаты генераций — в `./data`.

---

# Бесплатный локальный режим

## Вариант A — только фото → длинная анимация

Если пользователь загружает фотографию и просит «оживи на 30 секунд», FREE режим умеет сделать плавную camera-motion анимацию через FFmpeg без платного API.

Для text → image/text → video нужен локальный ComfyUI.

## Вариант B — ComfyUI + SDXL

1. Установи ComfyUI на ПК с GPU.
2. Запусти его с API доступом на `8188`.
3. Положи SDXL checkpoint в `ComfyUI/models/checkpoints`.
4. Укажи точное имя файла:

```env
COMFYUI_URL=http://host.docker.internal:8188
COMFYUI_CHECKPOINT=sd_xl_base_1.0.safetensors
```

В архив уже включены API workflow:

```text
assets/comfyui/sdxl_text_to_image_api.json
assets/comfyui/sdxl_img2img_api.json
```

Они используют только стандартные ноды ComfyUI.

## Вариант C — бесплатный локальный AI-video (Wan и т.п.)

Установи нужную video-модель в ComfyUI и экспортируй её workflow в API format. В значениях workflow можно использовать placeholders:

```text
{{PROMPT}}
{{NEGATIVE_PROMPT}}
{{SEED}}
{{WIDTH}}
{{HEIGHT}}
{{DURATION}}
{{FPS}}
{{INPUT_IMAGE}}
{{CHECKPOINT}}
```

Путь укажи в:

```env
COMFYUI_VIDEO_WORKFLOW=/app/assets/comfyui/my_wan_video_api.json
```

После этого FREE video автоматически переключается с FFmpeg fallback на настоящий локальный AI-video workflow.

---

# Premium API

## OpenAI

По умолчанию:

```env
OPENAI_IMAGE_MODEL_PREMIUM=gpt-image-2.5-flare
OPENAI_IMAGE_MODEL_CINEMA=gpt-image-2.5-sunburst
DIRECTOR_MODEL=gpt-5.6-luna
```

Можно поменять модели только через `.env`.

## Runway

```env
RUNWAY_VIDEO_MODEL=gen4.5
RUNWAY_CLIP_SECONDS=5
```

Бот вызывает `/v1/image_to_video`, ждёт готовность task и скачивает результат.

Для длинного ролика бот:

1. понимает общий запрос;
2. строит storyboard;
3. создаёт reference frame;
4. рендерит несколько клипов;
5. сохраняет общий визуальный контекст в prompt каждого клипа;
6. склеивает клипы FFmpeg;
7. нормализует итоговый размер;
8. при необходимости создаёт сжатую Telegram-копию.

Максимальная логическая длительность сейчас ограничена кодом 180 сек. Можно увеличить.

---

# Telegram Stars и credits

Команда:

```text
/buy
```

Показывает пакеты. Цены задаются в `.env`:

```env
STARS_PACK_1_STARS=250
STARS_PACK_1_CREDITS=500
STARS_PACK_2_STARS=1000
STARS_PACK_2_CREDITS=2300
STARS_PACK_3_STARS=2500
STARS_PACK_3_CREDITS=6500
```

Digital goods внутри Telegram оплачиваются Stars (`XTR`). Бот обрабатывает:

- invoice;
- pre_checkout_query;
- successful_payment;
- защиту от двойного начисления по `telegram_payment_charge_id`.

---

# Стоимость внутри продукта

Настраивается без изменения кода:

```env
COST_IMAGE_PREMIUM=40
COST_VIDEO_PREMIUM_PER_5S=220
COST_LONG_VIDEO_ASSEMBLY=20
```

CINEMA автоматически стоит в 1.5 раза больше credits для обычных платящих пользователей.

FREE всегда стоит 0 credits.

ADMIN всегда стоит 0 credits.

Premium при `PREMIUM_SPONSORED=true` тоже стоит 0 credits, но имеет дневной cap.

---

# Основные команды

```text
/start
/help
/free
/premium
/cinema
/balance
/buy
/history
```

Admin:

```text
/admin
/admin premium <telegramId> [days] [dailyCap]
/admin free <telegramId>
/admin credits <telegramId> <amount>
/admin user <telegramId>
```

---

# Примеры обычных запросов

```text
Создай реалистичное фото Porsche 911 ночью в Токио под дождём, вертикальное.
```

```text
Сделай ролик 30 секунд: красный Porsche едет ночью по Токио, мокрый асфальт, неон, камера движется рядом, вертикально.
```

Загрузить фото + caption:

```text
Оживи на 20 секунд. Волосы двигаются от ветра, камера медленно приближается.
```

Загрузить фото, затем отдельным сообщением:

```text
Замени фон на вечерний Париж, оставь лицо и одежду человека максимально похожими.
```

---

# Архитектура

```text
Telegram
   │
   ▼
TelegramService
   │
   ├── Users / Roles
   ├── Billing / Stars / Credits
   ├── AI Director
   │
   ▼
BullMQ (Redis)
   │
   ▼
GenerationProcessor
   │
   ├── FREE
   │    ├── ComfyUI image/img2img
   │    ├── optional ComfyUI video
   │    └── FFmpeg free motion fallback
   │
   ├── PREMIUM / CINEMA
   │    ├── OpenAI image/edit
   │    ├── Runway video
   │    └── long-video scene assembly
   │
   ▼
Local storage + PostgreSQL
   │
   ▼
Telegram result
```

---

# Что стоит добавить перед большим коммерческим запуском

Текущая версия уже является рабочей основой/MVP, но перед тысячами пользователей стоит добавить:

- S3/R2 object storage вместо локального `data/`;
- webhook вместо long polling;
- отдельный worker deployment;
- несколько очередей по приоритетам;
- rate limiting по IP/user;
- moderation и abuse monitoring;
- observability (Sentry/Prometheus/OpenTelemetry);
- cleanup старых файлов;
- полноценный Web Admin/Mini App;
- provider routing по реальной цене/качеству/очереди;
- автоматический quality-check и retry лучшего варианта;
- music/TTS/SFX pipeline;
- subtitles;
- более сильную character consistency через reference-specific providers/workflows.

---

# Официальная документация, на которую ориентирована интеграция

- OpenAI API: https://developers.openai.com/
- Runway Dev API: https://docs.dev.runwayml.com/
- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram Stars payments: https://core.telegram.org/bots/payments-stars
- ComfyUI: https://docs.comfy.org/

