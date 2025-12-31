FROM node:18-slim

# Instala dependências do Chrome
RUN apt-get update \
    && apt-get install -y wget gnupg ca-certificates \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Configura variáveis do Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Cria diretório da aplicação
WORKDIR /app

# Copia package.json e instala dependências
COPY package.json ./
RUN npm install --omit=dev

# Copia o código da aplicação
COPY . .

# Expõe a porta
EXPOSE 10000

# Comando para iniciar
CMD ["node", "index.js"]
