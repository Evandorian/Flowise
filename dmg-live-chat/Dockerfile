FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production \
    DATA_DIR=/var/lib/data
# No VOLUME line: it can create a throwaway volume over the data folder that hides the
# persistent disk Sevalla mounts there, wiping the database on every restart.
EXPOSE 3000
CMD ["node", "server.js"]
