FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci
COPY --chown=node:node . .
USER node
EXPOSE 4000
CMD ["node", "src/server.js"]

