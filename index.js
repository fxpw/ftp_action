import ftp from "basic-ftp";
import fs from "fs";
import path from "path";

async function main() {
    const host = process.env.INPUT_HOST;
    const user = process.env.INPUT_USERNAME;
    const pass = process.env.INPUT_PASSWORD;
    const localDir = process.env.INPUT_LOCAL_DIR || "./";
    const remoteDir = process.env.INPUT_REMOTE_DIR || "/";
    const secure = process.env.INPUT_SECURE === "true";
    const retryCount = Number.parseInt(process.env.INPUT_RETRY_COUNT || "3", 10);
    const retryDelayMs = Number.parseInt(process.env.INPUT_RETRY_DELAY_MS || "2000", 10);
    const parallelUploads = Number.parseInt(process.env.INPUT_PARALLEL_UPLOADS || "3", 10);

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

    if (!Number.isInteger(parallelUploads) || parallelUploads < 1 || parallelUploads > 3) {
        console.error("❌ INPUT_PARALLEL_UPLOADS должен быть целым числом от 1 до 3");
        process.exit(1);
    }

    /** @param {number} ms */
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /** @returns {ftp.Client} */
    function createClient() {
        const client = new ftp.Client();
        client.ftp.verbose = false;
        return client;
    }

    /** @param {ftp.Client} client */
    async function connect(client) {
        await client.access({ host, user, password: pass, secure });
        await client.ensureDir(remoteDir);
    }

    /** @param {ftp.Client} client */
    async function reconnect(client) {
        try {
            client.close();
        } catch {
            // ignore close errors before reconnect
        }
        await connect(client);
    }

    /**
     * @param {ftp.Client} client
     * @param {string} localFile
     * @param {string} remoteFile
     * @param {number} workerId
     * @returns {Promise<boolean>}
     */
    async function uploadWithRetry(client, localFile, remoteFile, workerId) {
        let lastError;

        for (let attempt = 0; attempt <= retryCount; attempt++) {
            if (attempt > 0) {
                console.log(`🔁 [W${workerId}] Повторная попытка ${attempt}/${retryCount}: ${localFile}`);
                if (retryDelayMs > 0) {
                    await sleep(retryDelayMs);
                }
            }

            try {
                await client.ensureDir(path.posix.dirname(remoteFile));
                console.log(`⬆️ [W${workerId}] Загружаем файл: ${localFile} → ${remoteFile}`);
                await client.uploadFrom(localFile, remoteFile);
                console.log(`✅ [W${workerId}] Загружен: ${path.basename(localFile)}`);
                return true;
            } catch (err) {
                lastError = err;
                const message = err instanceof Error ? err.message : String(err);
                const shouldReconnect =
                    message.includes("ECONNRESET") || message.includes("Client is closed");

                console.error(`❌ [W${workerId}] Ошибка загрузки ${path.basename(localFile)} (попытка ${attempt + 1}/${retryCount + 1}): ${message}`);

                if (attempt < retryCount && shouldReconnect) {
                    try {
                        console.log(`🔌 [W${workerId}] Восстанавливаем FTP соединение...`);
                        await reconnect(client);
                        console.log(`✅ [W${workerId}] Соединение восстановлено`);
                    } catch (reconnectErr) {
                        const reconnectMessage =
                            reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr);
                        console.error(`❌ [W${workerId}] Ошибка переподключения: ${reconnectMessage}`);
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

    /**
     * @param {string} rootPath
     * @returns {Array<{local: string, remote: string}>}
     */
    function collectFiles(rootPath) {
        /** @type {Array<{local: string, remote: string}>} */
        const files = [];

        /** @param {string} currentPath */
        function walk(currentPath) {
            const entries = fs.readdirSync(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                const localEntryPath = path.join(currentPath, entry.name);

                if (entry.isDirectory()) {
                    walk(localEntryPath);
                    continue;
                }

                if (entry.isFile()) {
                    const relativePath = path.relative(rootPath, localEntryPath).split(path.sep).join(path.posix.sep);
                    const remoteEntryPath = path.posix.join(remoteDir, relativePath);
                    files.push({ local: localEntryPath, remote: remoteEntryPath });
                }
            }
        }

        walk(rootPath);
        return files;
    }

    console.log("🔹 Подключение к FTP серверу...");

    try {
        const checkClient = createClient();
        await connect(checkClient);
        checkClient.close();

        console.log("✅ Успешное подключение");
        console.log(`📂 Целевая директория на сервере: ${remoteDir}`);
        console.log(`🚀 Параллельных загрузок: ${parallelUploads}`);

        /** @type {string[]} */
        const failedUploads = [];
        let uploadedCount = 0;

        const filesToUpload = collectFiles(localDir);
        if (filesToUpload.length === 0) {
            console.log("ℹ️ Нет файлов для загрузки");
        }

        let nextIndex = 0;

        /** @param {number} workerId */
        async function worker(workerId) {
            const workerClient = createClient();
            await connect(workerClient);

            try {
                while (nextIndex < filesToUpload.length) {
                    const currentIndex = nextIndex;
                    nextIndex += 1;
                    const file = filesToUpload[currentIndex];
                    if (!file) {
                        continue;
                    }

                    const uploaded = await uploadWithRetry(workerClient, file.local, file.remote, workerId);
                    if (uploaded) {
                        uploadedCount += 1;
                    } else {
                        failedUploads.push(file.local);
                    }
                }
            } finally {
                workerClient.close();
            }
        }

        const workers = [];
        const workerCount = Math.min(parallelUploads, filesToUpload.length || parallelUploads);
        for (let workerId = 1; workerId <= workerCount; workerId++) {
            workers.push(worker(workerId));
        }

        await Promise.all(workers);

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
        console.log("🔹 Отключение от FTP сервера");
    }
}

main();