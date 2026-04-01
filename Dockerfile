# Используем минимальный Node.js 20 образ
FROM node:20-alpine

# Устанавливаем рабочую директорию
WORKDIR /action

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm install --production

# Копируем весь экшен
COPY . .

# Устанавливаем переменные окружения для продакшена
ENV NODE_ENV=production

# ENTRYPOINT запускает index.js
ENTRYPOINT ["node", "/action/index.js"]