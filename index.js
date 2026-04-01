import ftp from "basic-ftp";
import fs from "fs";
import path from "path";

async function main() {
    const client = new ftp.Client();
    client.ftp.verbose = false; // свой лог

    const host = process.env.INPUT_HOST;
    const user = process.env.INPUT_USERNAME;
    const pass = process.env.INPUT_PASSWORD;
    const localDir = process.env.INPUT_LOCAL_DIR || "./";
    const remoteDir = process.env.INPUT_REMOTE_DIR || "/";
    const secure = process.env.INPUT_SECURE === "true";

    console.log("🔹 Подключение к FTP серверу...");

    try {
        await client.access({ host, user, password: pass, secure });
        console.log("✅ Успешное подключение");

        await client.ensureDir(remoteDir);
        console.log(`📂 Целевая директория на сервере: ${remoteDir}`);

        async function uploadDir(localPath, remotePath) {
            const entries = fs.readdirSync(localPath, { withFileTypes: true });
            for (const entry of entries) {
                const localEntryPath = path.join(localPath, entry.name);
                const remoteEntryPath = path.posix.join(remotePath, entry.name);

                if (entry.isDirectory()) {
                    try {
                        await client.ensureDir(remoteEntryPath);
                        console.log(`📁 Папка создана/проверена: ${remoteEntryPath}`);
                        await uploadDir(localEntryPath, remoteEntryPath);
                    } catch (err) {
                        console.error(`❌ Ошибка при обработке папки ${entry.name}:`, err);
                    }
                } else if (entry.isFile()) {
                    try {
                        console.log(`⬆️ Загружаем файл: ${localEntryPath} → ${remoteEntryPath}`);
                        await client.uploadFrom(localEntryPath, remoteEntryPath);
                        console.log(`✅ Загружен: ${entry.name}`);
                    } catch (err) {
                        console.error(`❌ Ошибка при загрузке файла ${entry.name}:`, err);
                    }
                }
            }
        }

        await uploadDir(localDir, remoteDir);
        console.log("🎉 Все файлы обработаны!");
    } catch (err) {
        console.error("❌ Ошибка подключения к FTP:", err);
        process.exit(1);
    } finally {
        client.close();
        console.log("🔹 Отключение от FTP сервера");
    }
}

main();