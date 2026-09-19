require("dotenv").config();

const {
    REST,
    Routes,
    SlashCommandBuilder,
} = require("discord.js");

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
        )

        .toJSON(),

    // ==========================================
    // DAILY QUIZ
    // ==========================================

    new SlashCommandBuilder()
        .setName("dailyquiz")
        .setDescription("Start the World Adventure Club Daily Quiz")

        .addStringOption(option =>
            option
                .setName("type")
                .setDescription("Choose the Daily Quiz type")
                .setRequired(true)
                .addChoices(
                    {
                        name: "Currency",
                        value: "currency",
                    },
                    {
                        name: "Capital",
                        value: "capital",
                    },
                    {
                        name: "Food",
                        value: "food",
                    },
                    {
                        name: "Unscramble",
                        value: "unscramble",
                    }
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
                .setName("dailyquiz")
                .setDescription(
                    "Force terminate the active Daily Quiz"
                )
        )

        .addSubcommand(subcommand =>
            subcommand
                .setName("history")
                .setDescription(
                    "Clear all Daily Quiz participation history"
                )
        )

        .toJSON(),
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