module.exports = {
  apps: [{
    name: 'crududai-telegram',
    cwd: __dirname,
    script: '-m',
    args: 'telegram_bot.bot',
    interpreter: process.env.TELEGRAM_PYTHON || './.venv-telegram/bin/python',
    instances: 1,
    exec_mode: 'fork',
    kill_timeout: 10000,
    restart_delay: 3000,
  }],
};
