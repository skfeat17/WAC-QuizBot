require("dotenv").config();

const {
    REST,
    Routes,
    SlashCommandBuilder,
} = require("discord.js");
const {
    resolveCommand,
} = require("./src/services/resolve");

const {
    countUsernamesCommand,
} = require("./src/services/countUsernames");
const {
    treasureCooldownCommand,
} = require("./src/services/treasureCooldownAdmin.js");
const {
    dailyeventCooldownCommand,
} = require("./src/services/dailyEventCooldownAdmin");
const commands = [

    // ==========================================
    // NORMAL QUIZ
    // ==========================================

    new SlashCommandBuilder()
        .setName("quiz")
        .setDescription("Start a World Adventure Club quiz")

        .addStringOption(option =>
            option
                .setName("region")
                .setDescription("Choose a region")
                .setRequired(true)
                .addChoices(
                    { name: "World", value: "world" },
                    { name: "South Asia", value: "south_asia" },
                    { name: "East Asia", value: "east_asia" },
                    { name: "Southeast Asia", value: "southeast_asia" },
                    { name: "Europe", value: "europe" },
                    { name: "North America", value: "north_america" },
                    { name: "South America", value: "south_america" },
                    { name: "Africa", value: "africa" },
                    { name: "Oceania", value: "oceania" },
                    { name: "Antarctica", value: "antarctica" }
                )
        )

        .addStringOption(option =>
            option
                .setName("topic")
                .setDescription("Choose a topic")
                .setRequired(true)
                .addChoices(
                    { name: "Mixed", value: "mixed" },
                    { name: "Geography", value: "geography" },
                    { name: "Food", value: "food" },
                    { name: "History", value: "history" },
                    { name: "Culture", value: "culture" },
                    { name: "Language", value: "language" },
                    { name: "Nature", value: "nature" },
                    { name: "Landmarks", value: "landmarks" }
                )
        )

        .addStringOption(option =>
            option
                .setName("difficulty")
                .setDescription("Choose difficulty")
                .setRequired(true)
                .addChoices(
                    { name: "Mixed", value: "mixed" },
                    { name: "Easy", value: "easy" },
                    { name: "Medium", value: "medium" },
                    { name: "Hard", value: "hard" }
                )
        ).addBooleanOption(option =>
            option
                .setName("reset")
                .setDescription("Reset question numbering to 1")
                .setRequired(false)
        )

        .toJSON(),

    // ==========================================
    // DAILY QUIZ
    // ==========================================

    new SlashCommandBuilder()
        .setName("dailyevent")
        .setDescription("Start the World Adventure Club Daily Event")

        .addStringOption(option =>
            option
                .setName("type")
                .setDescription("Choose the Daily Quiz type")
                .setRequired(true)
                .addChoices(
                    { name: "Capital", value: "capital" },
                    { name: "Famous Food", value: "food" },
                    { name: "Famous Monument", value: "monument" },
                    { name: "President", value: "president" },
                    { name: "Independence Day", value: "independence" },
                )
        )

        .toJSON(),

    // ==========================================
    // KILL COMMANDS
    // ==========================================

    new SlashCommandBuilder()
        .setName("kill")
        .setDescription("Daily Quiz control commands")

        .addSubcommand(subcommand =>
            subcommand
                .setName("dailyevent")
                .setDescription(
                    "Force terminate the active Daily Event"
                )
        )

        .addSubcommand(subcommand =>
            subcommand
                .setName("history")
                .setDescription(
                    "Clear all Daily Quiz participation history"
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("treasure")
                .setDescription("Clear all Treasure Chest cooldown history")
        )

        .toJSON(),
    resolveCommand.toJSON(),
    countUsernamesCommand.toJSON(),

    new SlashCommandBuilder()
        .setName("treasure")
        .setDescription("Discover a treasure chest washed ashore!")
        .toJSON(),
    treasureCooldownCommand.toJSON(),
    dailyeventCooldownCommand.toJSON(),

    new SlashCommandBuilder()
    .setName("testdm")
    .setDescription("Test sending a DM")
    .addUserOption(option =>
        option
            .setName("user")
            .setDescription("User to DM")
            .setRequired(true)
    )
];

// ==========================================
// REGISTER COMMANDS GLOBALLY
// ==========================================

const rest = new REST({
    version: "10",
}).setToken(process.env.DISCORD_TOKEN);

(async () => {

    try {

        console.log(
            `🔄 Registering ${commands.length} global slash commands...`
        );

        await rest.put(
            Routes.applicationCommands(
                process.env.CLIENT_ID
            ),
            {
                body: commands,
            }
        );

        console.log(
            "✅ Global slash commands registered successfully!"
        );

    } catch (error) {

        console.error(
            "❌ Failed to register commands:",
            error
        );
    }

})();