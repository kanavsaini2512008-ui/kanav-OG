const mineflayer = require('mineflayer');
const config = require('./config.json');

// Reconnect settings (all optional in config.json, in milliseconds)
const RECONNECT_DELAY     = config.reconnectDelay    ?? 5000;   // first retry delay
const MAX_RECONNECT_DELAY = config.maxReconnectDelay ?? 60000;  // backoff cap

const STEP_INTERVAL = 1500;
const JUMP_DURATION = 500;

let bot = null;
let reconnectTimer = null;
let currentDelay = RECONNECT_DELAY;
let shuttingDown = false;

function createBot() {
  console.log(`🔌 Connecting to ${config.serverHost}:${config.serverPort} as ${config.botUsername}...`);

  const instance = mineflayer.createBot({
    host: config.serverHost,
    port: config.serverPort,
    username: config.botUsername,
    auth: 'offline',
    version: false,
    viewDistance: config.botChunk
  });
  bot = instance;

  // Timers belong to this bot session, so they can be cleared on disconnect
  let movementPhase = 0;
  let movementTimer = null;
  let sneakTimer = null;
  let jumpTimer = null;
  let ended = false;

  function movementCycle() {
    if (ended || !instance.entity) return;

    switch (movementPhase) {
      case 0:
        instance.setControlState('forward', true);
        instance.setControlState('back', false);
        instance.setControlState('jump', false);
        break;
      case 1:
        instance.setControlState('forward', false);
        instance.setControlState('back', true);
        instance.setControlState('jump', false);
        break;
      case 2:
        instance.setControlState('forward', false);
        instance.setControlState('back', false);
        instance.setControlState('jump', true);
        jumpTimer = setTimeout(() => {
          if (!ended) instance.setControlState('jump', false);
        }, JUMP_DURATION);
        break;
      case 3:
        instance.setControlState('forward', false);
        instance.setControlState('back', false);
        instance.setControlState('jump', false);
        break;
    }

    movementPhase = (movementPhase + 1) % 4;
    movementTimer = setTimeout(movementCycle, STEP_INTERVAL);
  }

  instance.on('spawn', () => {
    // Connected successfully: reset the backoff
    currentDelay = RECONNECT_DELAY;

    // 'spawn' also fires after death/respawn, so restart rather than stack loops
    clearTimeout(sneakTimer);
    clearTimeout(movementTimer);

    sneakTimer = setTimeout(() => {
      if (ended) return;
      instance.setControlState('sneak', true);
      console.log(`✅ ${config.botUsername} is Ready!`);
    }, 3000);

    movementTimer = setTimeout(movementCycle, STEP_INTERVAL);
  });

  instance.on('kicked', (reason) => {
    console.log('👢 Kicked from server:', typeof reason === 'string' ? reason : JSON.stringify(reason));
  });

  instance.on('error', (err) => {
    console.error('⚠️ Error:', err.message || err);
  });

  instance.on('end', (reason) => {
    ended = true;
    clearTimeout(movementTimer);
    clearTimeout(sneakTimer);
    clearTimeout(jumpTimer);

    console.log(`⛔️ Bot Disconnected!${reason ? ` (${reason})` : ''}`);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return; // avoid double-scheduling

  const delay = currentDelay;
  console.log(`🔁 Reconnecting in ${Math.round(delay / 1000)}s...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, delay);

  // Exponential backoff, capped
  currentDelay = Math.min(currentDelay * 2, MAX_RECONNECT_DELAY);
}

// Clean exit on Ctrl+C
process.on('SIGINT', () => {
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  console.log('\n👋 Shutting down...');
  if (bot) bot.quit();
  setTimeout(() => process.exit(0), 500);
});

createBot();
