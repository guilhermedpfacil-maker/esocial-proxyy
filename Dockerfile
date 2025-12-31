FROM ghcr.io/puppeteer/puppeteer:21.6.0

WORKDIR /app

# Instalar libnss3-tools para pk12util e certutil
USER root
RUN apt-get update && apt-get install -y libnss3-tools && rm -rf /var/lib/apt/lists/*
USER pptruser

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

CMD ["node", "index.js"]
