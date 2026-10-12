# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim

WORKDIR /app

# Install OpenSSL for Prisma
RUN apt-get update \
    && apt-get install -y openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./

COPY prisma ./prisma

RUN npm ci --no-audit --no-fund

RUN npx prisma generate

COPY . .

RUN npm run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
