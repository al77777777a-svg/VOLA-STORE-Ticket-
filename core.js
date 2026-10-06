'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PermissionFlagsBits: P, ChannelType } = require('discord.js');

class UserError extends Error {}
const fail = message => { throw new UserError(message); };
const idFrom = text => /^\d{17,20}$/.test(text || '') ? text : (text || '').match(/^<[@#]&?(\d{17,20})>$/)?.[1];
const channelName = text => String(text).toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'ticket';
const isAdmin = member => Boolean(member?.permissions?.has(P.Administrator));
const isStaff = (member, settings) => isAdmin(member) || settings.supportRoles.some(id => member?.roles?.cache?.has(id));
const allowedGuild = (state, envId, guildId) => (!envId || guildId === envId) && (!state.guildId || guildId === state.guildId);
const privateOverwrites = (guildId, botId, supportRoles, ownerId) => [
  { id: guildId, deny: [P.ViewChannel] },
  { id: botId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles, P.ManageChannels, P.ManageRoles] },
  ...supportRoles.map(id => ({ id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks] })),
  ...(ownerId ? [{ id: ownerId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks], deny: [P.CreatePublicThreads, P.CreatePrivateThreads] }] : [])
];

class Store {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, 'state.json');
    fs.mkdirSync(this.dir, { recursive: true });
    this.state = { version: 1, guildId: null, settings: { supportRoles: [] }, tickets: {} };
    if (fs.existsSync(this.file)) {
      try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
      catch { throw new Error('state.json cannot be read. Restore a backup; do not reset ticket data.'); }
      if (this.state.version !== 1 || !this.state.settings || !this.state.tickets || !Array.isArray(this.state.settings.supportRoles)) throw new Error('Unsupported or damaged state.json');
    }
  }
  save() {
    const pending = this.file + '.tmp';
    fs.writeFileSync(pending, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(pending, this.file);
  }
  saveTranscript(id, content) {
    if (!/^\d{17,20}$/.test(id)) throw new Error('Invalid ticket ID');
    const dir = path.join(this.dir, 'transcripts');
    fs.mkdirSync(dir, { recursive: true });
    const filename = path.join(dir, `${id}-${Date.now()}.txt`);
    fs.writeFileSync(filename, content, { mode: 0o600 });
    return filename;
  }
}

class Locks {
  constructor() { this.keys = new Set(); }
  async run(key, action) {
    if (this.keys.has(key)) fail('طلبك قيد التنفيذ، انتظر لحظة.');
    this.keys.add(key);
    try { return await action(); } finally { this.keys.delete(key); }
  }
}

async function existingTicket(store, guild, botId, ownerId) {
  const channels = await guild.channels.fetch(); // Fetch failure must not allow duplicates.
  let changed = false;
  for (const ticket of Object.values(store.state.tickets)) {
    if (ticket.guildId !== guild.id || ticket.ownerId !== ownerId || ticket.status !== 'open') continue;
    if (channels.has(ticket.channelId)) return ticket.channelId;
    ticket.status = 'missing'; changed = true;
  }
  const recovered = channels.find(c => c?.type === ChannelType.GuildText && !store.state.tickets[c.id] && c.topic === `vola-ticket:${botId}:${ownerId}:open`);
  if (recovered) {
    store.state.tickets[recovered.id] = { channelId: recovered.id, guildId: guild.id, ownerId, status: 'open', type: 'recovered', createdAt: new Date().toISOString(), claimedBy: null };
    changed = true;
  }
  if (changed) store.save();
  return recovered?.id;
}

function validateConfig(config) {
  if (!config.prefix || /\s/.test(config.prefix)) throw new Error('prefix must not contain spaces');
  if (!/^#[a-f0-9]{6}$/i.test(config.color)) throw new Error('Invalid brand color');
  if (!Array.isArray(config.types) || config.types.length < 1 || config.types.length > 5) throw new Error('Use 1-5 ticket types');
  const ids = new Set();
  for (const type of config.types) {
    if (!/^[a-z0-9_-]{1,24}$/.test(type.id) || ids.has(type.id) || !type.label || type.label.length > 80) throw new Error('Invalid or duplicate ticket type');
    ids.add(type.id);
  }
  for (const key of ['panelImage', 'insideImage']) {
    if (config[key] && !/^https:\/\//i.test(config[key])) throw new Error(`${key} must use HTTPS`);
  }
  if (!config.panelText || config.panelText.length > 3500 || !config.welcomeText || config.welcomeText.length > 3000) throw new Error('Invalid message length');
  return config;
}

module.exports = { Store, Locks, UserError, fail, idFrom, channelName, isAdmin, isStaff, allowedGuild, privateOverwrites, existingTicket, validateConfig };
