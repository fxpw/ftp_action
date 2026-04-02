# FTP Deploy Action

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-FTP%20Deploy%20Action-blue?logo=github)](https://github.com/marketplace/actions/ftp-deploy-action)

GitHub Action для загрузки файлов на FTP/SFTP с логированием каждого файла (basic-ftp v5.2+).

## Входные параметры

| Параметр | Описание | Обязательный | По умолчанию |
|----------|----------|:---:|:---:|
| `host` | FTP/SFTP хост | ✅ | — |
| `username` | FTP пользователь | ✅ | — |
| `password` | FTP пароль | ✅ | — |
| `local_dir` | Локальная папка для загрузки | ✅ | `./` |
| `remote_dir` | Директория на сервере | ❌ | `/` |
| `secure` | Использовать FTPS | ❌ | `false` |
| `retry_count` | Количество повторных попыток при сетевой ошибке | ❌ | `3` |
| `retry_delay_ms` | Пауза между попытками (мс) | ❌ | `2000` |

## Использование

```yaml
steps:
  - uses: actions/checkout@v4

  - name: FTP Upload
    uses: fxpw/ftp_action@v1.0.0
    with:
      host: ${{ secrets.FTP_HOST }}
      username: ${{ secrets.FTP_USER }}
      password: ${{ secrets.FTP_PASS }}
      local_dir: "./build"
      remote_dir: "/public_html"
      secure: "false"
      retry_count: "3"
      retry_delay_ms: "2000"
```

    ## Поведение при ошибках

    - При `ECONNRESET` и `Client is closed` action пытается переподключиться и повторить загрузку файла.
    - Если после всех попыток хотя бы один файл не загружен, step завершается с ошибкой (exit code `1`).

## Лицензия

[MIT](LICENSE)