# Use an official Node.js runtime as a parent image
FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Copy package files first (for caching npm install step)
COPY package*.json ./

# Install dependencies
RUN npm install

# Now copy the rest of the code (including ceo.js)
COPY . .

# Expose the port your app listens on (default 3000)
EXPOSE 3000

# Define the command to run your app
CMD ["node", "ceo.js"]
