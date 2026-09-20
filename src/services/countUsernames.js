const {
    SlashCommandBuilder,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
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
                .setName("showlist")
                .setDescription("Show the username count list")
                .setRequired(false)
        ).addBooleanOption(option =>
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
        )



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

    const showList =
        interaction.options.getBoolean("showlist") ?? false;


    // ==========================================
    // VALIDATE INPUT
    // ==========================================

    if (!text || !text.trim()) {

        await interaction.reply({
            content:
                "❌ Please provide some usernames.",
            flags:
                MessageFlags.Ephemeral,
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
            content:
                "❌ No usernames found.",
            flags:
                MessageFlags.Ephemeral,
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
            .sort((a, b) => {

                if (b.count !== a.count) {
                    return b.count - a.count;
                }

                return a.username
                    .localeCompare(
                        b.username,
                        undefined,
                        {
                            sensitivity: "base",
                        }
                    );
            });


    // ==========================================
    // BUILD USERNAME LIST
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
    // BASE RESULT
    // ALWAYS SHOW TOTAL + UNIQUE
    // ==========================================

    let content =
        `📊 **Username Count**\n\n` +
        `👥 **${usernames.length}** total entries\n` +
        `🔢 **${results.length}** unique usernames\n`;


    // ==========================================
    // ONLY SHOW LIST WHEN REQUESTED
    // ==========================================

    if (!showList) {

        await interaction.reply({
            content,
        });

        return;
    }


    // ==========================================
    // BUILD COMPLETE LIST
    // ==========================================

    const fullList =
        output.join("\n");


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

            if (current) {
                chunks.push(current);
            }

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
    // COPY BUTTON
    // ==========================================

    const copyButton =
        new ButtonBuilder()
            .setCustomId("countusernames_copy")
            .setLabel("Copy List")
            .setEmoji("📋")
            .setStyle(ButtonStyle.Secondary);


    const buttonRow =
        new ActionRowBuilder()
            .addComponents(copyButton);


    // ==========================================
    // SEND FIRST RESULT
    // ==========================================

    await interaction.reply({

        content:
            content +
            `\n` +
            "```text\n" +
            chunks[0] +
            "\n```",

        components: [
            buttonRow,
        ],
    });


    // ==========================================
    // SEND ADDITIONAL CHUNKS
    // ==========================================

    for (let i = 1; i < chunks.length; i++) {

        await interaction.followUp({

            content:
                "```text\n" +
                chunks[i] +
                "\n```",

            // Don't add another copy button
            components: [],
        });
    }


    // ==========================================
    // STORE LIST FOR COPY BUTTON
    // ==========================================

    interaction.client.countUsernameLists ??=
        new Map();

    interaction.client.countUsernameLists.set(
        interaction.id,
        {
            list: fullList,
            userId: interaction.user.id,
            createdAt: Date.now(),
        }
    );


    // ==========================================
    // CLEANUP AFTER 10 MINUTES
    // ==========================================

    setTimeout(() => {

        interaction.client.countUsernameLists.delete(
            interaction.id
        );

    }, 10 * 60 * 1000);
}


// ==========================================
// COPY BUTTON HANDLER
// ==========================================

async function handleCountUsernamesCopy(
    interaction
) {

    if (
        interaction.customId !==
        "countusernames_copy"
    ) {
        return;
    }


    // ==========================================
    // FIND STORED LIST
    // ==========================================

    const lists =
        interaction.client.countUsernameLists;

    if (!lists) {

        await interaction.reply({
            content:
                "❌ This username list is no longer available.",
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }


    // ==========================================
    // FIND LIST BELONGING TO USER
    // ==========================================

    let savedList = null;

    for (const data of lists.values()) {

        if (
            data.userId ===
            interaction.user.id
        ) {

            savedList = data;
            break;
        }
    }


    if (!savedList) {

        await interaction.reply({
            content:
                "❌ This username list is no longer available.",
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }


    // ==========================================
    // RETURN COPYABLE LIST
    // ==========================================

    const chunks = [];

    let current = "";

    const lines =
        savedList.list.split("\n");

    for (const line of lines) {

        if (
            current.length +
            line.length +
            1 > 1900
        ) {

            if (current) {
                chunks.push(current);
            }

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


    await interaction.reply({
        content:
            "```text\n" +
            chunks[0] +
            "\n```",
        flags:
            MessageFlags.Ephemeral,
    });


    for (let i = 1; i < chunks.length; i++) {

        await interaction.followUp({
            content:
                "```text\n" +
                chunks[i] +
                "\n```",
            flags:
                MessageFlags.Ephemeral,
        });
    }
}


// ==========================================
// EXPORTS
// ==========================================

module.exports = {
    countUsernamesCommand,
    handleCountUsernames,
    handleCountUsernamesCopy,
};