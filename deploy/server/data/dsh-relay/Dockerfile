FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV RELAY_DATA_PORT=3200 RELAY_CONTROL_PORT=3201
EXPOSE 3200 3201
CMD ["node", "src/relay.mjs"]
