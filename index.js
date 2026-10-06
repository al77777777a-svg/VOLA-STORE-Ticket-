'use strict';
const path = require('node:path');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { Store, validateConfig } = require('./core');
const { createHandlers } = require('./bot');

function main() {
  if (!process.env.DISCORD_TOKEN?.trim()) throw new Error('Set DISCORD_TOKEN for the separate VOLA ticket bot. See README-AR.md.');
  if (process.env.GUILD_ID && !/^\d{17,20}$/.test(process.env.GUILD_ID)) throw new Error('GUILD_ID must be a Discord server ID, or blank.');
  const config = validateConfig(require('./config.json'));
  const store = new Store(process.env.DATA_DIR || path.join(__dirname, 'data'));
  if (process.env.GUILD_ID && store.state.guildId && process.env.GUILD_ID !== store.state.guildId) throw new Error('GUILD_ID conflicts with the saved server. Use the correct data volume.');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    allowedMentions: { parse: [], repliedUser: false }
  });
  const handlers = createHandlers(client, store, config, process.env.GUILD_ID || '');
  client.on(Events.MessageCreate, handlers.message);
  client.on(Events.InteractionCreate, handlers.interaction);
  client.once(Events.ClientReady, () => {
    console.log(`${config.brand} Ticket online; setup=${config.prefix} setup @Support; data=${store.dir}`);
    if (process.env.RAILWAY_ENVIRONMENT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH) console.warn('Attach a Railway volume to retain tickets across deploys.');
  });
  client.on(Events.Error, error => console.error('Discord error code:', error.code || error.name));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { client.destroy(); process.exit(0); });
  return client.login(process.env.DISCORD_TOKEN.trim()).catch(error => {
    console.error('Login failed:', error.code || error.name, 'Check the token and Message Content Intent.');
    client.destroy(); process.exitCode = 1;
  });
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
