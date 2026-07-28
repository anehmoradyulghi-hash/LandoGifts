module.exports = {
  apps: [{
    name: "landogifts-backend",
    script: "./src/server.js",
    env: {
      NODE_ENV: "production",
      PORT: 3000
    }
  }]
};
