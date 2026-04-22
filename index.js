import ftp from "basic-ftp";
import fs from "fs";
import path from "path";
import SftpClient from "ssh2-sftp-client";

async function main() {
    const connectionTypeInputRaw = (process.env.INPUT_CONNECTION_TYPE || "ftps/ftp").toLowerCase();
    const connectionTypeInput = connectionTypeInputRaw === "ftp/ftps" ? "ftps/ftp" : connectionTypeInputRaw;
    const host = process.env.INPUT_HOST;
    const user = process.env.INPUT_USERNAME;
    const pass = process.env.INPUT_PASSWORD;
    const localDir = process.env.INPUT_LOCAL_DIR || "./";
    const remoteDir = process.env.INPUT_REMOTE_DIR || "/";
    const secure = process.env.INPUT_SECURE === "true";
    const secureRejectUnauthorizedInput = process.env.INPUT_SECURE_REJECT_UNAUTHORIZED || "true";
    const secureRejectUnauthorized = secureRejectUnauthorizedInput === "true";
    const retryCount = Number.parseInt(process.env.INPUT_RETRY_COUNT || "3", 10);
    const retryDelayMs = Number.parseInt(process.env.INPUT_RETRY_DELAY_MS || "2000", 10);
    const parallelUploads = Number.parseInt(process.env.INPUT_PARALLEL_UPLOADS || "3", 10);

    if (!host || !user || !pass) {
        console.error("❌ INPUT_HOST, INPUT_USERNAME и INPUT_PASSWORD обязательны");
        process.exit(1);
    }

    if (!["ftp", "ftps", "sftp", "ftps/ftp"].includes(connectionTypeInput)) {
        console.error("❌ INPUT_CONNECTION_TYPE должен быть одним из: ftp, ftps, sftp, ftps/ftp");
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

    if (!["true", "false"].includes(secureRejectUnauthorizedInput)) {
        console.error("❌ INPUT_SECURE_REJECT_UNAUTHORIZED должен быть true или false");
        process.exit(1);
    }

    /** @param {number} ms */
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /** @typedef {"ftp" | "ftps" | "sftp"} ResolvedProtocol */

    /**
     * @typedef {{
     *   kind: "ftp",
     *   secureEnabled: boolean,
     *   client: ftp.Client
     * } | {
     *   kind: "sftp",
     *   client: SftpClient
     * }} ConnectionClient
     */

    /**
     * Сетевые обрывы (ECONNRESET, EPIPE и т.д.) оставляют клиент basic-ftp в несогласованном
     * состоянии — без переподключения повторная попытка почти всегда бесполезна.
     * @param {unknown} err
     */
    function isRecoverableConnectionError(err) {
        if (err instanceof Error) {
            const e = /** @type {NodeJS.ErrnoException} */ (err);
            const code = e.code;
            if (
                code === "ECONNRESET" ||
                code === "EPIPE" ||
                code === "ETIMEDOUT" ||
                code === "ECONNABORTED" ||
                code === "ENOTCONN" ||
                code === "EHOSTUNREACH" ||
                code === "ENETUNREACH"
            ) {
                return true;
            }
            const msg = err.message;
            if (
                msg.includes("ECONNRESET") ||
                msg.includes("EPIPE") ||
                msg.includes("ETIMEDOUT") ||
                msg.includes("Client is closed") ||
                msg.includes("No response from server") ||
                msg.includes("Not connected") ||
                msg.includes("Connection lost") ||
                msg.includes("Connection ended")
            ) {
                return true;
            }
        }
        if (err && typeof err === "object" && "cause" in err) {
            return isRecoverableConnectionError(/** @type {{ cause: unknown }} */ (err).cause);
        }
        return false;
    }

    /**
     * @param {boolean} secureEnabled
     * @returns {ConnectionClient}
     */
    function createFtpClient(secureEnabled) {
        const client = new ftp.Client();
        client.ftp.verbose = false;
        return {
            kind: /** @type {"ftp"} */ ("ftp"),
            secureEnabled,
            client
        };
    }

    /** @returns {ConnectionClient} */
    function createSftpClient() {
        return {
            kind: /** @type {"sftp"} */ ("sftp"),
            client: new SftpClient()
        };
    }

    /**
     * @param {SftpClient} client
     * @param {string} remotePath
     */
    async function ensureSftpDir(client, remotePath) {
        const exists = await client.exists(remotePath);
        if (!exists) {
            await client.mkdir(remotePath, true);
        }
    }

    /** @param {ConnectionClient} connection */
    async function connect(connection) {
        if (connection.kind === "ftp") {
            await connection.client.access({
                host,
                user,
                password: pass,
                secure: connection.secureEnabled,
                secureOptions: connection.secureEnabled
                    ? { rejectUnauthorized: secureRejectUnauthorized }
                    : undefined
            });
            await connection.client.ensureDir(remoteDir);
            return;
        }

        await connection.client.connect({
            host,
            username: user,
            password: pass
        });
        await ensureSftpDir(connection.client, remoteDir);
    }

    /** @param {ConnectionClient} connection */
    async function closeClient(connection) {
        try {
            if (connection.kind === "ftp") {
                connection.client.close();
            } else {
                await connection.client.end();
            }
        } catch {
            // ignore close errors
        }
    }

    /** @param {ConnectionClient} connection */
    async function reconnect(connection) {
        await closeClient(connection);
        await connect(connection);
    }

    /**
     * @param {ResolvedProtocol} resolvedProtocol
     * @returns {ConnectionClient}
     */
    function createConnectionForProtocol(resolvedProtocol) {
        if (resolvedProtocol === "sftp") {
            return createSftpClient();
        }
        if (resolvedProtocol === "ftps") {
            return createFtpClient(true);
        }
        return createFtpClient(false);
    }

    /**
     * @param {ConnectionClient} connection
     * @param {string} localFile
     * @param {string} remoteFile
     * @param {number} workerId
     * @returns {Promise<boolean>}
     */
    async function uploadWithRetry(connection, localFile, remoteFile, workerId) {
        let lastError;

        for (let attempt = 0; attempt <= retryCount; attempt++) {
            if (attempt > 0) {
                console.log(`🔁 [W${workerId}] Повторная попытка ${attempt}/${retryCount}: ${localFile}`);
                if (retryDelayMs > 0) {
                    await sleep(retryDelayMs);
                }
            }

            try {
                const remoteParent = path.posix.dirname(remoteFile);
                if (connection.kind === "ftp") {
                    await connection.client.ensureDir(remoteParent);
                } else {
                    await ensureSftpDir(connection.client, remoteParent);
                }

                console.log(`⬆️ [W${workerId}] Загружаем файл: ${localFile} → ${remoteFile}`);
                if (connection.kind === "ftp") {
                    await connection.client.uploadFrom(localFile, remoteFile);
                } else {
                    await connection.client.fastPut(localFile, remoteFile);
                }
                console.log(`✅ [W${workerId}] Загружен: ${path.basename(localFile)}`);
                return true;
            } catch (err) {
                lastError = err;
                const message = err instanceof Error ? err.message : String(err);
                const shouldReconnect = isRecoverableConnectionError(err);

                console.error(`❌ [W${workerId}] Ошибка загрузки ${path.basename(localFile)} (попытка ${attempt + 1}/${retryCount + 1}): ${message}`);

                if (attempt < retryCount && shouldReconnect) {
                    try {
                        console.log(`🔌 [W${workerId}] Восстанавливаем соединение...`);
                        await reconnect(connection);
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

    /** @param {number} bytes */
    function formatBytes(bytes) {
        if (bytes < 1024) {
            return `${bytes} B`;
        }
        const units = ["KB", "MB", "GB", "TB"];
        let value = bytes / 1024;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex += 1;
        }
        return `${value.toFixed(2)} ${units[unitIndex]}`;
    }

    /** @param {number} seconds */
    function formatDuration(seconds) {
        if (!Number.isFinite(seconds) || seconds <= 0) {
            return "0s";
        }
        const total = Math.round(seconds);
        const mins = Math.floor(total / 60);
        const secs = total % 60;
        if (mins === 0) {
            return `${secs}s`;
        }
        return `${mins}m ${secs}s`;
    }

    /**
     * @param {string} rootPath
     * @returns {Array<{local: string, remote: string, size: number}>}
     */
    function collectFiles(rootPath) {
        /** @type {Array<{local: string, remote: string, size: number}>} */
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
                    const size = fs.statSync(localEntryPath).size;
                    files.push({ local: localEntryPath, remote: remoteEntryPath, size });
                }
            }
        }

        walk(rootPath);
        return files;
    }

    /**
     * @returns {Promise<ResolvedProtocol>}
     */
    async function resolveProtocol() {
        if (connectionTypeInput === "ftp" || connectionTypeInput === "ftps" || connectionTypeInput === "sftp") {
            return connectionTypeInput;
        }

        console.log("ℹ️ Режим ftps/ftp: сначала пробуем FTPS, при ошибке переключаемся на FTP");

        const ftpsProbe = createConnectionForProtocol("ftps");
        try {
            await connect(ftpsProbe);
            console.log("✅ FTPS доступен, используем FTPS");
            return "ftps";
        } catch (ftpsErr) {
            const message = ftpsErr instanceof Error ? ftpsErr.message : String(ftpsErr);
            console.log(`⚠️ FTPS недоступен: ${message}`);
            console.log("↩️ Переключаемся на FTP");
            return "ftp";
        } finally {
            await closeClient(ftpsProbe);
        }
    }

    console.log("🔹 Подключение к серверу...");

    try {
        const resolvedProtocol = await resolveProtocol();
        const checkClient = createConnectionForProtocol(resolvedProtocol);
        await connect(checkClient);
        await closeClient(checkClient);

        console.log("✅ Успешное подключение");
        console.log(`🔌 Протокол: ${resolvedProtocol.toUpperCase()}`);
        console.log(`📂 Целевая директория на сервере: ${remoteDir}`);
        if (resolvedProtocol === "ftps") {
            console.log(`🔐 Проверка TLS сертификата: ${secureRejectUnauthorized ? "включена" : "отключена"}`);
        }
        if (resolvedProtocol !== "ftps" && secure) {
            console.log("ℹ️ INPUT_SECURE игнорируется, так как выбран connection_type");
        }
        console.log(`🚀 Параллельных загрузок: ${parallelUploads}`);

        /** @type {string[]} */
        const failedUploads = [];
        let uploadedCount = 0;
        let uploadedBytes = 0;
        const startedAt = Date.now();

        const filesToUpload = collectFiles(localDir);
        const totalFiles = filesToUpload.length;
        const totalBytes = filesToUpload.reduce((sum, file) => sum + file.size, 0);

        function logProgress() {
            const elapsedSec = Math.max((Date.now() - startedAt) / 1000, 0.001);
            const bytesPerSec = uploadedBytes / elapsedSec;
            const remainingBytes = Math.max(totalBytes - uploadedBytes, 0);
            const etaSec = bytesPerSec > 0 ? remainingBytes / bytesPerSec : 0;
            const progressPercent = totalFiles > 0
                ? ((uploadedCount + failedUploads.length) / totalFiles) * 100
                : 100;

            console.log(
                `📊 Прогресс: ${uploadedCount + failedUploads.length}/${totalFiles} (${progressPercent.toFixed(1)}%) | ` +
                `Файлов загружено: ${uploadedCount} | ` +
                `Объем: ${formatBytes(uploadedBytes)}/${formatBytes(totalBytes)} | ` +
                `Скорость: ${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s | ` +
                `ETA: ${formatDuration(etaSec)}`
            );
        }

        if (filesToUpload.length === 0) {
            console.log("ℹ️ Нет файлов для загрузки");
        }

        let nextIndex = 0;

        /** @param {number} workerId */
        async function worker(workerId) {
            const workerClient = createConnectionForProtocol(resolvedProtocol);
            await connect(workerClient);

            try {
                while (nextIndex < filesToUpload.length) {
                    const currentIndex = nextIndex;
                    nextIndex += 1;
                    const file = filesToUpload[currentIndex];
                    if (!file) {
                        continue;
                    }

                    const uploaded = await uploadWithRetry(
                        workerClient,
                        file.local,
                        file.remote,
                        workerId
                    );
                    if (uploaded) {
                        uploadedCount += 1;
                        uploadedBytes += file.size;
                    } else {
                        failedUploads.push(file.local);
                    }
                    logProgress();
                }
            } finally {
                await closeClient(workerClient);
            }
        }

        const workers = [];
        const workerCount = Math.min(parallelUploads, filesToUpload.length || parallelUploads);
        for (let workerId = 1; workerId <= workerCount; workerId++) {
            workers.push(worker(workerId));
        }

        await Promise.all(workers);

        logProgress();

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
        console.error("❌ Ошибка подключения:", err);
        process.exit(1);
    } finally {
        console.log("🔹 Отключение от сервера");
    }
}

main();