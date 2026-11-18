# Nyenschantz

<img src="logo.png" alt="Nyenschantz Logo" width="300">

Публичный потоковый reverse proxy с маршрутизацией по первому сегменту пути.
Запускается через Docker Compose: Caddy получает и продлевает HTTPS-сертификаты,
Node.js пересылает запросы настроенным upstream-серверам. Авторизации нет.

```text
Интернет → Caddy :80/:443 → proxy :3000 → upstream
```

## Запуск на сервере

Нужны Docker Engine с Compose plugin, домен и доступные входящие TCP-порты 80/443.
DNS-запись A должна указывать на сервер. Если есть AAAA, IPv6 тоже должен работать.
Порты не должны быть заняты другим веб-сервером.

```sh
cp .env.example .env
```

Укажите свой домен в `.env`, проверьте `proxy.config.json`, затем:

```sh
docker compose up -d --build
docker compose ps
docker compose logs -f
```

Caddy автоматически выпустит сертификат. HTTP перенаправляется на HTTPS.
Приложение не публикует свой порт на хосте. Сертификаты сохраняются в volume
`caddy_data`; **не используйте `docker compose down -v`**, если хотите их сохранить.

## Маршруты

В `proxy.config.json` каждому первому сегменту пути соответствует upstream:

```json
{
  "routes": {
    "cloudflare": {
      "target": "https://api.cloudflareclient.com/v0i1909051800"
    },
    "myservice": {
      "target": "https://api.example.com/v1"
    }
  }
}
```

Запрос `https://proxy.example.com/myservice/users?limit=10` уйдёт на
`https://api.example.com/v1/users?limit=10`. Query-параметры target сохраняются
и дополняются параметрами запроса. Конфигурация проверяется при запуске;
допускаются только HTTP/HTTPS без логина, пароля и fragment.

Файл подключён read-only. После изменения маршрутов:

```sh
docker compose restart proxy
```

После изменения `.env` используйте `docker compose up -d`.

## Передача данных

- Тела запросов и ответов передаются потоком, без полной буферизации; SSE поддерживается.
- Статусы, сжатые тела, `Authorization`, `Cookie` и несколько `Set-Cookie` сохраняются.
- `Host` заменяется адресом upstream; hop-by-hop и входящие `Forwarded`/`X-Forwarded-*` удаляются.
- Редиректы возвращаются клиенту как есть, включая исходный `Location`.
- WebSocket, HTTP trailers и CONNECT не поддерживаются.
- `UPSTREAM_TIMEOUT_MS` (по умолчанию 60000) ограничивает ожидание заголовков
  upstream и простой его сокета. Это не ограничение общей длительности SSE:
  поток может работать долго, если регулярно поступают данные.

Логи приложения содержат метод, ключ маршрута, статус и длительность. Полные пути
(в них могут быть токены), query-параметры, тела и заголовки не логируются.
Access log Caddy выключен; его служебные/диагностические сообщения могут содержать
детали запросов, поэтому доступ к логам должен быть ограничен.

## JSON-ошибки

Для `/` и неизвестного маршрута возвращается HTTP 404:

```json
{"error":{"code":"route_not_found","message":"Route not found"}}
```

Все собственные ошибки имеют `Content-Type: application/json` и `Cache-Control: no-store`:

| Статус | Код | Причина |
| --- | --- | --- |
| 400 | `bad_request` | Некорректный HTTP-запрос или путь |
| 404 | `route_not_found` | Неизвестный маршрут |
| 500 | `internal_error` | Внутренняя ошибка приложения |
| 502 | `upstream_unavailable` | Ошибка соединения с upstream |
| 504 | `upstream_timeout` | Истекло время ожидания upstream |
| 5xx | `gateway_error` | Ошибка Caddy, например приложение недоступно |

Ошибки конфигурации и очевидные циклы (собственный домен, localhost, имена
контейнеров) предотвращают запуск. Это не защита от всех DNS-алиасов и циклов:
используйте только доверенные target.

Ответы upstream, в том числе HTML-ошибки, передаются без преобразования в JSON.
Если передача ответа уже началась, при сбое соединение закрывается:
заменить отправленные заголовки и тело JSON-ошибкой невозможно.
HTTP HEAD по стандарту возвращает только заголовки, без тела.

## Ручная проверка на ВМ

Подставьте свой домен:

```sh
curl -I http://proxy.example.com/
curl -i https://proxy.example.com/
curl -i https://proxy.example.com/unknown/path
curl -i https://proxy.example.com/cloudflare/
```

Проверьте POST с телом и SSE (`curl -N`) на подходящем настроенном upstream.
Для проверки 502 временно добавьте target `http://127.0.0.2:65534` и перезапустите
приложение. Для 504 используйте контролируемый upstream, который задерживает
заголовки дольше `UPSTREAM_TIMEOUT_MS`. Удалите временные маршруты после проверки.

Проверка JSON-ошибки Caddy при остановленном приложении:

```sh
docker compose stop proxy
curl -i https://proxy.example.com/cloudflare/
docker compose start proxy
```

## Обновление и остановка

```sh
git pull
docker compose build --pull
docker compose pull caddy
docker compose up -d
```

Остановка: `docker compose down` (сертификаты сохраняются).
При завершении приложение даёт активным запросам до 10 секунд.

## Безопасность

Любой пользователь интернета может обращаться к настроенным upstream через ваш
сервер и расходовать трафик и квоты. Не добавляйте приватные сервисы и target
с секретами в query. Секреты клиентов должны передаваться самими клиентами.
Список маршрутов ограничен конфигурацией: произвольный target из запроса не принимается.
Приложение работает не от root, с read-only файловой системой; Docker-логи ротируются.
