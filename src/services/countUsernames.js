const {
    SlashCommandBuilder,
    MessageFlags,
} = require("discord.js");

// ==========================================
// COMMAND
// ==========================================

const countUsernamesCommand =
    new SlashCommandBuilder()
        .setName("countusernames")
        .setDescription("Count how many times each username appears")
        .addStringOption(option =>
            option
                .setName("text")
                .setDescription("Paste the raw usernames here")
                .setRequired(true)
        )
        .addBooleanOption(option =>
            option
                .setName("at")
                .setDescription("Add @ before every username")
                .setRequired(false)
        )
        .addNumberOption(option =>
            option
                .setName("multiplier")
                .setDescription("Multiply each count by this number")
                .setRequired(false)
                .setMinValue(0)
        );


// ==========================================
// HANDLER
// ==========================================

async function handleCountUsernames(interaction) {

    const text =
        interaction.options.getString("text");

    const addAt =
        interaction.options.getBoolean("at") ?? false;

    const multiplier =
        interaction.options.getNumber("multiplier") ?? 1;

    if (!text || !text.trim()) {

        await interaction.reply({
            content: "❌ Please provide some usernames.",
            flags: MessageFlags.Ephemeral,
        });

        return;
    }

    // ==========================================
    // SPLIT RAW TEXT
    // ==========================================

    const usernames = text
        .split(/\r?\n/)
        .map(username => username.trim())
        .filter(Boolean);

    if (usernames.length === 0) {

        await interaction.reply({
            content: "❌ No usernames found.",
            flags: MessageFlags.Ephemeral,
        });

        return;
    }

    // ==========================================
    // COUNT USERNAMES
    // ==========================================

    const users = new Map();

    for (const username of usernames) {

        const normalized =
            username.toLowerCase();

        if (!users.has(normalized)) {
            users.set(normalized, {
                username,
                count: 0,
            });
        }

        users.get(normalized).count++;
    }

    // ==========================================
    // SORT
    // ==========================================

    const results =
        [...users.values()]
            .sort((a, b) => b.count - a.count);

    // ==========================================
    // BUILD OUTPUT
    // ==========================================

    const output = results.map(user => {

        const value =
            user.count * multiplier;

        const displayName =
            addAt
                ? `@${user.username}`
                : user.username;

        return `${displayName} - ${value}`;
    });

    // ==========================================
    // DISCORD MESSAGE LIMIT
    // ==========================================

    const chunks = [];

    let current = "";

    for (const line of output) {

        if (
            current.length +
            line.length +
            1 > 1900
        ) {
            chunks.push(current);
            current = "";
        }

        current +=
            current
                ? `\n${line}`
                : line;
    }

    if (current) {
        chunks.push(current);
    }

    // ==========================================
    // SEND RESULT
    // ==========================================

    await interaction.reply({
        content:
            `📊 **Username Count**\n` +
            `👥 **${usernames.length}** total entries\n` +
            `🔢 **${results.length}** unique usernames\n` +
            `✖️ **Multiplier:** ${multiplier}\n\n` +
            "```text\n" +
            chunks[0] +
            "\n```",
    });

    // Additional chunks if needed
    for (let i = 1; i < chunks.length; i++) {

        await interaction.followUp({
            content:
                "```text\n" +
                chunks[i] +
                "\n```",
        });
    }
}


// ==========================================
// EXPORTS
// ==========================================

module.exports = {
    countUsernamesCommand,
    handleCountUsernames,
};