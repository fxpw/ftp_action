import ftp from "basic-ftp";
import fs from "fs";
import path from "path";

async function main() {
    const client = new ftp.Client();
    client.ftp.verbose = false;

    const host = process.env.INPUT_HOST;
    const user = process.env.INPUT_USERNAME;
    const pass = process.env.INPUT_PASSWORD;
    const localDir = process.env.INPUT_LOCAL_DIR || "./";
    const remoteDir = process.env.INPUT_REMOTE_DIR || "/";
    const secure = process.env.INPUT_SECURE === "true";
    const retryCount = Number.parseInt(process.env.INPUT_RETRY_COUNT || "3", 10);
    const retryDelayMs = Number.parseInt(process.env.INPUT_RETRY_DELAY_MS || "2000", 10);

    if (!host || !user || !pass) {
        console.error("❌ INPUT_HOST, INPUT_USERNAME и INPUT_PASSWORD обязательны");
        process.exit(1);
    }

    if (!Number.isInteger(retryCount) || retryCount < 0) {
        console.error("❌ INPUT_RETRY_COUNT должен быть целым числом >= 0");
        process.exit(1);
    }

    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
        console.error("❌ INPUT_RETRY_DELAY_MS должен быть целым числом >= 0");
        process.exit(1);
    }

    /** @param {number} ms */
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function connect() {
        await client.access({ host, user, password: pass, secure });
        await client.ensureDir(remoteDir);
    }

    async function reconnect() {
        try {
            client.close();
        } catch {
            // ignore close errors before reconnect
        }
        await connect();
    }

    /**
     * @param {string} localFile
     * @param {string} remoteFile
     * @returns {Promise<boolean>}
     */
    async function uploadWithRetry(localFile, remoteFile) {
        let lastError;

        for (let attempt = 0; attempt <= retryCount; attempt++) {
            if (attempt > 0) {
                console.log(`🔁 Повторная попытка ${attempt}/${retryCount}: ${localFile}`);
                if (retryDelayMs > 0) {
                    await sleep(retryDelayMs);
                }
            }

            try {
                console.log(`⬆️ Загружаем файл: ${localFile} → ${remoteFile}`);
                await client.uploadFrom(localFile, remoteFile);
                console.log(`✅ Загружен: ${path.basename(localFile)}`);
                return true;
            } catch (err) {
                lastError = err;
                const message = err instanceof Error ? err.message : String(err);
                const shouldReconnect =
                    message.includes("ECONNRESET") || message.includes("Client is closed");

                console.error(`❌ Ошибка загрузки ${path.basename(localFile)} (попытка ${attempt + 1}/${retryCount + 1}): ${message}`);

                if (attempt < retryCount && shouldReconnect) {
                    try {
                        console.log("🔌 Восстанавливаем FTP соединение...");
                        await reconnect();
                        console.log("✅ Соединение восстановлено");
                    } catch (reconnectErr) {
                        const reconnectMessage =
                            reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr);
                        console.error(`❌ Ошибка переподключения: ${reconnectMessage}`);
                    }
                }
            }
        }

        console.error(`❌ Файл не загружен после ${retryCount + 1} попыток: ${localFile}`);
        if (lastError) {
            console.error(lastError);
        }
        return false;
    }

    console.log("🔹 Подключение к FTP серверу...");

    try {
        await connect();
        console.log("✅ Успешное подключение");
        console.log(`📂 Целевая директория на сервере: ${remoteDir}`);

        /** @type {string[]} */
        const failedUploads = [];
        let uploadedCount = 0;

        /**
         * @param {string} localPath
         * @param {string} remotePath
         * @returns {Promise<void>}
         */
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
                        const uploaded = await uploadWithRetry(localEntryPath, remoteEntryPath);
                        if (uploaded) {
                            uploadedCount += 1;
                        } else {
                            failedUploads.push(localEntryPath);
                        }
                    } catch (err) {
                        console.error(`❌ Ошибка при загрузке файла ${entry.name}:`, err);
                        failedUploads.push(localEntryPath);
                    }
                }
            }
        }

        await uploadDir(localDir, remoteDir);

        if (failedUploads.length > 0) {
            console.error(`❌ Загружено файлов: ${uploadedCount}`);
            console.error(`❌ Ошибок загрузки: ${failedUploads.length}`);
            for (const failedFile of failedUploads) {
                console.error(`   - ${failedFile}`);
            }
            process.exitCode = 1;
        } else {
            console.log(`🎉 Все файлы обработаны! Загружено: ${uploadedCount}`);
        }
    } catch (err) {
        console.error("❌ Ошибка подключения к FTP:", err);
        process.exit(1);
    } finally {
        client.close();
        console.log("🔹 Отключение от FTP сервера");
    }
}

main();