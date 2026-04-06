# Dockerfile for GSM Transport app (Node + Chromium)
FROM node:20-slim

# Install dependencies for Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libnss3 \
    libxss1 \
    lsb-release \
    wget \
    gnupg \
    chromium \
  && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium

# App directory
WORKDIR /usr/src/app

# Copy package files first for better caching
COPY package.json package-lock.json* ./

# Install deps
RUN npm ci --omit=dev

# Copy source
COPY . ./

# Expose port
ENV PORT=3002
EXPOSE 3002

# Start
CMD ["node", "server.js"]
