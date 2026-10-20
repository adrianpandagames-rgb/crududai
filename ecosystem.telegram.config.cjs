module.exports = {
  apps: [{
    name: 'crududai-telegram',
    cwd: __dirname,
    script: process.env.TELEGRAM_PYTHON || './.venv-telegram/bin/python',
    args: '-m telegram_bot.bot',
    interpreter: 'none',
    instances: 1,
    exec_mode: 'fork',
    kill_timeout: 10000,
    restart_delay: 3000,
  }],
};
