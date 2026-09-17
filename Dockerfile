FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000

# Single-process deployment: Next.js + WebSocket hub on one port.
CMD ["npm", "run", "start"]
