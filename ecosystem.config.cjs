module.exports = {
  apps: [{
    name: 'crududai',
    script: './app.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    env_production: {
      NODE_ENV: 'production', SERVER_PROTOCOL: 'http',
      HOST: '127.0.0.1', PORT: 3600, TRUST_PROXY: 'loopback',
    },
  }],
};
