'use strict';
const { saveArchive } = require('./archive');
const fs = require('node:fs');
const path = require('node:path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, ChannelType,
  PermissionFlagsBits: P, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const { Locks, UserError, fail, idFrom, channelName, isAdmin, isStaff, allowedGuild, privateOverwrites, existingTicket } = require('./core');function createHandlers(client, store, config, envGuild = '', transcriptBaseUrl = '') {
  let archiveBase = '';
  if (transcriptBaseUrl) { const url = new URL(transcriptBaseUrl); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('TRANSCRIPT_BASE_URL must be a clean HTTPS URL.'); archiveBase = url.toString().replace(/\/+$/, ''); }
  const archiveUrl = token => archiveBase ? archiveBase + '/tickets/' + token : '';
  const locks = new Locks();
  const state = store.state;
  const settings = state.settings;
  const prefix = config.prefix;
  const color = () => settings.color || config.color;
  const embed = title => new EmbedBuilder().setTitle(title).setColor(color()).setFooter({ text: `${config.brand} • عند شرائك لأي منتج من المنتجات فإنك توافق على الشروط والأحكام.` });
  const btn = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(`vola:${id}`).setLabel(label).setStyle(style);
  const controls = closed => new ActionRowBuilder().addComponents(...(closed
    ? [btn('reopen', 'إعادة فتح', ButtonStyle.Primary), btn('export', 'نسخة المحادثة')]
    : [btn('claim', 'استلام التذكرة', ButtonStyle.Primary), btn('rename', 'تغيير الاسم'), btn('notify', 'تنبيه العميل'), btn('export', 'نسخة المحادثة'), btn('close', 'إغلاق', ButtonStyle.Danger)]));
  const serverOK = guildId => allowedGuild(state, envGuild, guildId);
  const checkServer = guildId => { if (!serverOK(guildId)) fail('هذا البوت مربوط بسيرفر VOLA آخر.'); };
  const requireSetup = () => { if (!state.guildId || !settings.categoryId || !settings.logChannelId) fail(`أكمل الإعداد أولًا: ${prefix} setup @رتبة_الدعم`); };
  const getMember = (guild, id) => guild.members.fetch({ user: id, force: true });
  const getChannel = async (guild, id) => guild.channels.fetch(id).catch(error => { if (error.code === 10003) return null; throw error; });
  const requireStaff = member => { if (!isStaff(member, settings)) fail('هذا الإجراء لفريق الدعم فقط.'); };
  const record = interaction => {
    const ticket = state.tickets[interaction.channelId];
    if (!ticket || ticket.guildId !== interaction.guildId || ticket.status === 'missing') fail('هذا الروم ليس تذكرة مسجلة لدى بوت VOLA.');
    return ticket;
  };
  const ticketName = (number, closed) => `${closed ? '🔒' : '📘'}・${number}`;
  const setTicketName = (channel, ticket, closed) => { if (ticket.number) channel.setName(ticketName(ticket.number, closed)).catch(() => console.warn('Ticket rename skipped (Discord rate limit).')); };
  const topic = (ownerId, status) => `vola-ticket:${client.user.id}:${ownerId}:${status}`;
  function withArt(payload, imageUrl, file = 'separator.png') {
    if (imageUrl) payload.embeds[0].setImage(imageUrl);
    else {
      const asset = path.join(__dirname, file);
      if (fs.existsSync(asset)) {
        payload.files = [new AttachmentBuilder(asset, { name: 'vola-separator.png' })];
        payload.embeds[0].setImage('attachment://vola-separator.png');
      }
    }
    return payload;
  }
  const panel = () => withArt({
    embeds: [embed(config.panelTitle)],
    components: [new ActionRowBuilder().addComponents(config.types.map(t => btn(`open:${t.id}`, t.label, ButtonStyle.Primary).setEmoji(t.emoji)))],
    allowedMentions: { parse: [] }
  }, settings.panelImage || config.panelImage, 'panel.png');

  async function log(guild, text, components = []) {
    if (!settings.logChannelId) return;
    try {
      const room = await guild.channels.fetch(settings.logChannelId);
      if (room?.type !== ChannelType.GuildText || room.permissionsFor(guild.roles.everyone)?.has(P.ViewChannel)) throw new Error('Unsafe log channel');
      await room.send({ embeds: [embed('سجل التذاكر').setDescription(text.slice(0, 3900)).setTimestamp()], components, allowedMentions: { parse: [] } });
    } catch { console.warn('Ticket audit could not be delivered. Check the private log channel.'); }
  }

  async function setup(message, args) {
    return locks.run('setup', async () => {
      checkServer(message.guild.id);
      const roleId = idFrom(args[0]);
      const role = roleId && await message.guild.roles.fetch(roleId);
      if (!role || role.id === message.guild.id || role.managed) fail(`اكتب ${prefix} setup @رتبة_الدعم مع رتبة حقيقية، وليس @everyone أو رتبة بوت.`);
      if (Object.values(state.tickets).some(t => t.status !== 'missing') && settings.supportRoles.length && !settings.supportRoles.includes(roleId)) fail('لا يمكن تغيير رتبة الدعم من setup بعد فتح التذاكر. استخدم نفس الرتبة حتى تبقى خصوصية التذاكر محفوظة.');
      const me = await message.guild.members.fetchMe();
      if (!me.permissions.has(P.ManageChannels) || !me.permissions.has(P.ManageRoles)) fail('البوت يحتاج Manage Channels وManage Roles لإدارة رومات التذاكر وصلاحياتها.');
      for (const permission of [P.ManageChannels, P.ManageRoles, P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory]) {
        if (!message.channel.permissionsFor(me)?.has(permission)) fail('البوت يحتاج عرض الروم، إدارة القنوات والصلاحيات، إرسال الرسائل، قراءة السجل، الروابط والمرفقات في هذا الروم.');
      }
      // Bind before creating channels so partial setup can be safely resumed.
      state.guildId = message.guild.id;
      settings.supportRoles = [roleId]; store.save();
      const overwrite = privateOverwrites(message.guild.id, client.user.id, settings.supportRoles);
      let category = settings.categoryId && await getChannel(message.guild, settings.categoryId);
      if (category && category.type !== ChannelType.GuildCategory) fail('قسم التذاكر المسجل ليس Category.');
      if (!category) {
        category = await message.guild.channels.create({ name: 'VOLA TICKETS', type: ChannelType.GuildCategory, permissionOverwrites: overwrite });
        settings.categoryId = category.id; store.save();
      }
      let logs = settings.logChannelId && await getChannel(message.guild, settings.logChannelId);
      if (logs && (logs.type !== ChannelType.GuildText || logs.permissionsFor(message.guild.roles.everyone)?.has(P.ViewChannel))) fail('روم السجلات يجب أن يكون نصيًا وخاصًا.');
      if (!logs) {
        logs = await message.guild.channels.create({ name: 'vola-ticket-logs', type: ChannelType.GuildText, parent: category.id, permissionOverwrites: overwrite });
        settings.logChannelId = logs.id; store.save();
      }
      let previous;
      if (settings.panelChannelId === message.channel.id && settings.panelMessageId) previous = await message.channel.messages.fetch(settings.panelMessageId).catch(e => { if (e.code !== 10008) throw e; });
      const sent = previous ? await previous.edit({ ...panel(), attachments: [] }) : await message.channel.send(panel());
      settings.panelChannelId = sent.channel.id; settings.panelMessageId = sent.id; store.save();
      await message.reply(`تم ربط بوت VOLA بهذا السيرفر وحفظ الإعدادات ✅\nقسم التذاكر: <#${category.id}>\nالسجلات الخاصة: <#${logs.id}>\nرتبة الدعم: <@&${roleId}>`);
    });
  }

  async function transcript(channel, ticket) {
    const messages = [];
    let before;
    for (let page = 0; page < 10; page++) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      messages.push(...batch.values());
      if (batch.size < 100) break;
      before = batch.last().id;
    }
    const lines = [config.brand, `Ticket: ${channel.id}`, `Owner: ${ticket.ownerId}`, `Opened: ${ticket.createdAt}`,
      'Snapshot: up to the most recent 1000 messages. Deleted/edited history is not retained.',
      'Attachments are links only; Discord links may expire. This is a private support record.', ''];
    messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const message of messages) {
      lines.push(`[${message.createdAt.toISOString()}] ${message.author?.tag || 'unknown'} (${message.author?.id || ''})`, message.content || '');
      for (const attachment of message.attachments.values()) lines.push(`[Attachment] ${attachment.name}: ${attachment.url}`);
      for (const item of message.embeds) if (item.description) lines.push(`[Embed] ${item.description}`);
      lines.push('');
    }
    return store.saveTranscript(channel.id, lines.join('\n'));
  }

  async function openTicket(interaction, type) {
    requireSetup();
    return locks.run(`owner:${interaction.user.id}`, async () => {
      const found = await existingTicket(store, interaction.guild, client.user.id, interaction.user.id);
      if (found) return interaction.editReply(`عندك تذكرة مفتوحة بالفعل: <#${found}>`);
      const number = (state.ticketCounter || 0) + 1;
      const category = await interaction.guild.channels.fetch(settings.categoryId);
      if (category?.type !== ChannelType.GuildCategory) fail('قسم التذاكر غير متاح. اطلب من الإدارة إعادة setup.');
      const channel = await interaction.guild.channels.create({
        name: ticketName(number, false), type: ChannelType.GuildText,
        parent: category.id, topic: topic(interaction.user.id, 'open'),
        permissionOverwrites: privateOverwrites(interaction.guildId, client.user.id, settings.supportRoles, interaction.user.id)
      });
      state.ticketCounter = number;
      const ticket = { number, channelId: channel.id, ownerId: interaction.user.id, guildId: interaction.guildId, type: type.id, status: 'open', claimedBy: null, createdAt: new Date().toISOString() };
      state.tickets[channel.id] = ticket; store.save();
      const welcome = withArt({
        content: settings.supportRoles.map(roleId => `<@&${roleId}>`).join(' '),
        embeds: [embed(`${config.brand} | ${type.label}`)],
        components: [controls(false)], allowedMentions: { parse: [], roles: settings.supportRoles }
      }, settings.insideImage || config.insideImage, 'welcome.png');
      const sent = await channel.send(welcome);
      ticket.controlsMessageId = sent.id; store.save();
      await interaction.editReply(`تم فتح تذكرتك: <#${channel.id}>`);
      await log(interaction.guild, `فتح تذكرة <#${channel.id}>\nالعميل: <@${ticket.ownerId}>\nالنوع: ${type.label}`);
    });
  }

  async function updateControls(channel, ticket) {
    let message;
    if (ticket.controlsMessageId) message = await channel.messages.fetch(ticket.controlsMessageId).catch(e => { if (e.code !== 10008) throw e; });
    if (message) await message.edit({ components: [controls(ticket.status === 'closed')] });
    else { const sent = await channel.send({ content: 'إدارة التذكرة', components: [controls(ticket.status === 'closed')] }); ticket.controlsMessageId = sent.id; store.save(); }
  }

  async function onInteraction(i) {
    if (!i.guild || !i.customId?.startsWith('vola:')) return;
    try {
      checkServer(i.guildId); requireSetup();
      const parts = i.customId.split(':'); const action = parts[1];
      if (action === 'open' && i.isButton()) {
        const type = config.types.find(t => t.id === parts[2]);
        if (!type) fail('نوع التذكرة غير متاح.');
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        return await openTicket(i, type);
      }
      if (action === 'submit' && i.isModalSubmit()) {
        const type = config.types.find(t => t.id === parts[2]);
        if (!type) fail('نوع التذكرة غير متاح.');
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        return await openTicket(i, type);
      }
      const ticket = record(i);
      const member = await getMember(i.guild, i.user.id); requireStaff(member);
      if (action === 'rename' && i.isButton()) {
        return await i.showModal(new ModalBuilder().setCustomId('vola:rename-submit').setTitle('تغيير اسم التذكرة')
          .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('الاسم الجديد').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(70))));
      }
      if (action === 'close' && i.isButton()) {
        if (ticket.status !== 'open') fail('التذكرة مغلقة بالفعل.');
        return await i.reply({ content: 'إغلاق التذكرة وحفظ نسخة من المحادثة؟ الروم لن يُحذف، ويمكن إعادة فتحه.',
          components: [new ActionRowBuilder().addComponents(btn('close-confirm', 'تأكيد الإغلاق', ButtonStyle.Danger), btn('cancel', 'إلغاء'))], flags: MessageFlags.Ephemeral });
      }
      if (action === 'cancel' && i.isButton()) return await i.update({ content: 'تم الإلغاء.', components: [] });
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await locks.run(`ticket:${i.channelId}`, async () => {
        // Recheck every confirmation/modal; never trust a previously authorized button.
        requireStaff(await getMember(i.guild, i.user.id));
        if (action === 'claim') {
          if (ticket.status !== 'open') fail('التذكرة مغلقة.');
          if (ticket.claimedBy && ticket.claimedBy !== i.user.id) fail(`التذكرة مستلمة من <@${ticket.claimedBy}>.`);
          ticket.claimedBy = i.user.id; store.save();
          await i.channel.send({ content: `استلم التذكرة <@${i.user.id}>.`, allowedMentions: { parse: [] } });
          await i.editReply('تم استلام التذكرة.');
        } else if (action === 'rename-submit' && i.isModalSubmit()) {
          await i.channel.setName(channelName(i.fields.getTextInputValue('name')));
          await i.editReply('تم تغيير الاسم.');
        } else if (action === 'notify') {
          if (ticket.lastNotified && Date.now() - ticket.lastNotified < 300000) fail('انتظر خمس دقائق بين التنبيهات.');
          const user = await client.users.fetch(ticket.ownerId);
          try { await user.send(`${config.brand}: عندك رد في تذكرتك https://discord.com/channels/${i.guildId}/${i.channelId}`); }
          catch { fail('خاص العميل مقفل أو تعذّر إرسال التنبيه.'); }
          ticket.lastNotified = Date.now(); store.save(); await i.editReply('تم تنبيه العميل.');
        } else if (action === 'export') {
          const filename = await transcript(i.channel, ticket);
          await i.editReply({ content: 'نسخة خاصة — آخر 1000 رسالة بحد أقصى.', files: [new AttachmentBuilder(filename)] });
        } else if (action === 'close-confirm') {
          if (ticket.status !== 'open') fail('التذكرة مغلقة بالفعل.');
          const filename = await transcript(i.channel, ticket); // Failure must leave the ticket open.
          ticket.closedBy = i.user.id; ticket.closedAt = new Date().toISOString();
          const token = saveArchive(store, ticket, filename);
          await i.channel.permissionOverwrites.edit(ticket.ownerId, { SendMessages: false, AttachFiles: false, AddReactions: false, SendMessagesInThreads: false });
          ticket.status = 'closed'; ticket.transcript = path.basename(filename); ticket.webTranscriptToken = token; store.save();
          await i.channel.setTopic(topic(ticket.ownerId, 'closed'));
          setTicketName(i.channel, ticket, true);
          await updateControls(i.channel, ticket);
          await i.channel.send({ content: 'تم إغلاق التذكرة وحفظ نسخة محلية. التذكرة مؤرشفة ولم تُحذف.' });
          await i.editReply({ content: 'تم الإغلاق وحفظ المحادثة.', files: [new AttachmentBuilder(filename)] });
          await client.users.fetch(ticket.ownerId).then(user => user.send({ content: '**شكراً لك لشرائك من متجر Vola Store\nنتمنى تقيمك ياعسل ** <:emoji:1550600087833673930>\nhttps://discord.com/channels/1447961768776437795/1447978433178239211' })).catch(() => {});
          const url = archiveUrl(token);
          if (url) await log(i.guild, 'رابط أرشيف التذكرة الخاص:', [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('View Ticket').setURL(url))]);
          await log(i.guild, `إغلاق تذكرة <#${i.channelId}>\nالمسؤول: <@${i.user.id}>\nحُفظت نسخة خاصة على التخزين الدائم.`);
        } else if (action === 'reopen') {
          if (ticket.status !== 'closed') fail('التذكرة مفتوحة بالفعل.');
          await locks.run(`owner:${ticket.ownerId}`, async () => {
            const found = await existingTicket(store, i.guild, client.user.id, ticket.ownerId);
            if (found) fail(`العميل عنده تذكرة مفتوحة: <#${found}>`);
            await i.channel.permissionOverwrites.edit(ticket.ownerId, { SendMessages: true, AttachFiles: true, AddReactions: null, SendMessagesInThreads: null });
            ticket.status = 'open'; ticket.closedAt = null; store.save();
            await i.channel.setTopic(topic(ticket.ownerId, 'open'));
            setTicketName(i.channel, ticket, false);
            await updateControls(i.channel, ticket);
            await i.editReply('تمت إعادة فتح التذكرة.');
            await log(i.guild, `إعادة فتح <#${i.channelId}> بواسطة <@${i.user.id}>`);
          });
        } else fail('الإجراء غير متاح.');
      });
    } catch (error) {
      const content = error instanceof UserError ? error.message : 'تعذّر إكمال العملية. تحقق من صلاحيات البوت والسجل، ثم أعد المحاولة. أي تذكرة أُنشئت تبقى محفوظة.';
      if (!(error instanceof UserError)) console.error('Interaction failed:', error.code || error.name);
      if (i.deferred || i.replied) await i.editReply({ content, components: [] }).catch(() => {});
      else await i.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }

  async function onMessage(message) {
    if (!message.guild || message.author.bot || message.webhookId || !message.content.startsWith(prefix)) return;
    if (message.content.length > prefix.length && !/\s/.test(message.content[prefix.length])) return;
    if (!serverOK(message.guild.id)) return;
    try {
      const member = await getMember(message.guild, message.author.id);
      if (!isAdmin(member)) return;
      const [command = 'help', ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
      if (command === 'setup') return await setup(message, args);
      if (command === 'help') return await message.reply({ embeds: [embed('أوامر إدارة VOLA').setDescription(
        `\`${prefix} setup @رتبة_الدعم\` إعداد وربط السيرفر\n\`${prefix} panel\` إرسال لوحة التذاكر هنا\n\`${prefix} text النص\` تعديل نص اللوحة\n\`${prefix} welcome النص\` تعديل رسالة الداخل\n\`${prefix} image رابط_https\` صورة اللوحة\n\`${prefix} inside رابط_https\` صورة الداخل\n\`${prefix} image reset\` الفاصل الافتراضي\n\`${prefix} color #AFC9F5\` تغيير اللون\n\`${prefix} status\` معلومات الإعداد\nبعد تعديل الشكل استخدم panel لإرسال لوحة جديدة.\nأوامر الإعداد للإدارة فقط، وأزرار التذاكر لفريق الدعم.`)] });
      requireSetup();
      if (command === 'panel') {
        const sent = await message.channel.send(panel()); settings.panelMessageId = sent.id; settings.panelChannelId = message.channel.id; store.save();
        return await message.reply('تم إرسال لوحة VOLA.');
      }
      if (command === 'status') return await message.reply(`VOLA STORE Ticket ✅\nالسيرفر: ${state.guildId}\nالقسم: <#${settings.categoryId}>\nالسجلات: <#${settings.logChannelId}>\nالتذاكر المفتوحة: ${Object.values(state.tickets).filter(t => t.status === 'open').length}`);
      const text = args.join(' ');
      if (command === 'text' || command === 'welcome') {
        if (!text || text.length > 3000) fail('اكتب نصًا من 1 إلى 3000 حرف.');
        settings[command === 'text' ? 'panelText' : 'welcomeText'] = text;
      } else if (command === 'image' || command === 'inside') {
        if (text !== 'reset') {
          let url; try { url = new URL(text); } catch { fail('استخدم رابط صورة HTTPS دائمًا.'); }
          if (url.protocol !== 'https:' || url.username || url.password) fail('استخدم رابط صورة HTTPS بدون بيانات تسجيل دخول.');
        }
        settings[command === 'image' ? 'panelImage' : 'insideImage'] = text === 'reset' ? '' : text;
      } else if (command === 'color') {
        if (!/^#[a-f0-9]{6}$/i.test(text)) fail('مثال اللون: #AFC9F5');
        settings.color = text;
      } else fail(`أمر غير معروف. اكتب ${prefix} help`);
      store.save(); await message.reply('تم حفظ التعديل. استخدم أمر panel لإرسال اللوحة المحدّثة.');
    } catch (error) {
      if (!(error instanceof UserError)) console.error('Command failed:', error.code || error.name);
      await message.reply(error instanceof UserError ? error.message : 'تعذّر تنفيذ الأمر. تحقق من صلاحيات البوت والتخزين، ثم أعد المحاولة.').catch(() => {});
    }
  }
  return { message: onMessage, interaction: onInteraction, panel, controls, transcript };
}
module.exports = { createHandlers };
