require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { Kazagumo } = require("kazagumo");
const { Connectors } = require("shoukaku");

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const kazagumo = new Kazagumo(
  { defaultSearchEngine: "youtube" },
  new Connectors.DiscordJS(client),
  [
    {
      name: "local",
      url: `${process.env.LAVALINK_HOST}:${process.env.LAVALINK_PORT}`,
      auth: process.env.LAVALINK_PASSWORD,
    },
  ]
);

kazagumo.shoukaku.on("ready", (name) => console.log(`[Lavalink] Nodo listo: ${name}`));
kazagumo.shoukaku.on("error", (name, error) => console.error(`[Lavalink] Error en nodo ${name}:`, error));
kazagumo.shoukaku.on("disconnect", (name, reason) => console.log(`[Lavalink] Disconnect nodo ${name}:`, reason));
kazagumo.shoukaku.on("reconnecting", (name) => console.log(`[Lavalink] Reconnecting nodo ${name}...`));

client.once("ready", () => console.log(`Bot conectado como ${client.user.tag}`));

// ----------------- helper: esperar player -----------------
async function waitForPlayer(guildId, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const player = kazagumo.players.get(guildId);
    if (player) return player;
    await new Promise((res) => setTimeout(res, 100));
  }
  return null;
}

// ------------------- Estado por servidor -------------------
const musicState = new Map();
function getState(guildId) {
  if (!musicState.has(guildId)) {
    musicState.set(guildId, {
      current: null,
      queue: [],
      isAdvancing: false,

      ignoreEndUntil: 0,
      lastSkipAt: 0,
      stopped: false,
    });
  }
  return musicState.get(guildId);
}

// ------------------- FIFO: reproducir siguiente -------------------
async function playNext(guildId, forceReplace = false) {
  const state = getState(guildId);
  const player = kazagumo.players.get(guildId);
  if (!player) return;

  if (state.stopped) return;
  if (state.isAdvancing) return;

  state.isAdvancing = true;
  try {
    const next = state.queue.shift();
    if (!next) {
      state.current = null;
      return;
    }

    state.current = next;

    if (forceReplace) {
      await player.play(next, { replaceCurrent: true });
    } else {
      await player.play(next);
    }
  } catch (e) {
    console.error("playNext error:", e);
    state.current = null;
    if (!state.stopped && state.queue.length) {
      await playNext(guildId, forceReplace);
    }
  } finally {
    state.isAdvancing = false;
  }
}

// ------------------- Auto-next al terminar -------------------
kazagumo.on("playerEnd", async (player) => {
  const guildId = player.guildId;
  const state = getState(guildId);

  if (state.stopped) return;
  if (Date.now() < state.ignoreEndUntil) return;

  await playNext(guildId, false);
});

// ------------------- /queue render (cola propia) -------------------
function renderQueue(guildId) {
  const st = getState(guildId);

  let text = "";
  if (st.current) text += `🎶 Ahora:\n**${st.current.title}**\n`;
  else text += `🎶 Ahora:\n*(nada reproduciéndose)*\n`;

  if (!st.queue.length) text += "\n📭 No hay más canciones en cola.";
  else {
    text += "\n📜 En cola:\n";
    text += st.queue.slice(0, 10).map((t, i) => `${i + 1}. ${t.title}`).join("\n");
  }
  return text;
}

// ------------------- Commands -------------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guildId) return;

  try {
    await interaction.deferReply();

    const guildId = interaction.guildId;
    const member = interaction.member;
    const voiceId = member?.voice?.channel?.id;

    const state = getState(guildId);

    // ---------- /play ----------
    if (interaction.commandName === "play") {
      if (!voiceId) return interaction.editReply("Entrá a un canal de voz primero.");
      state.stopped = false;

      const query = interaction.options.getString("query", true);

      let player = kazagumo.players.get(guildId);
      if (!player) {
        kazagumo.createPlayer({
          guildId,
          voiceId,
          textId: interaction.channelId,
          deaf: true,
        });

        player = await waitForPlayer(guildId);
        if (!player) return interaction.editReply("No se pudo inicializar el reproductor de audio.");
      } else {
        if (player.textId !== interaction.channelId) player.textId = interaction.channelId;
        if (player.voiceId && player.voiceId !== voiceId && typeof player.setVoiceChannel === "function") {
          player.setVoiceChannel(voiceId);
        }
      }

      const result = await kazagumo.search(query, { requester: interaction.user });
      if (!result?.tracks?.length) return interaction.editReply("No encontré resultados para esa búsqueda.");

      const track = result.tracks[0];

      state.queue.push(track);

      const idle = !state.current && !player.playing && !player.paused;
      if (idle) {
        await playNext(guildId, false);
        return interaction.editReply(`🎵 Reproduciendo: **${track.title}**`);
      }

      return interaction.editReply(`➕ Agregado a la cola: **${track.title}**`);
    }

    // ---------- /queue ----------
    if (interaction.commandName === "queue") {
      return interaction.editReply(renderQueue(guildId));
    }

    const player = kazagumo.players.get(guildId);
    if (!player) return interaction.editReply("No hay reproducción activa en este servidor.");

    // ---------- /skip ----------
    if (interaction.commandName === "skip") {
      const now = Date.now();
      if (now - state.lastSkipAt < 1200) {
        return interaction.editReply("Esperá un segundo: el salto anterior todavía se está procesando.");
      }
      state.lastSkipAt = now;

      if (state.stopped) return interaction.editReply("El reproductor está detenido. Usá /play para iniciar.");
      if (!player.playing && !state.current) return interaction.editReply("No hay nada reproduciéndose.");

      state.ignoreEndUntil = Date.now() + 2500;

      try {
        if (player.shoukaku?.stopTrack) {
          await player.shoukaku.stopTrack();
        } else if (player.stop) {
          player.stop();
        }
      } catch (e) {
        console.error("Error al cortar track en skip:", e);
      }

      await playNext(guildId, true);

      const nowTitle = state.current?.title;
      if (nowTitle) return interaction.editReply(`⏭️ Saltado. Ahora: **${nowTitle}**`);
      return interaction.editReply("⏭️ Saltado. No hay más canciones en cola.");
    }

    // ---------- /stop ----------
    if (interaction.commandName === "stop") {
      state.stopped = true;
      state.ignoreEndUntil = Date.now() + 10_000;

      state.queue = [];
      state.current = null;
      state.isAdvancing = false;
      state.lastSkipAt = 0;

      try {
        if (player.shoukaku?.stopTrack) {
          await player.shoukaku.stopTrack();
        } else if (player.stop) {
          player.stop();
        }
      } catch {}

      try { player.destroy(); } catch {}

      return interaction.editReply("⏹️ Detenido y cola limpia.");
    }
  } catch (err) {
    console.error("ERROR comando:", err);
    const msg = err?.message || String(err);
    return interaction.editReply(`Ocurrió un error: \`${msg.slice(0, 180)}\``);
  }
});

client.login(process.env.TOKEN);
