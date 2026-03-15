require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Reproducir una canción o búsqueda")
    .addStringOption(opt =>
      opt.setName("query")
        .setDescription("Link o nombre (ej: despacito)")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Saltar la canción actual"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Detener reproducción y limpiar cola"),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Mostrar la cola actual"),
].map(c => c.toJSON());

async function main() {
  const { TOKEN, CLIENT_ID, GUILD_ID } = process.env;

  if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
    throw new Error("Faltan TOKEN, CLIENT_ID o GUILD_ID en el .env");
  }

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  console.log("Registrando slash commands (GUILD)...");
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
  console.log("Listo. Comandos registrados.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});