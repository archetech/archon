# Use the official Node.js as the base image
FROM node:22.15.0-bullseye-slim

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json to the working directory
COPY package*.json .

# Copy the client build to the client directory
COPY client/package*.json ./client/
COPY client/public ./client/public/
COPY client/src ./client/src/
COPY client/index.html ./client/
COPY client/vite.config.ts ./client/

# Copy the server build to the server directory
COPY server/package*.json ./server/
COPY server/src ./server/src/
COPY server/tsconfig.json ./server/

# Install dependencies
RUN npm ci

# Run...
CMD ["npm", "start"]
