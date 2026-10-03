const { SlashCommandBuilder } = require("discord.js");

const kahootCommand = new SlashCommandBuilder()
    .setName("kahoot")
    .setDescription("Manage WAC Kahoot games");

module.exports = {
    kahootCommand,
};
