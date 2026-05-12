require('dotenv').config();
const { Client, GatewayIntentBits, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const sharp = require('sharp');
const https = require('https');
const http = require('http');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

const WATCHED_CHANNEL_ID = process.env.WATCHED_CHANNEL_ID;

const SIZES = [
  { label: '400 · X PFP', value: 400, id: 'size_400' },
  { label: '512',         value: 512, id: 'size_512' },
  { label: '800',         value: 800, id: 'size_800' },
  { label: '1024',        value: 1024, id: 'size_1024' },
];

function buildButtons(activeSize) {
  const row = new ActionRowBuilder();
  SIZES.forEach(s => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(s.id)
        .setLabel(s.label)
        .setStyle(s.value === activeSize ? ButtonStyle.Primary : ButtonStyle.Secondary)
    );
  });
  return row;
}

async function scaleImage(url, size) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', async () => {
        try {
          const buf = await sharp(Buffer.concat(chunks))
            .resize(size, size, { kernel: sharp.kernel.nearest, fit: 'fill' })
            .png()
            .toBuffer();
          resolve(buf);
        } catch (err) {
          reject(err);
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

client.on('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`👀 Watching channel: ${WATCHED_CHANNEL_ID}`);
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (message.channelId !== WATCHED_CHANNEL_ID) return;

  const image = message.attachments.find(a =>
    a.contentType && a.contentType.startsWith('image/')
  );
  if (!image) return;

  try {
    const buf = await scaleImage(image.url, 400);
    const attachment = new AttachmentBuilder(buf, { name: 'scaled_400x400_xpfp.png' });
    const row = buildButtons(400);

    const reply = await message.reply({
      content: '**400×400** — ready for X PFP',
      files: [attachment],
      components: [row],
    });

    // Store original image URL on the reply for button interactions
    reply._sourceUrl = image.url;

    // Collect button interactions for 5 minutes
    const collector = reply.createMessageComponentCollector({ time: 5 * 60 * 1000 });

    collector.on('collect', async interaction => {
      const sizeObj = SIZES.find(s => s.id === interaction.customId);
      if (!sizeObj) return;

      await interaction.deferUpdate();

      try {
        const newBuf = await scaleImage(image.url, sizeObj.value);
        const newAttachment = new AttachmentBuilder(newBuf, {
          name: `scaled_${sizeObj.value}x${sizeObj.value}.png`
        });
        const newRow = buildButtons(sizeObj.value);

        await interaction.editReply({
          content: `**${sizeObj.value}×${sizeObj.value}**${sizeObj.value === 400 ? ' — ready for X PFP' : ''}`,
          files: [newAttachment],
          components: [newRow],
        });
      } catch (err) {
        console.error('Scale error:', err);
        await interaction.followUp({ content: '❌ Failed to scale image.', ephemeral: true });
      }
    });

    collector.on('end', async () => {
      // Disable buttons after timeout
      const disabledRow = new ActionRowBuilder();
      SIZES.forEach(s => {
        disabledRow.addComponents(
          new ButtonBuilder()
            .setCustomId(s.id)
            .setLabel(s.label)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
        );
      });
      try {
        await reply.edit({ components: [disabledRow] });
      } catch (_) {}
    });

  } catch (err) {
    console.error('Bot error:', err);
    await message.reply('❌ Could not process that image. Make sure it\'s a valid PNG or JPG.');
  }
});

client.login(process.env.BOT_TOKEN);
