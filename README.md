# FTP Deploy Action

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-FTP%20Deploy%20Action-blue?logo=github)](https://github.com/marketplace/actions/ftp-deploy-action)

GitHub Action для загрузки файлов на FTP/FTPS/SFTP с логированием каждого файла.

## Входные параметры

| Параметр | Описание | Обязательный | По умолчанию |
|----------|----------|:---:|:---:|
| `connection_type` | Тип соединения: `ftp` \| `ftps` \| `sftp` \| `ftps/ftp` (авторежим FTPS→FTP) | ❌ | `ftps/ftp` |
| `host` | FTP/SFTP хост | ✅ | — |
| `username` | FTP пользователь | ✅ | — |
| `password` | FTP пароль | ✅ | — |
| `local_dir` | Локальная папка для загрузки | ✅ | `./` |
| `remote_dir` | Директория на сервере | ❌ | `/` |
| `secure` | Использовать FTPS (актуально только для FTP/FTPS) | ❌ | `false` |
| `secure_reject_unauthorized` | Проверять TLS сертификат FTPS-сервера (только FTPS) | ❌ | `true` |
| `retry_count` | Количество повторных попыток при сетевой ошибке | ❌ | `3` |
| `retry_delay_ms` | Пауза между попытками (мс) | ❌ | `2000` |
| `parallel_uploads` | Количество параллельных загрузок | ❌ | `3` |

## Использование

```yaml
steps:
  - uses: actions/checkout@v4

  - name: FTP Upload
    uses: fxpw/ftp_action@v1.0.0
    with:
      connection_type: "ftps/ftp"
      host: ${{ secrets.FTP_HOST }}
      username: ${{ secrets.FTP_USER }}
      password: ${{ secrets.FTP_PASS }}
      local_dir: "./build"
      remote_dir: "/public_html"
      secure: "false"
      secure_reject_unauthorized: "true"
      retry_count: "3"
      retry_delay_ms: "2000"
      parallel_uploads: "3"
```

## Режимы подключения

- `ftps/ftp` (по умолчанию): action сначала пытается подключиться по FTPS, при ошибке автоматически переключается на FTP.
- `sftp`: action использует только SFTP (SSH). Автопереключения на FTP/FTPS нет.
- `ftp` и `ftps`: жесткая фиксация протокола без fallback.

## Поведение при ошибках

- При `ECONNRESET`, `EPIPE`, `Client is closed` и других сетевых ошибках action пытается переподключиться и повторить загрузку файла.
- Если после всех попыток хотя бы один файл не загружен, step завершается с ошибкой (exit code `1`).

### Self-signed сертификат (FTPS)

Если FTPS-сервер использует self-signed сертификат, установите:

```yaml
secure: "true"
secure_reject_unauthorized: "false"
```

Это отключает проверку доверия TLS-сертификата. Используйте только в доверенной сети/инфраструктуре.

## Параллельная загрузка

- Action загружает файлы параллельно, по нескольким воркерам.
- Рекомендуемое значение `parallel_uploads` — `2` или `3`.

## Прогресс и скорость

- Во время выполнения action выводит прогресс по файлам и объему.
- Дополнительно выводится средняя скорость загрузки в `MB/s` и расчетное время завершения (`ETA`).

## Лицензия

[MIT](LICENSE)