module.exports = {
  apps: [{
    // Same name as TELEGRAM_BOT_PM2_NAME: starting this file under another name would run a second
    // copy of the bot with the same token, and Telegram answers both with "Conflict".
    name: 'crududai-bot',
    cwd: __dirname,
    script: process.env.TELEGRAM_PYTHON || './.venv-telegram/bin/python',
    // -u writes each log line immediately instead of buffering it.
    args: '-u -m telegram_bot.bot',
    interpreter: 'none',
    instances: 1,
    exec_mode: 'fork',
    kill_timeout: 10000,
    restart_delay: 3000,
    // Every log line starts with the server date and time (UTC on the VPS).
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }],
};
