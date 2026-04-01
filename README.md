# FTP Deploy Action

GitHub Action для загрузки файлов на FTP/SFTP с логированием каждого файла (basic-ftp v5.2+).

## Использование

```yaml
steps:
  - uses: actions/checkout@v3

  - name: FTP Upload
    uses: fxpw/ftp_action@v1
    with:
      host: ${{ secrets.FTP_HOST }}
      username: ${{ secrets.FTP_USER }}
      password: ${{ secrets.FTP_PASS }}
      local_dir: "./build"
      remote_dir: "/public_html"
      secure: "false"