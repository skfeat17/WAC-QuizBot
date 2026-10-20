// deploy-commands.js
require("dotenv").config();
const { banCommand } = require("./src/services/quizBan");
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

const commands = [

    // ==========================================
    // PING
    // ==========================================

    new SlashCommandBuilder()
        .setName("ping")
        .setDescription("Check the bot's response time")
        .toJSON(),


    // ==========================================
    // NORMAL QUIZ
    // ==========================================

    new SlashCommandBuilder()
        .setName("quiz")
        .setDescription(
            "Start a World Adventure Club quiz"
        )

        .addStringOption(option =>
            option
                .setName("region")
                .setDescription(
                    "Choose a region"
                )
                .setRequired(true)
                .addChoices(
                    {
                        name: "World",
                        value: "world",
                    },
                    {
                        name: "South Asia",
                        value: "south_asia",
                    },
                    {
                        name: "East Asia",
                        value: "east_asia",
                    },
                    {
                        name: "Southeast Asia",
                        value: "southeast_asia",
                    },
                    {
                        name: "Europe",
                        value: "europe",
                    },
                    {
                        name: "North America",
                        value: "north_america",
                    },
                    {
                        name: "South America",
                        value: "south_america",
                    },
                    {
                        name: "Africa",
                        value: "africa",
                    },
                    {
                        name: "Oceania",
                        value: "oceania",
                    },
                    {
                        name: "Antarctica",
                        value: "antarctica",
                    }
                )
        )

        .addStringOption(option =>
            option
                .setName("topic")
                .setDescription(
                    "Choose a topic"
                )
                .setRequired(true)
                .addChoices(
                    {
                        name: "Mixed",
                        value: "mixed",
                    },
                    {
                        name: "Geography",
                        value: "geography",
                    },
                    {
                        name: "Food",
                        value: "food",
                    },
                    {
                        name: "History",
                        value: "history",
                    },
                    {
                        name: "Culture",
                        value: "culture",
                    },
                    {
                        name: "Language",
                        value: "language",
                    },
                    {
                        name: "Nature",
                        value: "nature",
                    },
                    {
                        name: "Landmarks",
                        value: "landmarks",
                    }
                )
        )

        .addStringOption(option =>
            option
                .setName("difficulty")
                .setDescription(
                    "Choose difficulty"
                )
                .setRequired(true)
                .addChoices(
                    {
                        name: "Mixed",
                        value: "mixed",
                    },
                    {
                        name: "Easy",
                        value: "easy",
                    },
                    {
                        name: "Medium",
                        value: "medium",
                    },
                    {
                        name: "Hard",
                        value: "hard",
                    }
                )
        )

        .addBooleanOption(option =>
            option
                .setName("reset")
                .setDescription(
                    "Reset question numbering to 1"
                )
                .setRequired(false)
        )

        .toJSON(),

    // ==========================================
    // MYSTERY EVENT
    // ==========================================

    new SlashCommandBuilder()
        .setName("mysteryevent")
        .setDescription(
            "Manage the 24/7 World Mystery Event"
        )

        // /mysteryevent start
        .addSubcommand(subcommand =>
            subcommand
                .setName("start")
                .setDescription(
                    "Start the 24/7 World Mystery Event"
                )
        )

        // /mysteryevent kill
        .addSubcommand(subcommand =>
            subcommand
                .setName("kill")
                .setDescription(
                    "Deactivate the active Mystery Event"
                )
        )

        // /mysteryevent cooldown list
        .addSubcommandGroup(group =>
            group
                .setName("cooldown")
                .setDescription(
                    "Manage Mystery Event cooldowns"
                )

                .addSubcommand(subcommand =>
                    subcommand
                        .setName("list")
                        .setDescription(
                            "List all active Mystery cooldowns"
                        )
                )

                // /mysteryevent cooldown set
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("set")
                        .setDescription(
                            "Set a user's Mystery cooldown"
                        )
                        .addUserOption(option =>
                            option
                                .setName("user")
                                .setDescription(
                                    "User to set"
                                )
                                .setRequired(true)
                        )
                        .addNumberOption(option =>
                            option
                                .setName("hours")
                                .setDescription(
                                    "Cooldown duration in hours"
                                )
                                .setRequired(true)
                                .setMinValue(0)
                        )
                )

                // /mysteryevent cooldown check
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("check")
                        .setDescription(
                            "Check a user's Mystery cooldown"
                        )
                        .addUserOption(option =>
                            option
                                .setName("user")
                                .setDescription(
                                    "User to check"
                                )
                                .setRequired(true)
                        )
                )

                // /mysteryevent cooldown clear
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("clear")
                        .setDescription(
                            "Clear a user's Mystery cooldown"
                        )
                        .addUserOption(option =>
                            option
                                .setName("user")
                                .setDescription(
                                    "User to clear"
                                )
                                .setRequired(false)
                        )
                        .addBooleanOption(option =>
                            option
                                .setName("all")
                                .setDescription(
                                    "Clear all Mystery cooldowns"
                                )
                                .setRequired(false)
                        )
                )
        )

        .toJSON(),

    // ==========================================
    // OTHER COMMANDS
    // ==========================================

    resolveCommand.toJSON(),

    countUsernamesCommand.toJSON(),

    // ==========================================
    // STATS
    // ==========================================

    new SlashCommandBuilder()
        .setName("stats")
        .setDescription(
            "View World Adventure Club participation statistics"
        )
        .addStringOption(option =>
            option
                .setName("event")
                .setDescription("Choose which event statistics to view")
                .setRequired(true)
                .addChoices(
                    {
                        name: "Mystery Event",
                        value: "mystery",
                    }
                )
        )
        .toJSON(),
    // ==========================================
    // KAHOOT
    // ==========================================

    new SlashCommandBuilder()
        .setName("kahoot")
        .setDescription(
            "Manage World Adventure Club Kahoot quizzes"
        )
        .toJSON(),
];
commands.push(banCommand.toJSON());
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