const {
    SlashCommandBuilder,
    MessageFlags,
} = require("discord.js");

/*
|--------------------------------------------------------------------------
| /resolve command
|--------------------------------------------------------------------------
|
| Converts Discord mentions into usernames.
|
| Example input:
|
| 🥇 <@1242132608572323418>
| 🥈 <@1204982342306734105>
|
| Output:
|
| johndoe12
| rohan3677
|
|--------------------------------------------------------------------------
}


/*
|--------------------------------------------------------------------------
| Command definition
|--------------------------------------------------------------------------
*/

const resolveCommand = new SlashCommandBuilder()
    .setName("resolve")
    .setDescription("Resolve Discord mentions into usernames")
    .addStringOption(option =>
        option
            .setName("text")
            .setDescription("Text containing Discord user mentions")
            .setRequired(true)
    );


/*
|--------------------------------------------------------------------------
| Handle /resolve
|--------------------------------------------------------------------------
*/
async function handleResolve(interaction) {

    const text =
        interaction.options.getString("text", true);

    /*
     * Scan the ENTIRE text for Discord mentions.
     *
     * Supports:
     *
     * <@123456789>
     * <@!123456789>
     *
     * It doesn't matter where the mention appears:
     *
     * "hello <@123> test <@456>"
     * "🥇 <@123>\n🥈 <@456>"
     * "abc <@123> xyz <@456> blah"
     */

    const mentions =
        [...text.matchAll(/<@!?(\d+)>/g)];


    /*
     * No mentions found
     */

    if (mentions.length === 0) {

        await interaction.reply({
            content:
                "❌ No Discord user mentions found.",
            flags: MessageFlags.Ephemeral,
        });

        return;
    }


    /*
     * Resolve every mention found in the text.
     */

    const resolvedUsers = [];

    for (const match of mentions) {

        const userId =
            match[1];

        try {

            const user =
                await interaction.client.users.fetch(
                    userId
                );

            resolvedUsers.push(
                user.username
            );

        } catch (error) {

            console.error(
                `Failed to resolve Discord user ${userId}:`,
                error
            );

            resolvedUsers.push(
                `Unknown User (${userId})`
            );
        }
    }


    /*
     * Return all usernames.
     */

    await interaction.reply({
        content:
            resolvedUsers.join("\n"),
        flags: MessageFlags.Ephemeral,
    });
}

/*
|--------------------------------------------------------------------------
| Exports
|--------------------------------------------------------------------------
*/

module.exports = {
    resolveCommand,
    handleResolve,
};